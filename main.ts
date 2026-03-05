import {
	CachedMetadata,
	HeadingCache,
	parseFrontMatterAliases,
	Plugin,
	prepareSimpleSearch,
	TFile,
} from "obsidian";
import { getAPI, LocalRestApiPublicApi } from "obsidian-local-rest-api";

// The upstream npm package types are outdated; augment with methods that exist at runtime
declare module "obsidian-local-rest-api" {
	interface LocalRestApiPublicApi {
		unregister(): void;
	}
}
import {
	applyPatch,
	ContentType,
	PatchFailed,
	PatchInstruction,
	PatchOperation,
	PatchTargetType,
} from "markdown-patch";
import mime from "mime-types";
import openapiYaml from "./openapi.yaml";

// --- Types ---

interface HeadingBoundary {
	start: { line: number };
	end?: { line: number };
}

// --- Heading Utils (reimplemented from obsidian-local-rest-api/src/utils.ts) ---

function findHeadingBoundary(
	fileCache: CachedMetadata,
	headingPath: string[]
): HeadingBoundary | null {
	const reversedHeadingPath = [...headingPath].reverse();
	const cursorHeadingPath: HeadingCache[] = [];

	for (const [headingIdx, heading] of (fileCache.headings ?? []).entries()) {
		cursorHeadingPath[heading.level] = heading;
		cursorHeadingPath.splice(heading.level + 1);

		const reversedCurrentCursor = [
			...cursorHeadingPath.map((h) => h.heading),
		].reverse();
		let matchesRequestedHeading = true;
		for (const [idx, element] of reversedHeadingPath.entries()) {
			if (reversedCurrentCursor[idx] != element) {
				matchesRequestedHeading = false;
				break;
			}
		}

		if (matchesRequestedHeading) {
			const start = heading.position.end;
			const endHeading = (fileCache.headings ?? [])
				.slice(headingIdx + 1)
				.find((h) => h.level <= heading.level);
			const end = endHeading?.position.start;
			return { start, end };
		}
	}

	return null;
}

function getSplicePosition(
	fileLines: string[],
	heading: HeadingBoundary,
	insert: boolean,
	ignoreNewLines: boolean
): number {
	let splicePosition =
		insert === false
			? (heading.end?.line ?? fileLines.length)
			: heading.start.line + 1;

	if (!ignoreNewLines || insert) {
		return splicePosition;
	}

	while (fileLines[splicePosition - 1] === "") {
		splicePosition--;
	}
	return splicePosition;
}

// --- Async handler wrapper (Express doesn't catch async rejections) ---

function asyncHandler(
	fn: (req: any, res: any) => Promise<void>
): (req: any, res: any) => void {
	return (req: any, res: any) => {
		fn(req, res).catch((err: Error) => {
			console.error("[Note API Extension]", err);
			if (!res.headersSent) {
				res.status(500).json({
					message: err.message || "Internal server error",
				});
			}
		});
	};
}

// --- Content Types ---

const CONTENT_TYPE_MARKDOWN = "text/markdown";
const CONTENT_TYPE_NOTE_JSON = "application/vnd.olrapi.note+json";

// --- Alias Cache ---

class AliasCache {
	private cache: Map<string, TFile> = new Map();
	private built = false;
	private app: Plugin["app"];

	constructor(app: Plugin["app"]) {
		this.app = app;

		this.app.metadataCache.on("changed", (file: TFile) => {
			if (this.built) this.updateForFile(file);
		});
		this.app.vault.on("delete", (file: unknown) => {
			if (this.built && file instanceof TFile) this.removeFile(file);
		});
		this.app.vault.on("rename", (file: unknown, oldPath: string) => {
			if (this.built && file instanceof TFile) {
				this.removeByPath(oldPath);
				this.updateForFile(file);
			}
		});
		this.app.metadataCache.on("resolved", () => {
			this.build();
		});
	}

	private build(): void {
		this.cache.clear();
		for (const file of this.app.vault.getMarkdownFiles()) {
			this.updateForFile(file);
		}
		this.built = true;
	}

	private updateForFile(file: TFile): void {
		this.removeFile(file);
		const cache = this.app.metadataCache.getFileCache(file);
		const aliases = parseFrontMatterAliases(cache?.frontmatter ?? null);
		if (aliases) {
			for (const alias of aliases) {
				this.cache.set(alias.toLowerCase(), file);
			}
		}
	}

	private removeFile(file: TFile): void {
		this.removeByPath(file.path);
	}

	private removeByPath(path: string): void {
		for (const [key, cachedFile] of this.cache) {
			if (cachedFile.path === path) {
				this.cache.delete(key);
			}
		}
	}

	resolve(name: string): TFile | null {
		if (!this.built) this.build();
		return this.cache.get(name.toLowerCase()) ?? null;
	}

	entries(): IterableIterator<[string, TFile]> {
		if (!this.built) this.build();
		return this.cache.entries();
	}
}

// --- Note Handler ---

class NoteHandler {
	private app: Plugin["app"];
	private aliases: AliasCache;

	constructor(app: Plugin["app"]) {
		this.app = app;
		this.aliases = new AliasCache(app);
	}

	private resolveNote(name: string): TFile | null {
		const direct = this.app.metadataCache.getFirstLinkpathDest(name, "/");
		if (direct) return direct;
		return this.aliases.resolve(name);
	}

	private findSimilarNotes(name: string, limit = 5): string[] {
		const search = prepareSimpleSearch(name);
		if (!search) return [];

		const scored: { name: string; score: number }[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const result = search(file.basename);
			if (result) scored.push({ name: file.basename, score: result.score });
		}
		for (const [alias] of this.aliases.entries()) {
			const result = search(alias);
			if (result) scored.push({ name: alias, score: result.score });
		}

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit).map((s) => s.name);
	}

	private sendNotFound(res: any, name: string): void {
		const suggestions = this.findSimilarNotes(name);
		const body: Record<string, unknown> = {
			message: "No note was found matching the specified wiki-link name.",
			errorCode: 40462,
		};
		if (suggestions.length > 0) body.suggestions = suggestions;
		res.status(404).json(body);
	}

	private extractName(req: any): string {
		return decodeURIComponent(
			req.path.slice(req.path.indexOf("/", 1) + 1)
		);
	}

	/** Build a NoteJson metadata object for a file (same as upstream getFileMetadataObject) */
	private async getFileMetadata(file: TFile): Promise<Record<string, unknown>> {
		const cache = this.app.metadataCache.getFileCache(file);

		const frontmatter = { ...(cache?.frontmatter ?? {}) };
		delete frontmatter.position;

		const directTags = (cache?.tags ?? [])
			.filter((tag: any) => tag)
			.map((tag: any) => tag.tag);
		const frontmatterTags = Array.isArray(frontmatter.tags)
			? frontmatter.tags
			: [];
		const tags: string[] = [...frontmatterTags, ...directTags]
			.filter((tag: any) => tag)
			.map((tag: any) => tag.toString().replace(/^#/, ""))
			.filter((value: string, index: number, self: string[]) => self.indexOf(value) === index);

		return {
			tags,
			frontmatter,
			stat: file.stat,
			path: file.path,
			content: await this.app.vault.cachedRead(file),
		};
	}

	// --- GET /note/* ---
	async handleGet(req: any, res: any): Promise<void> {
		const name = this.extractName(req);
		const file = this.resolveNote(name);
		if (!file) {
			this.sendNotFound(res, name);
			return;
		}

		res.set("Content-Location", encodeURI(file.path));

		// Accept: application/vnd.olrapi.note+json → structured JSON
		if (req.headers.accept === CONTENT_TYPE_NOTE_JSON) {
			const metadata = await this.getFileMetadata(file);
			res.setHeader("Content-Type", CONTENT_TYPE_NOTE_JSON);
			res.send(JSON.stringify(metadata, null, 2));
			return;
		}

		// Default: raw file content
		const content = await this.app.vault.adapter.readBinary(file.path);
		const mimeType = mime.lookup(file.path) || "application/octet-stream";
		res.set({
			"Content-Disposition": `attachment; filename="${encodeURI(file.path).replace(",", "%2C")}"`,
			"Content-Type":
				`${mimeType}` +
				(mimeType === CONTENT_TYPE_MARKDOWN ? "; charset=utf-8" : ""),
		});
		res.send(Buffer.from(content));
	}

	// --- PUT /note/* ---
	async handlePut(req: any, res: any): Promise<void> {
		const name = this.extractName(req);
		const file = this.resolveNote(name);
		if (!file) {
			this.sendNotFound(res, name);
			return;
		}

		res.set("Content-Location", encodeURI(file.path));

		if (typeof req.body === "string") {
			await this.app.vault.adapter.write(file.path, req.body);
		} else if (Buffer.isBuffer(req.body)) {
			const ab = req.body.buffer.slice(
				req.body.byteOffset,
				req.body.byteOffset + req.body.byteLength
			);
			await this.app.vault.adapter.writeBinary(file.path, ab);
		} else {
			res.status(400).json({
				message: "Request body must be text or binary content.",
				errorCode: 40010,
			});
			return;
		}

		res.status(204).send();
	}

	// --- POST /note/* (append) ---
	async handlePost(req: any, res: any): Promise<void> {
		const name = this.extractName(req);
		const file = this.resolveNote(name);
		if (!file) {
			this.sendNotFound(res, name);
			return;
		}

		res.set("Content-Location", encodeURI(file.path));

		if (typeof req.body !== "string") {
			res.status(400).json({
				message: "Request body must be text content.",
				errorCode: 40010,
			});
			return;
		}

		let fileContents = await this.app.vault.read(file);
		if (fileContents && !fileContents.endsWith("\n")) {
			fileContents += "\n";
		}
		fileContents += req.body;

		await this.app.vault.adapter.write(file.path, fileContents);
		res.status(204).send();
	}

	// --- PATCH /note/* ---
	async handlePatch(req: any, res: any): Promise<void> {
		const name = this.extractName(req);
		const file = this.resolveNote(name);
		if (!file) {
			this.sendNotFound(res, name);
			return;
		}

		res.set("Content-Location", encodeURI(file.path));

		// V2 (legacy heading-based) when Heading is present but no Target-Type
		if (req.get("Heading") && !req.get("Target-Type")) {
			return this.patchV2(file, req, res);
		}
		return this.patchV3(file, req, res);
	}

	private async patchV2(file: TFile, req: any, res: any): Promise<void> {
		const headingBoundary = req.get("Heading-Boundary") || "::";
		const heading = (req.get("Heading") || "")
			.split(headingBoundary)
			.filter(Boolean);
		const contentPosition = req.get("Content-Insertion-Position");
		let insert = false;
		let aboveNewLine = false;

		if (contentPosition === undefined) {
			insert = false;
		} else if (contentPosition === "beginning") {
			insert = true;
		} else if (contentPosition === "end") {
			insert = false;
		} else {
			res.status(400).json({
				message: "Invalid Content-Insertion-Position value.",
				errorCode: 40050,
			});
			return;
		}

		if (typeof req.body !== "string") {
			res.status(400).json({
				message: "Request body must be text content.",
				errorCode: 40010,
			});
			return;
		}

		if (typeof req.get("Content-Insertion-Ignore-Newline") === "string") {
			aboveNewLine =
				req.get("Content-Insertion-Ignore-Newline")?.toLowerCase() ===
				"true";
		}

		if (!heading.length) {
			res.status(400).json({
				message: "Missing Heading header.",
				errorCode: 40051,
			});
			return;
		}

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) {
			res.status(500).json({
				message: "Metadata cache not available for this file.",
			});
			return;
		}

		const position = findHeadingBoundary(cache, heading);
		if (!position) {
			res.status(400).json({
				message: "Invalid heading path.",
				errorCode: 40052,
			});
			return;
		}

		const fileContents = await this.app.vault.read(file);
		const fileLines = fileContents.split("\n");
		const splicePosition = getSplicePosition(
			fileLines,
			position,
			insert,
			aboveNewLine
		);
		fileLines.splice(splicePosition, 0, req.body);
		const content = fileLines.join("\n");

		await this.app.vault.adapter.write(file.path, content);

		res.header("Deprecation", 'true; sunset-version="4.0"')
			.header(
				"Link",
				'<https://github.com/coddingtonbear/obsidian-local-rest-api/wiki/Changes-to-PATCH-requests-between-versions-2.0-and-3.0>; rel="alternate"'
			)
			.status(200)
			.send(content);
	}

	private async patchV3(file: TFile, req: any, res: any): Promise<void> {
		const operation = req.get("Operation");
		const targetType = req.get("Target-Type");
		const rawTarget = decodeURIComponent(req.get("Target") ?? "");
		const contentType = req.get("Content-Type");
		const createTargetIfMissing =
			req.get("Create-Target-If-Missing") === "true";
		const applyIfContentPreexists =
			req.get("Apply-If-Content-Preexists") === "true";
		const trimTargetWhitespace =
			req.get("Trim-Target-Whitespace") === "true";
		const targetDelimiter = req.get("Target-Delimiter") || "::";

		const target =
			targetType === "heading"
				? rawTarget.split(targetDelimiter)
				: rawTarget;

		if (!targetType) {
			res.status(400).json({
				message: "Missing Target-Type header.",
				errorCode: 40053,
			});
			return;
		}
		if (!["heading", "block", "frontmatter"].includes(targetType)) {
			res.status(400).json({
				message: "Invalid Target-Type header.",
				errorCode: 40054,
			});
			return;
		}
		if (!operation) {
			res.status(400).json({
				message: "Missing Operation header.",
				errorCode: 40056,
			});
			return;
		}
		if (!["append", "prepend", "replace"].includes(operation)) {
			res.status(400).json({
				message: "Invalid Operation header.",
				errorCode: 40057,
			});
			return;
		}

		const fileContents = await this.app.vault.read(file);

		const instruction: PatchInstruction = {
			operation: operation as PatchOperation,
			targetType: targetType as PatchTargetType,
			target,
			contentType: contentType as ContentType,
			content: req.body,
			applyIfContentPreexists,
			trimTargetWhitespace,
			createTargetIfMissing,
		} as PatchInstruction;

		try {
			const patched = applyPatch(fileContents, instruction);
			await this.app.vault.adapter.write(file.path, patched);
			res.status(200).send(patched);
		} catch (e) {
			if (e instanceof PatchFailed) {
				res.status(400).json({
					message: e.reason,
					errorCode: 40080,
				});
			} else {
				res.status(500).json({
					message: (e as Error).message,
				});
			}
		}
	}

	// --- DELETE /note/* ---
	async handleDelete(req: any, res: any): Promise<void> {
		const name = this.extractName(req);
		const file = this.resolveNote(name);
		if (!file) {
			this.sendNotFound(res, name);
			return;
		}

		res.set("Content-Location", encodeURI(file.path));
		await this.app.vault.adapter.remove(file.path);
		res.status(204).send();
	}

	// --- POST /note-move/ ---
	async handleMove(req: any, res: any): Promise<void> {
		const from = req.body?.from;
		const to = req.body?.to;

		if (!from || !to) {
			res.status(400).json({
				message:
					"Request body must include 'from' (wiki-link name) and 'to' (new vault path) fields.",
				errorCode: 40020,
			});
			return;
		}

		const file = this.resolveNote(from);
		if (!file) {
			this.sendNotFound(res, from);
			return;
		}

		let destPath: string = to;
		if (!destPath.endsWith(".md")) {
			destPath += ".md";
		}

		await this.app.fileManager.renameFile(file, destPath);
		res.status(200).json({ from: file.path, to: destPath });
	}
}

// --- Plugin ---

export default class NoteApiExtensionPlugin extends Plugin {
	private api: LocalRestApiPublicApi;

	registerRoutes() {
		this.api = getAPI(this.app, this.manifest);
		const handler = new NoteHandler(this.app);

		this.api
			.addRoute("/note/*")
			.get(asyncHandler(handler.handleGet.bind(handler)))
			.put(asyncHandler(handler.handlePut.bind(handler)))
			.post(asyncHandler(handler.handlePost.bind(handler)))
			.patch(asyncHandler(handler.handlePatch.bind(handler)))
			.delete(asyncHandler(handler.handleDelete.bind(handler)));

		this.api
			.addRoute("/note-move/")
			.post(asyncHandler(handler.handleMove.bind(handler)));

		this.api
			.addRoute("/note-api.yaml")
			.get((_req: any, res: any) => {
				res.set("Content-Type", "text/yaml; charset=utf-8");
				res.send(openapiYaml);
			});
	}

	async onload() {
		if (this.app.plugins.enabledPlugins.has("obsidian-local-rest-api")) {
			this.registerRoutes();
		}

		this.registerEvent(
			this.app.workspace.on(
				"obsidian-local-rest-api:loaded",
				this.registerRoutes.bind(this)
			)
		);
	}

	onunload() {
		if (this.api) {
			this.api.unregister();
		}
	}
}

declare module "obsidian" {
	interface App {
		plugins: {
			enabledPlugins: Set<string>;
		};
	}
	interface MetadataCache {
		getFirstLinkpathDest(
			linkpath: string,
			sourcePath: string
		): TFile | null;
	}
	interface Workspace {
		on(
			name: "obsidian-local-rest-api:loaded",
			callback: () => void,
			ctx?: any
		): EventRef;
	}
}

import {
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
	getDocumentMap,
	PatchFailed,
	PatchInstruction,
	PatchOperation,
	PatchTargetType,
} from "markdown-patch";
import mime from "mime-types";
import openapiYaml from "./notes-openapi.yaml";

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
const CONTENT_TYPE_DOCUMENT_MAP = "application/vnd.olrapi.document-map+json";

// --- Alias Cache ---

class AliasCache {
	private cache: Map<string, TFile[]> = new Map();
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
				const key = alias.toLowerCase();
				const existing = this.cache.get(key) ?? [];
				existing.push(file);
				this.cache.set(key, existing);
			}
		}
	}

	private removeFile(file: TFile): void {
		this.removeByPath(file.path);
	}

	private removeByPath(path: string): void {
		for (const [key, files] of this.cache) {
			const filtered = files.filter((f) => f.path !== path);
			if (filtered.length === 0) {
				this.cache.delete(key);
			} else {
				this.cache.set(key, filtered);
			}
		}
	}

	resolve(name: string): TFile | null {
		if (!this.built) this.build();
		const files = this.cache.get(name.toLowerCase());
		return files?.[0] ?? null;
	}

	resolveAll(name: string): TFile[] {
		if (!this.built) this.build();
		return this.cache.get(name.toLowerCase()) ?? [];
	}

	entries(): IterableIterator<[string, TFile[]]> {
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

	private findAllMatches(name: string): TFile[] {
		const seen = new Set<string>();
		const matches: TFile[] = [];
		const add = (file: TFile) => {
			if (!seen.has(file.path)) {
				seen.add(file.path);
				matches.push(file);
			}
		};

		const nameLower = name.toLowerCase();
		const suffix = "/" + nameLower;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const pathNoExt = file.path.replace(/\.md$/i, "").toLowerCase();
			if (pathNoExt === nameLower || pathNoExt.endsWith(suffix)) {
				add(file);
			}
		}

		for (const file of this.aliases.resolveAll(name)) {
			add(file);
		}

		return matches;
	}

	private async resolveNoteOrRespond(name: string, req: any, res: any): Promise<TFile | null> {
		const file = this.resolveNote(name);
		if (!file) {
			this.sendNotFound(res, name);
			return null;
		}

		const allMatches = this.findAllMatches(name);
		if (allMatches.length > 1) {
			const targetType = req.get("Target-Type");
			const rawTarget = req.get("Target");

			if (targetType && rawTarget) {
				const target = decodeURIComponent(rawTarget);
				const delimiter = req.get("Target-Delimiter") || "::";
				const resolved = await this.tryAutoResolve(allMatches, targetType, target, delimiter);
				if (resolved) return resolved;
			}

			await this.sendAmbiguous(res, name, allMatches, req);
			return null;
		}

		return file;
	}

	private async tryAutoResolve(
		candidates: TFile[],
		targetType: string,
		target: string,
		delimiter: string
	): Promise<TFile | null> {
		const matching: TFile[] = [];
		for (const file of candidates) {
			try {
				const content = await this.app.vault.read(file);
				const targets = this.findMatchingTargets(content, targetType, target, delimiter);
				if (targets.length > 0) matching.push(file);
			} catch {
				// skip unreadable files
			}
		}
		return matching.length === 1 ? matching[0] : null;
	}

	private generatePreview(content: string): string {
		const map = getDocumentMap(content);
		const headingMap = (map as any).heading ?? {};

		// Priority 1: Use ## Overview or ## Summary heading content
		for (const name of ["Overview", "Summary"]) {
			// Check both standalone and nested keys (e.g. "Overview" or "Title\u001fOverview")
			const entry = headingMap[name] ?? Object.entries(headingMap).find(
				([key]) => key.endsWith("\u001f" + name)
			)?.[1];
			if (entry) {
				const slice = content.slice((entry as any).content.start, (entry as any).content.end).trim();
				return slice.length > 200 ? slice.slice(0, 200) : slice;
			}
		}

		// Priority 2: First content after frontmatter, up to 5 lines / 200 chars
		let body = content;
		const fmMatch = body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
		if (fmMatch) {
			body = body.slice(fmMatch[0].length);
		}

		const lines = body.split("\n").slice(0, 5);
		const joined = lines.join("\n");
		return joined.length > 200 ? joined.slice(0, 200) : joined;
	}

	private findMatchingTargets(
		content: string,
		targetType: string,
		target: string,
		delimiter: string
	): string[] {
		const map = getDocumentMap(content);

		if (targetType === "heading") {
			const key = target.split(delimiter).join("\u001f");
			const entry = this.resolveHeadingEntry((map as any).heading ?? {}, key);
			if (entry) {
				return [target.split(delimiter).join("::")];
			}
			return [];
		}

		if (targetType === "block") {
			const entry = (map as any).block?.[target];
			if (entry) return [target];
			return [];
		}

		return [];
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

	private async sendAmbiguous(res: any, name: string, matches: TFile[], req: any): Promise<void> {
		const targetType = req.get("Target-Type");
		const rawTarget = req.get("Target");
		const delimiter = req.get("Target-Delimiter") || "::";

		const candidates = await Promise.all(
			matches.map(async (f) => {
				let content = "";
				try {
					content = await this.app.vault.read(f);
				} catch {
					// empty preview on read failure
				}

				const candidate: Record<string, unknown> = {
					path: f.path,
					preview: this.generatePreview(content),
				};

				if (targetType && rawTarget) {
					const target = decodeURIComponent(rawTarget);
					candidate.matchingTargets = this.findMatchingTargets(
						content, targetType, target, delimiter
					);
				}

				return candidate;
			})
		);

		res.status(300).json({
			message:
				"Multiple notes match the given name. Use a full vault path to disambiguate.",
			errorCode: 30060,
			candidates,
		});
	}

	private extractName(req: any): string {
		return decodeURIComponent(
			req.path.slice(req.path.indexOf("/", 1) + 1)
		);
	}

	/** Build a NoteJson metadata object for a file (same as upstream getFileMetadataObject) */
	private async getFileMetadata(file: TFile, req?: any): Promise<Record<string, unknown>> {
		const cache = this.app.metadataCache.getFileCache(file);

		const frontmatter = { ...(cache?.frontmatter ?? {}) };
		delete frontmatter.position;

		const directTags = (cache?.tags ?? [])
			.filter((tag: any) => tag)
			.map((tag: any) => tag.tag);
		const frontmatterTags = Array.isArray(frontmatter.tags)
			? frontmatter.tags
			: typeof frontmatter.tags === "string"
				? [frontmatter.tags]
				: [];
		const tags: string[] = [...frontmatterTags, ...directTags]
			.filter((tag: any) => tag)
			.map((tag: any) => tag.toString().replace(/^#/, ""))
			.filter((value: string, index: number, self: string[]) => self.indexOf(value) === index);

		const metadata: Record<string, unknown> = {
			tags,
			frontmatter,
			stat: file.stat,
			path: file.path,
			content: await this.app.vault.cachedRead(file),
		};

		// Add periodic metadata if this is a periodic note request
		if (req && (req as any)._periodicInfo) {
			metadata.periodic = (req as any)._periodicInfo;
		}

		return metadata;
	}

	// --- GET /note/* ---
	async handleGet(req: any, res: any): Promise<void> {
		const name = this.extractName(req);
		const file = await this.resolveNoteOrRespond(name, req, res);
		if (!file) return;

		res.set("Content-Location", encodeURI(file.path));

		const targetType = req.get("Target-Type");

		// Accept: application/vnd.olrapi.document-map+json → structural map
		if (req.headers.accept === CONTENT_TYPE_DOCUMENT_MAP) {
			const content = await this.app.vault.read(file);
			const map = getDocumentMap(content);
			const headingMap = (map as any).heading ?? {};

			const headings: { displayPath: string; level: number }[] = [];
			for (const [key, entry] of Object.entries(headingMap)) {
				if (key === "") continue; // skip root entry
				headings.push({
					displayPath: key.replace(/\u001f/g, "::"),
					level: (entry as any).level,
				});
			}

			const blocks = Object.keys((map as any).block ?? {});

			res.setHeader("Content-Type", CONTENT_TYPE_DOCUMENT_MAP);
			res.send(JSON.stringify({
				path: file.path,
				headings,
				blocks,
				frontmatter: map.frontmatter,
			}, null, 2));
			return;
		}

		// Accept: application/vnd.olrapi.note+json → structured JSON
			if (req.headers.accept === CONTENT_TYPE_NOTE_JSON) {
				const metadata = await this.getFileMetadata(file, req);

			if (targetType) {
				const section = this.extractSection(
					metadata.content as string, targetType, req
				);
				if (section === null) {
					res.status(404).json({
						message: `Target not found in note.`,
						errorCode: 40463,
					});
					return;
				}
				metadata.content = section;
			}

			res.setHeader("Content-Type", CONTENT_TYPE_NOTE_JSON);
			res.send(JSON.stringify(metadata, null, 2));
			return;
		}

		// Read content (text for section extraction, binary otherwise)
		if (targetType) {
			const content = await this.app.vault.read(file);
			const section = this.extractSection(content, targetType, req);
			if (section === null) {
				res.status(404).json({
					message: `Target not found in note.`,
					errorCode: 40463,
				});
				return;
			}
			res.set("Content-Type", CONTENT_TYPE_MARKDOWN + "; charset=utf-8");
			res.send(section);
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

	/** Look up a heading entry by exact key, falling back to leaf-name match. */
	private resolveHeadingEntry(headingMap: Record<string, any>, key: string): any | undefined {
		const exact = headingMap[key];
		if (exact) return exact;

		// Fallback: match by leaf name (last segment after \u001f)
		const suffix = "\u001f" + key;
		for (const [k, v] of Object.entries(headingMap)) {
			if (k.endsWith(suffix)) return v;
		}
		return undefined;
	}

	private extractSection(
		content: string,
		targetType: string,
		req: any
	): string | null {
		if (!["heading", "block"].includes(targetType)) {
			return null;
		}

		const rawTarget = decodeURIComponent(req.get("Target") ?? "");
		if (!rawTarget) return null;

		const targetDelimiter = req.get("Target-Delimiter") || "::";
		const key =
			targetType === "heading"
				? rawTarget.split(targetDelimiter).join("\u001f")
				: rawTarget;

		const map = getDocumentMap(content);

		const entry = targetType === "heading"
			? this.resolveHeadingEntry((map as any).heading ?? {}, key)
			: (map as any)[targetType]?.[key];
		if (!entry) return null;

		return content.slice(entry.content.start, entry.content.end);
	}

	// --- PUT /note/* ---
	async handlePut(req: any, res: any): Promise<void> {
		const name = this.extractName(req);
		const file = await this.resolveNoteOrRespond(name, req, res);
		if (!file) return;

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
		const file = await this.resolveNoteOrRespond(name, req, res);
		if (!file) return;

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
		const file = await this.resolveNoteOrRespond(name, req, res);
		if (!file) return;

		res.set("Content-Location", encodeURI(file.path));

		return this.patchV3(file, req, res);
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
		const file = await this.resolveNoteOrRespond(name, req, res);
		if (!file) return;

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

		const file = await this.resolveNoteOrRespond(from, req, res);
		if (!file) return;

		let destPath: string = to;
		if (!destPath.endsWith(".md")) {
			destPath += ".md";
		}

		// Ensure destination directory exists (Obsidian doesn't auto-create it)
		const destDir = destPath.substring(0, destPath.lastIndexOf("/"));
		if (destDir) {
			const dirExists = await this.app.vault.adapter.exists(destDir);
			if (!dirExists) {
				await this.app.vault.createFolder(destDir);
			}
		}

		await this.app.fileManager.renameFile(file, destPath);
		res.status(200).json({ from: file.path, to: destPath });
	}
}

// --- Periodic Note Handler ---

class PeriodicNoteHandler {
	private app: Plugin["app"];
	private noteHandler: NoteHandler;

	constructor(app: Plugin["app"], noteHandler: NoteHandler) {
		this.app = app;
		this.noteHandler = noteHandler;
	}

	// Get Periodic Notes plugin instance
	private getPeriodicNotes(): any {
		return this.app.plugins.plugins["periodic-notes"];
	}

	// Normalize separators in date input
	private normalizeSeparators(input: string): string {
		return input.replace(/[./]/g, '-');
	}

	// Validate input for malformed patterns
	private isValidInput(input: string): boolean {
		// Reject empty
		if (!input) return false;

		// Reject triple dashes or more (malformed)
		if (input.includes('---')) return false;

		return true;
	}

	// Parse period from path
	private parsePeriod(periodStr: string): string | null {
		const valid = ["daily", "weekly", "monthly", "quarterly", "yearly"];
		return valid.includes(periodStr) ? periodStr : null;
	}

	// Parse date input with best-effort normalization
	private parseDate(input: string, period: string): any | null {
		const moment = (window as any).moment;

		// Normalize separators
		const normalized = this.normalizeSeparators(input);

		// Validate
		if (!this.isValidInput(normalized)) {
			return null;
		}

		// Try ISO date: YYYY-MM-DD (lenient, allows rollover)
		let date = moment(normalized, "YYYY-MM-DD");
		if (date && date.isValid()) {
			// Validate year range
			const year = date.year();
			if (year < 1900 || year > 2100) return null;
			return date;
		}
		// Try with negative day: 2026-01--5 (5 days before Jan 1)
		const dayMatch = normalized.match(/^(\d{4})-(\d{1,2})-(-?\d+)$/);
		if (dayMatch) {
			const year = parseInt(dayMatch[1]);
			const month = parseInt(dayMatch[2]);
			const day = parseInt(dayMatch[3]);
			if (year < 1900 || year > 2100) return null;
			// Create date at start of month, then add days
			date = moment([year, month - 1, 1]).add(day - 1, 'days');
			if (date && date.isValid()) {
				const resultYear = date.year();
				if (resultYear < 1900 || resultYear > 2100) return null;
				return date;
			}
		}

		// Try period-specific formats
		switch (period) {
			case "weekly":
				// ISO week: 2026-W03 or 2026-W-4 (negative = offset from start)
				date = moment(normalized, "YYYY-[W]WW");
				if (date && date.isValid()) {
					const year = date.year();
					if (year < 1900 || year > 2100) return null;
					return date;
				}
				// Try with negative week: 2026-W-4
				const weekMatch = normalized.match(/^(\d{4})-W(-?\d+)$/);
				if (weekMatch) {
					const year = parseInt(weekMatch[1]);
					const week = parseInt(weekMatch[2]);
					if (year < 1900 || year > 2100) return null;
					// Create date at start of year, then add weeks
					date = moment([year, 0, 1]).add(week - 1, 'weeks');
					if (date && date.isValid()) {
						const resultYear = date.year();
						if (resultYear < 1900 || resultYear > 2100) return null;
						return date;
					}
				}
				break;

			case "monthly":
				// Year-month: 2026-03 or 2026--2 (negative = offset)
				date = moment(normalized, "YYYY-MM");
				if (date && date.isValid()) {
					const year = date.year();
					if (year < 1900 || year > 2100) return null;
					return date;
				}
				// Try with negative month: 2026--2
				const monthMatch = normalized.match(/^(\d{4})-(-?\d+)$/);
				if (monthMatch && !normalized.includes("-W") && !normalized.includes("-Q")) {
					const year = parseInt(monthMatch[1]);
					const month = parseInt(monthMatch[2]);
					if (year < 1900 || year > 2100) return null;
					// Create date at start of year, then add months
					date = moment([year, 0, 1]).add(month - 1, 'months');
					if (date && date.isValid()) {
						const resultYear = date.year();
						if (resultYear < 1900 || resultYear > 2100) return null;
						return date;
					}
				}
				break;

			case "quarterly":
				// Year-quarter: 2026-Q1 or 2026-Q-1
				const quarterMatch = normalized.match(/^(\d{4})-Q(-?\d+)$/);
				if (quarterMatch) {
					const year = parseInt(quarterMatch[1]);
					const quarter = parseInt(quarterMatch[2]);
					if (year < 1900 || year > 2100) return null;
					// Allow negative quarters (relative offset)
					// Create date at start of year, then add quarters
					const month = (quarter - 1) * 3;
					date = moment([year, 0, 1]).add(month, 'months');
					if (date && date.isValid()) {
						const resultYear = date.year();
						if (resultYear < 1900 || resultYear > 2100) return null;
						return date;
					}
				}
				break;

			case "yearly":
				// Year: 2026
				date = moment(normalized, "YYYY");
				if (date && date.isValid()) {
					const year = date.year();
					if (year < 1900 || year > 2100) return null;
					return date;
				}
				break;
		}

		return null;
	}

	// Get note for period and date
	private getPeriodicNote(period: string, date: any): TFile | null {
		const periodicNotes = this.getPeriodicNotes();
		if (!periodicNotes) return null;

		switch (period) {
			case "daily":
				const dailyNotes = periodicNotes.getAllDailyNotes();
				return periodicNotes.getDailyNote(date, dailyNotes);
			case "weekly":
				const weeklyNotes = periodicNotes.getAllWeeklyNotes();
				return periodicNotes.getWeeklyNote(date, weeklyNotes);
			case "monthly":
				const monthlyNotes = periodicNotes.getAllMonthlyNotes();
				return periodicNotes.getMonthlyNote(date, monthlyNotes);
			case "quarterly":
				const quarterlyNotes = periodicNotes.getAllQuarterlyNotes();
				return periodicNotes.getQuarterlyNote(date, quarterlyNotes);
			case "yearly":
				const yearlyNotes = periodicNotes.getAllYearlyNotes();
				return periodicNotes.getYearlyNote(date, yearlyNotes);
		}
		return null;
	}

	// Create note for period and date
	private async createPeriodicNote(
		period: string,
		date: any,
		useTemplate: boolean
	): Promise<TFile | null> {
		const periodicNotes = this.getPeriodicNotes();
		if (!periodicNotes) return null;

		let file: TFile | null = null;

		switch (period) {
			case "daily":
				file = await periodicNotes.createDailyNote(date);
				break;
			case "weekly":
				file = await periodicNotes.createWeeklyNote(date);
				break;
			case "monthly":
				file = await periodicNotes.createMonthlyNote(date);
				break;
			case "quarterly":
				file = await periodicNotes.createQuarterlyNote(date);
				break;
			case "yearly":
				file = await periodicNotes.createYearlyNote(date);
				break;
		}

		if (file && !useTemplate) {
			// For PUT, we want empty file, not template
			// Clear the template content
			await this.app.vault.adapter.write(file.path, "");
		}

		return file;
	}

	// Extract period and date from request path
	private parsePath(req: any): {
		period: string;
		date: any;
		requested: string;
	} | null {
		// Path: /periodic-note/daily/ or /periodic-note/daily/2024-01-15
		const path = req.path;
		if (!path) return null;
		const parts = path.split("/").filter(Boolean);
		// parts: ["periodic-note", "daily"] or ["periodic-note", "daily", "2024-01-15"]

		if (parts.length < 2 || parts[0] !== "periodic-note") return null;

		const period = this.parsePeriod(parts[1]);
		if (!period) return null;

		const moment = (window as any).moment;
		let date: moment.Moment;
		let requested: string;

		if (parts.length === 2) {
			// /periodic-note/daily/ → current period
			date = moment();
			requested = date.format("YYYY-MM-DD");
		} else if (parts.length === 3) {
			// /periodic-note/daily/2024-01-15 → specific date
			requested = parts[2];
			const parsed = this.parseDate(requested, period);
			if (!parsed) return null;
			date = parsed;
		} else {
			return null;
		}

		return { period, date, requested };
	}

	// Get or create note based on method
	private async getOrCreateNote(
		period: string,
		date: any,
		method: string
	): Promise<[TFile | null, boolean]> {
		// Returns [file, created]
		let file = this.getPeriodicNote(period, date);
		let created = false;

		if (!file && ["PUT", "POST", "PATCH"].includes(method)) {
			// Auto-create for write operations
			const useTemplate = method !== "PUT"; // PUT creates empty, POST/PATCH use template
			file = await this.createPeriodicNote(period, date, useTemplate);
			created = true;

			if (file) {
				// Wait for metadata cache (like main API does)
				const createdFile = file;
				await new Promise<void>((resolve) => {
					const interval = setInterval(() => {
						const cache = this.app.metadataCache.getFileCache(createdFile);
						if (cache) {
							clearInterval(interval);
							resolve();
						}
					}, 100);
				});
			}
		}

		return [file, created];
	}

	// Add hierarchical navigation headers
	private addHierarchyLinks(res: any, period: string, date: any): void {
		const moment = (window as any).moment;
		const links: string[] = [];

		// Current link for this period type
		links.push(`</periodic-note/${period}/>; rel="current"`);

		// Up links based on period
		switch (period) {
			case "daily":
				// Week
				const weekStr = date.format("YYYY-[W]WW");
				links.push(`</periodic-note/weekly/${weekStr}>; rel="up"; title="week"`);
				// Month
				const monthStr = date.format("YYYY-MM");
				links.push(`</periodic-note/monthly/${monthStr}>; rel="up"; title="month"`);
				// Quarter
				const quarter = Math.floor(date.month() / 3) + 1;
				const quarterStr = `${date.format("YYYY")}-Q${quarter}`;
				links.push(`</periodic-note/quarterly/${quarterStr}>; rel="up"; title="quarter"`);
				// Year
				const yearStr = date.format("YYYY");
				links.push(`</periodic-note/yearly/${yearStr}>; rel="up"; title="year"`);
				break;

			case "weekly":
				// Month
				const weekMonthStr = date.format("YYYY-MM");
				links.push(`</periodic-note/monthly/${weekMonthStr}>; rel="up"; title="month"`);
				// Quarter
				const weekQuarter = Math.floor(date.month() / 3) + 1;
				const weekQuarterStr = `${date.format("YYYY")}-Q${weekQuarter}`;
				links.push(`</periodic-note/quarterly/${weekQuarterStr}>; rel="up"; title="quarter"`);
				// Year
				const weekYearStr = date.format("YYYY");
				links.push(`</periodic-note/yearly/${weekYearStr}>; rel="up"; title="year"`);
				break;

			case "monthly":
				// Quarter
				const monthQuarter = Math.floor(date.month() / 3) + 1;
				const monthQuarterStr = `${date.format("YYYY")}-Q${monthQuarter}`;
				links.push(`</periodic-note/quarterly/${monthQuarterStr}>; rel="up"; title="quarter"`);
				// Year
				const monthYearStr = date.format("YYYY");
				links.push(`</periodic-note/yearly/${monthYearStr}>; rel="up"; title="year"`);
				break;

			case "quarterly":
				// Year
				const quarterYearStr = date.format("YYYY");
				links.push(`</periodic-note/yearly/${quarterYearStr}>; rel="up"; title="year"`);
				break;

			case "yearly":
				// No up links
				break;
		}

		res.set("Link", links.join(", "));
	}

	// Main request handler (delegates to NoteHandler)
	private async handleRequest(
		req: any,
		res: any,
		method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE"
	): Promise<void> {
		// Parse path
		const parsed = this.parsePath(req);
		if (!parsed) {
			res.status(400).json({
				message: "Invalid periodic note path or date format. Expected /periodic-note/{period}/ or /periodic-note/{period}/{date}",
				errorCode: 40001,
			});
			return;
		}

		const { period, date, requested } = parsed;

		// Check if Periodic Notes plugin is available
		const periodicNotes = this.getPeriodicNotes();
		if (!periodicNotes) {
			res.status(400).json({
				message: "Periodic Notes plugin is not enabled.",
				errorCode: 40002,
			});
			return;
		}

		// Get or create note
		const [file, created] = await this.getOrCreateNote(period, date, method);

		if (!file) {
			res.status(404).json({
				message: `Periodic note for ${period} on ${date.format("YYYY-MM-DD")} does not exist.`,
				errorCode: 40401,
			});
			return;
		}

		// Add hierarchy links
		this.addHierarchyLinks(res, period, date);

		// Store periodic info for NoteJson response
		(req as any)._periodicInfo = {
			period,
			date: date.format("YYYY-MM-DD"),
			requested,
		};

		// Modify request to look like a /note/* request
		(req as any)._originalPath = req.path;
		req.path = `/note/${file.basename}`;

		// Delegate to NoteHandler
		switch (method) {
			case "GET":
				return this.noteHandler.handleGet(req, res);
			case "PUT":
				return this.noteHandler.handlePut(req, res);
			case "POST":
				return this.noteHandler.handlePost(req, res);
			case "PATCH":
				return this.noteHandler.handlePatch(req, res);
			case "DELETE":
				return this.noteHandler.handleDelete(req, res);
		}
	}

	// Public handlers
	async handleGet(req: any, res: any): Promise<void> {
		return this.handleRequest(req, res, "GET");
	}

	async handlePut(req: any, res: any): Promise<void> {
		return this.handleRequest(req, res, "PUT");
	}

	async handlePost(req: any, res: any): Promise<void> {
		return this.handleRequest(req, res, "POST");
	}

	async handlePatch(req: any, res: any): Promise<void> {
		return this.handleRequest(req, res, "PATCH");
	}

	async handleDelete(req: any, res: any): Promise<void> {
		return this.handleRequest(req, res, "DELETE");
	}
}

// --- Plugin ---

export default class NoteApiExtensionPlugin extends Plugin {
	private api: LocalRestApiPublicApi;

	registerRoutes() {
		this.api = getAPI(this.app, this.manifest);
		const handler = new NoteHandler(this.app);
		const periodicHandler = new PeriodicNoteHandler(this.app, handler);

		this.api
			.addRoute("/note/*")
			.get(asyncHandler(handler.handleGet.bind(handler)))
			.put(asyncHandler(handler.handlePut.bind(handler)))
			.post(asyncHandler(handler.handlePost.bind(handler)))
			.patch(asyncHandler(handler.handlePatch.bind(handler)))
			.delete(asyncHandler(handler.handleDelete.bind(handler)));

		this.api
			.addRoute("/periodic-note/*")
			.get(asyncHandler(periodicHandler.handleGet.bind(periodicHandler)))
			.put(asyncHandler(periodicHandler.handlePut.bind(periodicHandler)))
			.post(asyncHandler(periodicHandler.handlePost.bind(periodicHandler)))
			.patch(asyncHandler(periodicHandler.handlePatch.bind(periodicHandler)))
			.delete(asyncHandler(periodicHandler.handleDelete.bind(periodicHandler)));

		this.api
			.addRoute("/note-move/")
			.post(asyncHandler(handler.handleMove.bind(handler)));

		this.api
			.addRoute("/notes-openapi.yaml")
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
			plugins: Record<string, any>;
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

export { AliasCache, NoteHandler, PeriodicNoteHandler, asyncHandler, CONTENT_TYPE_MARKDOWN, CONTENT_TYPE_NOTE_JSON, CONTENT_TYPE_DOCUMENT_MAP };

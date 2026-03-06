import { vi } from "vitest";

export class TFile {
	path: string;
	basename: string;
	extension: string;
	stat: { ctime: number; mtime: number; size: number };

	constructor(path: string) {
		this.path = path;
		this.basename = path
			.split("/")
			.pop()!
			.replace(/\.[^.]+$/, "");
		this.extension = path.split(".").pop() || "";
		this.stat = { ctime: 1000, mtime: 2000, size: 100 };
	}
}

export class EventRef {}

export class Plugin {
	app: any;
	manifest: any;

	registerEvent(_ref: EventRef): void {}
}

export function parseFrontMatterAliases(
	frontmatter: any
): string[] | null {
	if (!frontmatter) return null;
	const aliases = frontmatter.aliases || frontmatter.alias;
	if (Array.isArray(aliases)) return aliases;
	if (typeof aliases === "string") return [aliases];
	return null;
}

export function prepareSimpleSearch(
	query: string
): ((text: string) => { score: number } | null) | null {
	if (!query) return null;
	const lower = query.toLowerCase();
	return (text: string) => {
		const idx = text.toLowerCase().indexOf(lower);
		if (idx >= 0) return { score: 1 - idx / text.length };
		return null;
	};
}

export function createMockApp() {
	const metadataCacheCallbacks: Record<string, Function[]> = {};
	const vaultCallbacks: Record<string, Function[]> = {};
	const workspaceCallbacks: Record<string, Function[]> = {};

	return {
		vault: {
			getMarkdownFiles: vi.fn(() => []),
			read: vi.fn(async () => ""),
			cachedRead: vi.fn(async () => ""),
			adapter: {
				read: vi.fn(async () => ""),
				readBinary: vi.fn(async () => new ArrayBuffer(0)),
				write: vi.fn(async () => {}),
				writeBinary: vi.fn(async () => {}),
				remove: vi.fn(async () => {}),
			},
			on: vi.fn((event: string, cb: Function) => {
				if (!vaultCallbacks[event]) vaultCallbacks[event] = [];
				vaultCallbacks[event].push(cb);
				return new EventRef();
			}),
			_trigger(event: string, ...args: any[]) {
				for (const cb of vaultCallbacks[event] || []) cb(...args);
			},
		},
		metadataCache: {
			getFileCache: vi.fn(() => null),
			getFirstLinkpathDest: vi.fn(() => null),
			on: vi.fn((event: string, cb: Function) => {
				if (!metadataCacheCallbacks[event])
					metadataCacheCallbacks[event] = [];
				metadataCacheCallbacks[event].push(cb);
				return new EventRef();
			}),
			_trigger(event: string, ...args: any[]) {
				for (const cb of metadataCacheCallbacks[event] || [])
					cb(...args);
			},
		},
		fileManager: {
			renameFile: vi.fn(async () => {}),
		},
		workspace: {
			on: vi.fn((event: string, cb: Function) => {
				if (!workspaceCallbacks[event])
					workspaceCallbacks[event] = [];
				workspaceCallbacks[event].push(cb);
				return new EventRef();
			}),
		},
		plugins: {
			enabledPlugins: new Set<string>(),
		},
	};
}

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NoteHandler, SnapshotStore } from "../main";
import { TFile, createMockApp } from "../mocks/obsidian";
import { createMockReq, createMockRes } from "../mocks/express";

function createHandler(app: any, maxReplaceRatio = 0.5, maxSnapshots = 20): NoteHandler {
	return new NoteHandler(app as any, () => ({ maxReplaceRatio, maxSnapshots }), new SnapshotStore(maxSnapshots));
}

describe("PUT overwrite protection (R3)", () => {
	let app: ReturnType<typeof createMockApp>;
	let handler: NoteHandler;
	let file: TFile;

	beforeEach(() => {
		app = createMockApp();
		app.vault.getMarkdownFiles.mockReturnValue([]);
		handler = createHandler(app);

		file = new TFile("notes/Test.md");
		app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
	});

	it("blocks PUT with body significantly smaller than existing file", async () => {
		const existingContent = "This is a long existing note. ".repeat(100);
		app.vault.read.mockResolvedValue(existingContent);

		const req = createMockReq({
			path: "/note/Test",
			body: "short",
		});
		const res = createMockRes();
		await handler.handlePut(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res._jsonBody.errorCode).toBe(40082);
		expect(res._jsonBody.currentContent).toBe(existingContent);
	});

	it("allows PUT with confirmation on significantly smaller body", async () => {
		const existingContent = "This is a long existing note. ".repeat(100);
		app.vault.read.mockResolvedValue(existingContent);

		const setSpy = vi.spyOn(handler["snapshotStore"], "set");

		const req = createMockReq({
			path: "/note/Test",
			headers: {
				"X-Confirm-Dangerous-Operation": "true",
			},
			body: "short",
		});
		const res = createMockRes();
		await handler.handlePut(req, res);

		expect(res.status).toHaveBeenCalledWith(204);
		expect(app.vault.adapter.write).toHaveBeenCalledWith("notes/Test.md", "short");
		// Should have snapshotted the full file
		expect(setSpy).toHaveBeenCalledWith(
			"notes/Test.md::(full file)",
			existingContent
		);
	});

	it("allows PUT with body larger than threshold without confirmation", async () => {
		const existingContent = "Short.";
		const largeBody = "This is a much longer body. ".repeat(50);
		app.vault.read.mockResolvedValue(existingContent);

		const req = createMockReq({
			path: "/note/Test",
			body: largeBody,
		});
		const res = createMockRes();
		await handler.handlePut(req, res);

		expect(res.status).toHaveBeenCalledWith(204);
		expect(app.vault.adapter.write).toHaveBeenCalledWith("notes/Test.md", largeBody);
	});

	it("allows PUT on empty file without protection", async () => {
		app.vault.read.mockResolvedValue("");

		const req = createMockReq({
			path: "/note/Test",
			body: "new content",
		});
		const res = createMockRes();
		await handler.handlePut(req, res);

		expect(res.status).toHaveBeenCalledWith(204);
		expect(app.vault.adapter.write).toHaveBeenCalledWith("notes/Test.md", "new content");
	});
});

describe("SnapshotStore (R4)", () => {
	it("stores and retrieves snapshots", () => {
		const store = new SnapshotStore(20);
		store.set("notes/Test.md::Main Title", "section content");
		expect(store.get("notes/Test.md::Main Title")).toBe("section content");
	});

	it("returns undefined for missing snapshots", () => {
		const store = new SnapshotStore(20);
		expect(store.get("nonexistent")).toBeUndefined();
	});

	it("counts entries correctly", () => {
		const store = new SnapshotStore(20);
		expect(store.count()).toBe(0);
		store.set("key1", "val1");
		store.set("key2", "val2");
		expect(store.count()).toBe(2);
	});

	it("evicts oldest entries when max is exceeded (FIFO)", () => {
		const store = new SnapshotStore(3);
		store.set("a", "1");
		store.set("b", "2");
		store.set("c", "3");
		store.set("d", "4"); // should evict "a"

		expect(store.count()).toBe(3);
		expect(store.get("a")).toBeUndefined();
		expect(store.get("b")).toBe("2");
		expect(store.get("c")).toBe("3");
		expect(store.get("d")).toBe("4");
	});

	it("updates existing key without changing eviction order", () => {
		const store = new SnapshotStore(3);
		store.set("a", "1");
		store.set("b", "2");
		store.set("c", "3");
		store.set("a", "updated"); // update, doesn't change order
		store.set("d", "4"); // evicts "a" (still oldest in insertion order)

		expect(store.count()).toBe(3);
		expect(store.get("a")).toBeUndefined(); // evicted because still oldest
		expect(store.get("b")).toBe("2");
		expect(store.get("c")).toBe("3");
		expect(store.get("d")).toBe("4");
	});

	it("does not store when max is 0", () => {
		const store = new SnapshotStore(0);
		store.set("key", "value");
		expect(store.count()).toBe(0);
		expect(store.get("key")).toBeUndefined();
	});

	it("lists all entries via entries()", () => {
		const store = new SnapshotStore(20);
		store.set("k1", "v1");
		store.set("k2", "v2");
		const entries = store.entries();
		expect(entries).toHaveLength(2);
		expect(entries).toContainEqual(["k1", "v1"]);
		expect(entries).toContainEqual(["k2", "v2"]);
	});

	it("respects dynamic max update", () => {
		const store = new SnapshotStore(5);
		store.set("a", "1");
		store.set("b", "2");
		store.set("c", "3");
		store.max = 2; // reduce
		store.set("d", "4"); // should evict oldest 2

		expect(store.count()).toBe(2);
		expect(store.get("a")).toBeUndefined();
		expect(store.get("b")).toBeUndefined();
		expect(store.get("c")).toBe("3");
		expect(store.get("d")).toBe("4");
	});
});

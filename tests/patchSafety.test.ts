import { describe, it, expect, beforeEach, vi } from "vitest";
import { NoteHandler, SnapshotStore } from "../main";
import { TFile, createMockApp } from "../mocks/obsidian";
import { createMockReq, createMockRes } from "../mocks/express";

// Mock markdown-patch at the module level
vi.mock("markdown-patch", async () => {
	const actual = await vi.importActual("markdown-patch");
	class PatchFailed extends Error {
		reason: string;
		constructor(reason: string) {
			super(reason);
			this.reason = reason;
			this.name = "PatchFailed";
		}
	}
	return {
		...actual,
		applyPatch: vi.fn(),
		PatchFailed,
	};
});

import { applyPatch, PatchFailed, getDocumentMap } from "markdown-patch";
const mockApplyPatch = vi.mocked(applyPatch);

const defaultSettings = () => ({ maxReplaceRatio: 0.5, maxSnapshots: 20 });

describe("PATCH safety checks", () => {
	let app: ReturnType<typeof createMockApp>;
	let handler: NoteHandler;
	let file: TFile;

	beforeEach(() => {
		app = createMockApp();
		app.vault.getMarkdownFiles.mockReturnValue([]);
		handler = new NoteHandler(app as any, defaultSettings);

		file = new TFile("notes/Test.md");
		app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
		mockApplyPatch.mockReset();
	});

	describe("H1 replace protection", () => {
		it("blocks replace on H1 that would affect >50% of document without confirmation", async () => {
			const content = "# Main Title\n\n" + "This is a long section. ".repeat(100) + "\n\n## Small Section\n\nSmall content.";
			app.vault.read.mockResolvedValue(content);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Main Title",
				},
				body: "New content",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res._jsonBody.errorCode).toBe(40081);
			expect(res._jsonBody.message).toContain("would affect");
			expect(res._jsonBody.message).toContain("X-Confirm-Dangerous-Operation");
			expect(mockApplyPatch).not.toHaveBeenCalled();
		});

		it("allows replace on H1 with confirmation header", async () => {
			const content = "# Main Title\n\n" + "Content. ".repeat(100);
			app.vault.read.mockResolvedValue(content);
			mockApplyPatch.mockReturnValue("patched content");

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Main Title",
					"X-Confirm-Dangerous-Operation": "true",
				},
				body: "New content",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(mockApplyPatch).toHaveBeenCalled();
		});

		it("allows replace on H1 that affects <50% of document", async () => {
			const content = "# First Section\n\nShort.\n\n# Main Title\n\n" + "Content. ".repeat(20) + "\n\n# Third Section\n\n" + "More content. ".repeat(100);
			app.vault.read.mockResolvedValue(content);
			mockApplyPatch.mockReturnValue("patched content");

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Main Title",
				},
				body: "Replacement. ".repeat(20),
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(mockApplyPatch).toHaveBeenCalled();
		});

		it("allows append/prepend operations without restriction", async () => {
			const content = "# Main Title\n\n" + "Content. ".repeat(100);
			app.vault.read.mockResolvedValue(content);
			mockApplyPatch.mockReturnValue("patched content");

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "append",
					"Target-Type": "heading",
					Target: "Main Title",
				},
				body: "Appended content",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(mockApplyPatch).toHaveBeenCalled();
		});
	});

	// R1: Protection covers all heading depths
	describe("nested heading replace protection", () => {
		it("blocks replace on nested heading that would affect >50% of document", async () => {
			const content = "# Parent\n\n## Child\n\n" + "Long nested content. ".repeat(100) + "\n\n# Other\n\nShort.";
			app.vault.read.mockResolvedValue(content);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Parent::Child",
				},
				body: "New content",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res._jsonBody.errorCode).toBe(40081);
			expect(res._jsonBody.message).toContain("would affect");
			expect(mockApplyPatch).not.toHaveBeenCalled();
		});

		it("allows replace on nested heading that affects <50% of document", async () => {
			const content = "# Parent\n\n## Child\n\nShort.\n\n## Other\n\n" + "Much more content. ".repeat(100);
			app.vault.read.mockResolvedValue(content);
			mockApplyPatch.mockReturnValue("patched content");

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Parent::Child",
				},
				body: "New content",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(mockApplyPatch).toHaveBeenCalled();
		});
	});

	// R2: currentContent in protection errors
	describe("currentContent in error responses", () => {
		it("includes currentContent in 40081 protection error", async () => {
			const content = "# Big Section\n\n" + "Lots of content here. ".repeat(100) + "\n\n# Tiny\n\nSmall.";
			app.vault.read.mockResolvedValue(content);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Big Section",
				},
				body: "New content",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res._jsonBody.errorCode).toBe(40081);
			expect(res._jsonBody.currentContent).toBeDefined();
			expect(res._jsonBody.currentContent).toContain("Lots of content here.");
		});

		it("includes currentContent in 40080 PatchFailed error when heading exists", async () => {
			const content = "# Section\n\nSome content.\n\n# Other\n\nOther content.";
			app.vault.read.mockResolvedValue(content);
			mockApplyPatch.mockImplementation(() => {
				const err = new (PatchFailed as any)("Patch failed: content mismatch");
				throw err;
			});

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Section",
				},
				body: "New content",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res._jsonBody.errorCode).toBe(40080);
			expect(res._jsonBody.currentContent).toBeDefined();
			expect(res._jsonBody.currentContent).toContain("Some content.");
		});
	});

	// R6: Section-level truncation protection
	describe("section truncation protection", () => {
		it("blocks replace that truncates a small section significantly", async () => {
			// Section is small relative to the doc (won't trigger R1), but replacement is tiny relative to the section
			const content = "# Other\n\n" + "Other content. ".repeat(200) + "\n\n# Target Section\n\n" + "Important data. ".repeat(50) + "\n\n# Another\n\nMore stuff.";
			app.vault.read.mockResolvedValue(content);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Target Section",
				},
				body: "- [ ] todo",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res._jsonBody.errorCode).toBe(40083);
			expect(res._jsonBody.message).toContain("truncate section");
			expect(res._jsonBody.currentContent).toContain("Important data.");
			expect(res._jsonBody.details.replacementSize).toBe(10);
			expect(mockApplyPatch).not.toHaveBeenCalled();
		});

		it("allows replace when replacement is similar size to section", async () => {
			const sectionContent = "Some content in section.";
			const content = "# Other\n\n" + "Filler. ".repeat(100) + "\n\n# Target\n\n" + sectionContent + "\n\n# Another\n\nMore.";
			app.vault.read.mockResolvedValue(content);
			mockApplyPatch.mockReturnValue("patched");

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Target",
				},
				body: "Replacement of similar length!",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(mockApplyPatch).toHaveBeenCalled();
		});

		it("allows truncating replace with confirmation header", async () => {
			const content = "# Other\n\n" + "Other. ".repeat(200) + "\n\n# Target\n\n" + "Data. ".repeat(50) + "\n\n# End\n\nDone.";
			app.vault.read.mockResolvedValue(content);
			mockApplyPatch.mockReturnValue("patched");

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Target",
					"X-Confirm-Dangerous-Operation": "true",
				},
				body: "tiny",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(mockApplyPatch).toHaveBeenCalled();
		});

		it("snapshots section content when confirmed truncation proceeds", async () => {
			const content = "# Other\n\n" + "Other. ".repeat(200) + "\n\n# Target\n\n" + "Data to save. ".repeat(50) + "\n\n# End\n\nDone.";
			app.vault.read.mockResolvedValue(content);
			mockApplyPatch.mockReturnValue("patched");

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Target",
					"X-Confirm-Dangerous-Operation": "true",
				},
				body: "tiny",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			const snapshots = handler.snapshots.list();
			expect(snapshots.length).toBe(1);
			expect(snapshots[0].filePath).toBe("notes/Test.md");
			expect(snapshots[0].target).toBe("Target");
		});

		it("does not trigger for append/prepend operations", async () => {
			const content = "# Target\n\n" + "Lots of content. ".repeat(50);
			app.vault.read.mockResolvedValue(content);
			mockApplyPatch.mockReturnValue("patched");

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "append",
					"Target-Type": "heading",
					Target: "Target",
				},
				body: "tiny",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(mockApplyPatch).toHaveBeenCalled();
		});
	});

	// R4: Snapshots on confirmed dangerous operations
	describe("snapshot on confirmed dangerous operations", () => {
		it("creates a snapshot when confirmed dangerous PATCH proceeds", async () => {
			const content = "# Main Title\n\n" + "Content to snapshot. ".repeat(100);
			app.vault.read.mockResolvedValue(content);
			mockApplyPatch.mockReturnValue("patched content");

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Main Title",
					"X-Confirm-Dangerous-Operation": "true",
				},
				body: "New content",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			const snapshots = handler.snapshots.list();
			expect(snapshots.length).toBe(1);
			expect(snapshots[0].filePath).toBe("notes/Test.md");
			expect(snapshots[0].target).toBe("Main Title");
		});

		it("does not create a snapshot when replace is below threshold", async () => {
			const content = "# Small\n\nShort.\n\n# Other\n\n" + "More content. ".repeat(100);
			app.vault.read.mockResolvedValue(content);
			mockApplyPatch.mockReturnValue("patched content");

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Small",
				},
				body: "New content",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			const snapshots = handler.snapshots.list();
			expect(snapshots.length).toBe(0);
		});
	});
});

// R3: PUT overwrite protection
describe("PUT overwrite protection", () => {
	let app: ReturnType<typeof createMockApp>;
	let handler: NoteHandler;
	let file: TFile;

	beforeEach(() => {
		app = createMockApp();
		app.vault.getMarkdownFiles.mockReturnValue([]);
		handler = new NoteHandler(app as any, defaultSettings);

		file = new TFile("notes/Test.md");
		app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
	});

	it("blocks PUT when new content is significantly smaller than existing", async () => {
		const existingContent = "x".repeat(1000);
		app.vault.read.mockResolvedValue(existingContent);

		const req = createMockReq({
			path: "/note/Test",
			body: "tiny",
		});
		const res = createMockRes();
		await handler.handlePut(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res._jsonBody.errorCode).toBe(40082);
		expect(res._jsonBody.currentContent).toBe(existingContent);
		expect(res._jsonBody.message).toContain("X-Confirm-Dangerous-Operation");
		expect(app.vault.adapter.write).not.toHaveBeenCalled();
	});

	it("allows PUT with confirmation header", async () => {
		const existingContent = "x".repeat(1000);
		app.vault.read.mockResolvedValue(existingContent);

		const req = createMockReq({
			path: "/note/Test",
			body: "tiny",
			headers: {
				"X-Confirm-Dangerous-Operation": "true",
			},
		});
		const res = createMockRes();
		await handler.handlePut(req, res);

		expect(res.status).toHaveBeenCalledWith(204);
		expect(app.vault.adapter.write).toHaveBeenCalledWith("notes/Test.md", "tiny");
	});

	it("allows PUT when new content is similar size to existing", async () => {
		const existingContent = "x".repeat(100);
		app.vault.read.mockResolvedValue(existingContent);

		const req = createMockReq({
			path: "/note/Test",
			body: "y".repeat(90),
		});
		const res = createMockRes();
		await handler.handlePut(req, res);

		expect(res.status).toHaveBeenCalledWith(204);
		expect(app.vault.adapter.write).toHaveBeenCalled();
	});

	it("allows PUT when existing file is empty", async () => {
		app.vault.read.mockResolvedValue("");

		const req = createMockReq({
			path: "/note/Test",
			body: "new content",
		});
		const res = createMockRes();
		await handler.handlePut(req, res);

		expect(res.status).toHaveBeenCalledWith(204);
		expect(app.vault.adapter.write).toHaveBeenCalled();
	});

	it("creates snapshot when confirmed PUT proceeds", async () => {
		const existingContent = "x".repeat(1000);
		app.vault.read.mockResolvedValue(existingContent);

		const req = createMockReq({
			path: "/note/Test",
			body: "tiny",
			headers: {
				"X-Confirm-Dangerous-Operation": "true",
			},
		});
		const res = createMockRes();
		await handler.handlePut(req, res);

		expect(res.status).toHaveBeenCalledWith(204);
		const snapshots = handler.snapshots.list();
		expect(snapshots.length).toBe(1);
		expect(snapshots[0].filePath).toBe("notes/Test.md");
		expect(snapshots[0].target).toBe("(full file)");
	});

	it("does not snapshot when PUT is below threshold", async () => {
		const existingContent = "x".repeat(100);
		app.vault.read.mockResolvedValue(existingContent);

		const req = createMockReq({
			path: "/note/Test",
			body: "y".repeat(90),
		});
		const res = createMockRes();
		await handler.handlePut(req, res);

		expect(res.status).toHaveBeenCalledWith(204);
		expect(handler.snapshots.list().length).toBe(0);
	});

	it("skips protection for binary body", async () => {
		const buf = Buffer.from("binary");
		const req = createMockReq({
			path: "/note/Test",
			body: buf,
		});
		const res = createMockRes();
		await handler.handlePut(req, res);

		expect(res.status).toHaveBeenCalledWith(204);
		expect(app.vault.adapter.writeBinary).toHaveBeenCalled();
	});
});

// R5: SnapshotStore
describe("SnapshotStore", () => {
	it("adds and retrieves snapshots", () => {
		const store = new SnapshotStore(() => 20);
		store.add("a.md", "Heading", "content");

		const snap = store.get("a.md", "Heading");
		expect(snap).toBeDefined();
		expect(snap!.content).toBe("content");
		expect(snap!.filePath).toBe("a.md");
		expect(snap!.target).toBe("Heading");
		expect(snap!.key).toBe("a.md::Heading");
	});

	it("returns most recent snapshot for same key", () => {
		const store = new SnapshotStore(() => 20);
		store.add("a.md", "H", "first");
		store.add("a.md", "H", "second");

		const snap = store.get("a.md", "H");
		expect(snap!.content).toBe("second");
	});

	it("list returns summaries without content", () => {
		const store = new SnapshotStore(() => 20);
		store.add("a.md", "H", "content");

		const list = store.list();
		expect(list.length).toBe(1);
		expect(list[0]).not.toHaveProperty("content");
		expect(list[0].key).toBe("a.md::H");
	});

	it("evicts oldest when limit exceeded", () => {
		const store = new SnapshotStore(() => 3);
		store.add("a.md", "1", "c1");
		store.add("a.md", "2", "c2");
		store.add("a.md", "3", "c3");
		store.add("a.md", "4", "c4");

		const list = store.list();
		expect(list.length).toBe(3);
		expect(list[0].target).toBe("2");
		expect(list[2].target).toBe("4");
	});

	it("does not store when maxSnapshots is 0", () => {
		const store = new SnapshotStore(() => 0);
		store.add("a.md", "H", "content");

		expect(store.list().length).toBe(0);
		expect(store.get("a.md", "H")).toBeUndefined();
	});

	it("returns undefined for non-existent snapshot", () => {
		const store = new SnapshotStore(() => 20);
		expect(store.get("missing.md", "H")).toBeUndefined();
	});
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NoteHandler } from "../main";
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

describe("PATCH safety checks", () => {
	let app: ReturnType<typeof createMockApp>;
	let handler: NoteHandler;
	let file: TFile;

	beforeEach(() => {
		app = createMockApp();
		app.vault.getMarkdownFiles.mockReturnValue([]);
		handler = new NoteHandler(app as any, () => ({ maxReplaceRatio: 0.5 }));

		file = new TFile("notes/Test.md");
		app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
		mockApplyPatch.mockReset();
	});

	describe("H1 replace protection", () => {
		it("blocks replace on H1 that would affect >50% of document without confirmation", async () => {
			// Create a document where H1 contains most of the content
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
			expect(res._jsonBody.currentContent).toContain("This is a long section.");
			expect(mockApplyPatch).not.toHaveBeenCalled();
		});

		it("allows replace on H1 with confirmation header and stores snapshot", async () => {
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

			const snapshot = handler.getSnapshot("notes/Test.md", "Main Title");
			expect(snapshot).toBeDefined();
			expect(snapshot!.filePath).toBe("notes/Test.md");
			expect(snapshot!.heading).toBe("Main Title");
			expect(snapshot!.content).toContain("Content. ");
		});

		it("allows replace on H1 that affects <50% of document", async () => {
			// Create a document with multiple large sections
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
				body: "New content",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			// Should succeed (section is <50% of document)
			expect(res.status).toHaveBeenCalledWith(200);
			expect(mockApplyPatch).toHaveBeenCalled();
		});

		it("blocks replace on nested heading that would affect >50% of document", async () => {
			const content = "# Main\n\n## Subsection\n\n" + "Nested content. ".repeat(100) + "\n\n## Tiny\n\nSmall.";
			app.vault.read.mockResolvedValue(content);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Main::Subsection",
				},
				body: "New content",
			});
			const res = createMockRes();
			await handler.handlePatch(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res._jsonBody.errorCode).toBe(40081);
			expect(res._jsonBody.details.heading).toBe("Main::Subsection");
			expect(mockApplyPatch).not.toHaveBeenCalled();
		});

		it("allows replace on nested heading that affects <50% of document", async () => {
			const content = "# Main\n\n" + "Top content. ".repeat(100) + "\n\n## Subsection\n\nSmall nested content.\n\n## Other\n\n" + "More content. ".repeat(100);
			app.vault.read.mockResolvedValue(content);
			mockApplyPatch.mockReturnValue("patched content");

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					Operation: "replace",
					"Target-Type": "heading",
					Target: "Main::Subsection",
				},
				body: "New content",
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

			// Should succeed (append is not destructive)
			expect(res.status).toHaveBeenCalledWith(200);
			expect(mockApplyPatch).toHaveBeenCalled();
		});
	});

	describe("PUT overwrite protection", () => {
		it("blocks PUT that would dramatically shrink the file", async () => {
			const content = "# My Note\n\n" + "Important content. ".repeat(200);
			app.vault.read.mockResolvedValue(content);

			const req = createMockReq({
				path: "/note/Test",
				body: "tiny replacement",
			});
			const res = createMockRes();
			await handler.handlePut(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res._jsonBody.errorCode).toBe(40082);
			expect(res._jsonBody.currentContent).toContain("Important content.");
		});

		it("allows PUT with confirmation header and stores snapshot", async () => {
			const content = "# My Note\n\n" + "Important content. ".repeat(200);
			app.vault.read.mockResolvedValue(content);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					"X-Confirm-Dangerous-Operation": "true",
				},
				body: "tiny replacement",
			});
			const res = createMockRes();
			await handler.handlePut(req, res);

			expect(res.status).toHaveBeenCalledWith(204);
			const snapshot = handler.getSnapshot("notes/Test.md", "(full file)");
			expect(snapshot).toBeDefined();
			expect(snapshot!.content).toContain("Important content.");
		});

		it("allows PUT of similar-sized content without confirmation", async () => {
			const content = "# My Note\n\nOld content here.";
			app.vault.read.mockResolvedValue(content);

			const req = createMockReq({
				path: "/note/Test",
				body: "# My Note\n\nNew content here.",
			});
			const res = createMockRes();
			await handler.handlePut(req, res);

			expect(res.status).toHaveBeenCalledWith(204);
		});
	});
});

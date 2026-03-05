import { describe, it, expect, beforeEach, vi } from "vitest";
import { NoteHandler } from "../main";
import { TFile, createMockApp } from "../mocks/obsidian";
import { createMockReq, createMockRes } from "../mocks/express";

// Mock markdown-patch at the module level
vi.mock("markdown-patch", () => {
	class PatchFailed extends Error {
		reason: string;
		constructor(reason: string) {
			super(reason);
			this.reason = reason;
			this.name = "PatchFailed";
		}
	}
	return {
		applyPatch: vi.fn(),
		PatchFailed,
	};
});

import { applyPatch, PatchFailed } from "markdown-patch";
const mockApplyPatch = vi.mocked(applyPatch);

describe("PATCH /note/* (V3)", () => {
	let app: ReturnType<typeof createMockApp>;
	let handler: NoteHandler;
	let file: TFile;

	beforeEach(() => {
		app = createMockApp();
		app.vault.getMarkdownFiles.mockReturnValue([]);
		handler = new NoteHandler(app as any);

		file = new TFile("notes/Test.md");
		app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
		app.vault.read.mockResolvedValue("original content");
		mockApplyPatch.mockReset();
	});

	it("returns 400 (40053) when Target-Type is missing", async () => {
		const req = createMockReq({
			path: "/note/Test",
			headers: {
				Operation: "append",
				Target: "heading",
			},
		});
		const res = createMockRes();
		await handler.handlePatch(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res._jsonBody.errorCode).toBe(40053);
	});

	it("returns 400 (40054) for invalid Target-Type", async () => {
		const req = createMockReq({
			path: "/note/Test",
			headers: {
				"Target-Type": "invalid",
				Operation: "append",
				Target: "foo",
			},
		});
		const res = createMockRes();
		await handler.handlePatch(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res._jsonBody.errorCode).toBe(40054);
	});

	it("returns 400 (40056) when Operation is missing", async () => {
		const req = createMockReq({
			path: "/note/Test",
			headers: {
				"Target-Type": "heading",
				Target: "foo",
			},
		});
		const res = createMockRes();
		await handler.handlePatch(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res._jsonBody.errorCode).toBe(40056);
	});

	it("returns 400 (40057) for invalid Operation", async () => {
		const req = createMockReq({
			path: "/note/Test",
			headers: {
				"Target-Type": "heading",
				Operation: "delete",
				Target: "foo",
			},
		});
		const res = createMockRes();
		await handler.handlePatch(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res._jsonBody.errorCode).toBe(40057);
	});

	it("splits heading target on delimiter", async () => {
		mockApplyPatch.mockReturnValue("patched");

		const req = createMockReq({
			path: "/note/Test",
			headers: {
				"Target-Type": "heading",
				Operation: "append",
				Target: "H1%3A%3AH2",
				"Content-Type": "text/markdown",
			},
			body: "new text",
		});
		const res = createMockRes();
		await handler.handlePatch(req, res);

		expect(mockApplyPatch).toHaveBeenCalledWith(
			"original content",
			expect.objectContaining({
				target: ["H1", "H2"],
				targetType: "heading",
			})
		);
	});

	it("uses custom Target-Delimiter for heading split", async () => {
		mockApplyPatch.mockReturnValue("patched");

		const req = createMockReq({
			path: "/note/Test",
			headers: {
				"Target-Type": "heading",
				Operation: "append",
				Target: "H1%7CH2",
				"Target-Delimiter": "|",
				"Content-Type": "text/markdown",
			},
			body: "new text",
		});
		const res = createMockRes();
		await handler.handlePatch(req, res);

		expect(mockApplyPatch).toHaveBeenCalledWith(
			"original content",
			expect.objectContaining({
				target: ["H1", "H2"],
			})
		);
	});

	it("returns 200 with patched content on success", async () => {
		mockApplyPatch.mockReturnValue("patched content");

		const req = createMockReq({
			path: "/note/Test",
			headers: {
				"Target-Type": "block",
				Operation: "replace",
				Target: "block-id",
				"Content-Type": "text/markdown",
			},
			body: "replacement",
		});
		const res = createMockRes();
		await handler.handlePatch(req, res);

		expect(app.vault.adapter.write).toHaveBeenCalledWith(
			"notes/Test.md",
			"patched content"
		);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.send).toHaveBeenCalledWith("patched content");
	});

	it("returns 400 (40080) when PatchFailed is thrown", async () => {
		// Get the actual PatchFailed from the mocked module
		const { PatchFailed: MockPatchFailed } = await import("markdown-patch");
		mockApplyPatch.mockImplementation(() => {
			throw new MockPatchFailed("Target not found");
		});

		const req = createMockReq({
			path: "/note/Test",
			headers: {
				"Target-Type": "frontmatter",
				Operation: "replace",
				Target: "title",
				"Content-Type": "text/markdown",
			},
			body: "new title",
		});
		const res = createMockRes();
		await handler.handlePatch(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res._jsonBody.errorCode).toBe(40080);
		expect(res._jsonBody.message).toBe("Target not found");
	});

	it("returns 500 for unexpected errors", async () => {
		mockApplyPatch.mockImplementation(() => {
			throw new Error("unexpected");
		});

		const req = createMockReq({
			path: "/note/Test",
			headers: {
				"Target-Type": "block",
				Operation: "append",
				Target: "id",
				"Content-Type": "text/markdown",
			},
			body: "text",
		});
		const res = createMockRes();
		await handler.handlePatch(req, res);

		expect(res.status).toHaveBeenCalledWith(500);
		expect(res._jsonBody.message).toBe("unexpected");
	});

	it("forwards Create-Target-If-Missing header", async () => {
		mockApplyPatch.mockReturnValue("patched");

		const req = createMockReq({
			path: "/note/Test",
			headers: {
				"Target-Type": "frontmatter",
				Operation: "append",
				Target: "tags",
				"Content-Type": "text/markdown",
				"Create-Target-If-Missing": "true",
			},
			body: "new-tag",
		});
		const res = createMockRes();
		await handler.handlePatch(req, res);

		expect(mockApplyPatch).toHaveBeenCalledWith(
			"original content",
			expect.objectContaining({
				createTargetIfMissing: true,
			})
		);
	});

	it("forwards Apply-If-Content-Preexists and Trim-Target-Whitespace headers", async () => {
		mockApplyPatch.mockReturnValue("patched");

		const req = createMockReq({
			path: "/note/Test",
			headers: {
				"Target-Type": "heading",
				Operation: "prepend",
				Target: "Section",
				"Content-Type": "text/markdown",
				"Apply-If-Content-Preexists": "true",
				"Trim-Target-Whitespace": "true",
			},
			body: "text",
		});
		const res = createMockRes();
		await handler.handlePatch(req, res);

		expect(mockApplyPatch).toHaveBeenCalledWith(
			"original content",
			expect.objectContaining({
				applyIfContentPreexists: true,
				trimTargetWhitespace: true,
			})
		);
	});

	it("returns 404 when note not found", async () => {
		app.metadataCache.getFirstLinkpathDest.mockReturnValue(null);

		const req = createMockReq({
			path: "/note/Missing",
			headers: {
				"Target-Type": "heading",
				Operation: "append",
				Target: "foo",
			},
		});
		const res = createMockRes();
		await handler.handlePatch(req, res);

		expect(res.status).toHaveBeenCalledWith(404);
	});
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NoteHandler } from "../main";
import { TFile, createMockApp } from "../mocks/obsidian";
import { createMockReq, createMockRes } from "../mocks/express";

describe("Ambiguous heading resolution", () => {
	let app: ReturnType<typeof createMockApp>;
	let handler: NoteHandler;
	let file: TFile;

	const CONTENT_WITH_DUPLICATE_HEADINGS = [
		"# My Note",
		"",
		"## Details",
		"",
		"First details section.",
		"",
		"## Section A",
		"",
		"### Details",
		"",
		"Nested details under Section A.",
		"",
		"## Section B",
		"",
		"### Details",
		"",
		"Nested details under Section B.",
	].join("\n");

	const CONTENT_WITH_UNIQUE_HEADINGS = [
		"# My Note",
		"",
		"## Overview",
		"",
		"Overview content.",
		"",
		"## Tasks",
		"",
		"Task content.",
	].join("\n");

	beforeEach(() => {
		app = createMockApp();
		app.vault.getMarkdownFiles.mockReturnValue([]);
		handler = new NoteHandler(app as any, () => ({
			maxReplaceRatio: 0.5,
			maxSnapshots: 20,
		}));
		file = new TFile("notes/Test.md");
		app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
	});

	describe("GET /note/* with target heading", () => {
		it("returns section for unique leaf heading", async () => {
			app.vault.read.mockResolvedValue(CONTENT_WITH_UNIQUE_HEADINGS);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					"Target-Type": "heading",
					Target: "Tasks",
				},
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.statusCode).not.toBe(400);
			expect(res._body).toContain("Task content.");
		});

		it("returns section for full heading path", async () => {
			app.vault.read.mockResolvedValue(CONTENT_WITH_DUPLICATE_HEADINGS);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					"Target-Type": "heading",
					Target: "Section A::Details",
				},
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.statusCode).not.toBe(400);
			expect(res._body).toContain("Nested details under Section A.");
		});

		it("returns 400 with matches for ambiguous leaf heading", async () => {
			app.vault.read.mockResolvedValue(CONTENT_WITH_DUPLICATE_HEADINGS);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					"Target-Type": "heading",
					Target: "Details",
				},
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res._jsonBody.errorCode).toBe(40081);
			expect(res._jsonBody.matches).toBeDefined();
			expect(res._jsonBody.matches.length).toBeGreaterThan(1);
			// Should include the full paths for disambiguation
			expect(res._jsonBody.matches).toContain("My Note::Details");
			expect(res._jsonBody.matches).toContain("My Note::Section A::Details");
			expect(res._jsonBody.matches).toContain("My Note::Section B::Details");
		});

		it("error message includes all matching full paths", async () => {
			app.vault.read.mockResolvedValue(CONTENT_WITH_DUPLICATE_HEADINGS);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					"Target-Type": "heading",
					Target: "Details",
				},
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res._jsonBody.message).toContain("Ambiguous heading");
			expect(res._jsonBody.message).toContain("Section A::Details");
			expect(res._jsonBody.message).toContain("Section B::Details");
		});
	});
});

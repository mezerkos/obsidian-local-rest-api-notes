import { describe, it, expect, beforeEach, vi } from "vitest";
import { NoteHandler } from "../main";
import { TFile, createMockApp } from "../mocks/obsidian";
import { createMockReq, createMockRes } from "../mocks/express";

describe("NoteHandler", () => {
	let app: ReturnType<typeof createMockApp>;
	let handler: NoteHandler;

	beforeEach(() => {
		app = createMockApp();
		// Provide empty markdown files list for AliasCache initial build
		app.vault.getMarkdownFiles.mockReturnValue([]);
		handler = new NoteHandler(app as any);
	});

	// --- extractName ---
	describe("extractName (via handler methods)", () => {
		it("extracts simple note name from path", async () => {
			const req = createMockReq({ path: "/note/MyNote" });
			const res = createMockRes();
			await handler.handleGet(req, res);
			// It should try to resolve "MyNote"
			expect(app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
				"MyNote",
				"/"
			);
		});

		it("decodes URL-encoded names", async () => {
			const req = createMockReq({ path: "/note/My%20Note" });
			const res = createMockRes();
			await handler.handleGet(req, res);
			expect(app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
				"My Note",
				"/"
			);
		});

		it("handles nested paths", async () => {
			const req = createMockReq({
				path: "/note/Projects/My%20Note",
			});
			const res = createMockRes();
			await handler.handleGet(req, res);
			expect(app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
				"Projects/My Note",
				"/"
			);
		});
	});

	// --- resolveNote ---
	describe("resolveNote (via handler methods)", () => {
		it("resolves via direct link path first", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);

			const req = createMockReq({ path: "/note/Test" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.statusCode).not.toBe(404);
		});

		it("falls back to alias cache", async () => {
			const file = new TFile("notes/Real Name.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(null);

			// Set up alias cache
			app.vault.getMarkdownFiles.mockReturnValue([file]);
			app.metadataCache.getFileCache.mockReturnValue({
				frontmatter: { aliases: ["Alias"] },
			});

			// Re-create handler to pick up new files
			handler = new NoteHandler(app as any);

			const req = createMockReq({ path: "/note/Alias" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.statusCode).not.toBe(404);
		});

		it("returns 404 when no match", async () => {
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(null);

			const req = createMockReq({ path: "/note/NonExistent" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).toHaveBeenCalledWith(404);
			expect(res._jsonBody.errorCode).toBe(40462);
		});
	});

	// --- findSimilarNotes ---
	describe("404 suggestions", () => {
		it("includes suggestions in 404 response", async () => {
			const files = [
				new TFile("notes/Apple.md"),
				new TFile("notes/Application.md"),
			];
			app.vault.getMarkdownFiles.mockReturnValue(files);
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(null);
			app.metadataCache.getFileCache.mockReturnValue(null);

			// Re-create to pick up files
			handler = new NoteHandler(app as any);

			const req = createMockReq({ path: "/note/App" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).toHaveBeenCalledWith(404);
			expect(res._jsonBody.suggestions).toBeDefined();
			expect(res._jsonBody.suggestions.length).toBeGreaterThan(0);
		});

		it("limits suggestions to 5", async () => {
			const files = Array.from({ length: 10 }, (_, i) =>
				new TFile(`notes/Note${i}.md`)
			);
			app.vault.getMarkdownFiles.mockReturnValue(files);
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(null);
			app.metadataCache.getFileCache.mockReturnValue(null);

			handler = new NoteHandler(app as any);

			const req = createMockReq({ path: "/note/Note" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res._jsonBody.suggestions.length).toBeLessThanOrEqual(5);
		});
	});

	// --- Ambiguity ---
	describe("ambiguous note resolution", () => {
		it("returns 300 when basename matches multiple files", async () => {
			const file1 = new TFile("1-Projects/TODO.md");
			const file2 = new TFile("4-Archive/TODO.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file1);
			app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
			app.metadataCache.getFileCache.mockReturnValue(null);
			app.vault.read.mockResolvedValue("some content");

			handler = new NoteHandler(app as any);

			const req = createMockReq({ path: "/note/TODO" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).toHaveBeenCalledWith(300);
			expect(res._jsonBody.errorCode).toBe(30060);
			expect(res._jsonBody.candidates).toEqual([
				expect.objectContaining({ path: "1-Projects/TODO.md" }),
				expect.objectContaining({ path: "4-Archive/TODO.md" }),
			]);
		});

		it("returns 300 when subpath matches multiple files", async () => {
			const file1 = new TFile("1-Projects/Sub/Note.md");
			const file2 = new TFile("2-Areas/Sub/Note.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file1);
			app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
			app.metadataCache.getFileCache.mockReturnValue(null);
			app.vault.read.mockResolvedValue("content");

			handler = new NoteHandler(app as any);

			const req = createMockReq({ path: "/note/Sub/Note" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).toHaveBeenCalledWith(300);
			expect(res._jsonBody.candidates).toHaveLength(2);
		});

		it("returns 300 when alias matches multiple files", async () => {
			const file1 = new TFile("a.md");
			const file2 = new TFile("b.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(null);
			app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
			app.metadataCache.getFileCache.mockImplementation((f: any) => ({
				frontmatter: { aliases: ["SharedAlias"] },
			}));
			app.vault.read.mockResolvedValue("alias content");

			handler = new NoteHandler(app as any);

			const req = createMockReq({ path: "/note/SharedAlias" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).toHaveBeenCalledWith(300);
			const paths = res._jsonBody.candidates.map((c: any) => c.path);
			expect(paths).toContain("a.md");
			expect(paths).toContain("b.md");
		});

		it("does not return 300 when only one file matches", async () => {
			const file = new TFile("notes/Unique.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.vault.getMarkdownFiles.mockReturnValue([file]);
			app.vault.adapter.readBinary.mockResolvedValue(
				new TextEncoder().encode("content").buffer
			);

			handler = new NoteHandler(app as any);

			const req = createMockReq({ path: "/note/Unique" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).not.toHaveBeenCalledWith(300);
		});

		it("returns 300 on PUT when ambiguous", async () => {
			const file1 = new TFile("a/Note.md");
			const file2 = new TFile("b/Note.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file1);
			app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
			app.metadataCache.getFileCache.mockReturnValue(null);
			app.vault.read.mockResolvedValue("content");

			handler = new NoteHandler(app as any);

			const req = createMockReq({ path: "/note/Note", body: "content" });
			const res = createMockRes();
			await handler.handlePut(req, res);

			expect(res.status).toHaveBeenCalledWith(300);
		});

		it("returns 300 on DELETE when ambiguous", async () => {
			const file1 = new TFile("a/Note.md");
			const file2 = new TFile("b/Note.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file1);
			app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
			app.metadataCache.getFileCache.mockReturnValue(null);
			app.vault.read.mockResolvedValue("content");

			handler = new NoteHandler(app as any);

			const req = createMockReq({ path: "/note/Note" });
			const res = createMockRes();
			await handler.handleDelete(req, res);

			expect(res.status).toHaveBeenCalledWith(300);
			expect(app.vault.adapter.remove).not.toHaveBeenCalled();
		});

		it("includes both basename and alias matches in candidates", async () => {
			const file1 = new TFile("notes/RealName.md");
			const file2 = new TFile("other/Different.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file1);
			app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
			app.metadataCache.getFileCache.mockImplementation((f: any) => {
				if (f.path === "other/Different.md")
					return { frontmatter: { aliases: ["RealName"] } };
				return null;
			});
			app.vault.read.mockResolvedValue("content");

			handler = new NoteHandler(app as any);

			const req = createMockReq({ path: "/note/RealName" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).toHaveBeenCalledWith(300);
			const paths = res._jsonBody.candidates.map((c: any) => c.path);
			expect(paths).toContain("notes/RealName.md");
			expect(paths).toContain("other/Different.md");
		});
	});

	// --- Smart Disambiguation ---
	describe("smart disambiguation", () => {
		it("auto-resolves when only one candidate has the target heading", async () => {
			const file1 = new TFile("1-Projects/TODO.md");
			const file2 = new TFile("4-Archive/TODO.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file1);
			app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
			app.metadataCache.getFileCache.mockReturnValue(null);
			app.vault.read.mockImplementation(async (f: any) => {
				if (f.path === "1-Projects/TODO.md")
					return "# Tasks\nDo stuff\n";
				return "# Other\nNo tasks here\n";
			});
			app.vault.adapter.readBinary.mockResolvedValue(
				new TextEncoder().encode("# Tasks\nDo stuff\n").buffer
			);

			handler = new NoteHandler(app as any);

			const req = createMockReq({
				path: "/note/TODO",
				headers: {
					"Target-Type": "heading",
					Target: "Tasks",
				},
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).not.toHaveBeenCalledWith(300);
			expect(res.set).toHaveBeenCalledWith(
				"Content-Location",
				"1-Projects/TODO.md"
			);
		});

		it("auto-resolves when only one candidate has the target block", async () => {
			const file1 = new TFile("a/Note.md");
			const file2 = new TFile("b/Note.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file1);
			app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
			app.metadataCache.getFileCache.mockReturnValue(null);
			app.vault.read.mockImplementation(async (f: any) => {
				if (f.path === "b/Note.md")
					return "A paragraph. ^myblock\n";
				return "No blocks here.\n";
			});

			handler = new NoteHandler(app as any);

			const req = createMockReq({
				path: "/note/Note",
				headers: {
					"Target-Type": "block",
					Target: "myblock",
				},
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).not.toHaveBeenCalledWith(300);
			expect(res.set).toHaveBeenCalledWith(
				"Content-Location",
				"b/Note.md"
			);
		});

		it("returns 300 with matchingTargets when multiple candidates have the target", async () => {
			const file1 = new TFile("a/Note.md");
			const file2 = new TFile("b/Note.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file1);
			app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
			app.metadataCache.getFileCache.mockReturnValue(null);
			app.vault.read.mockResolvedValue("# Tasks\nSome tasks\n");

			handler = new NoteHandler(app as any);

			const req = createMockReq({
				path: "/note/Note",
				headers: {
					"Target-Type": "heading",
					Target: "Tasks",
				},
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).toHaveBeenCalledWith(300);
			for (const candidate of res._jsonBody.candidates) {
				expect(candidate.matchingTargets).toEqual(["Tasks"]);
			}
		});

		it("returns 300 with empty matchingTargets when no candidates have the target", async () => {
			const file1 = new TFile("a/Note.md");
			const file2 = new TFile("b/Note.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file1);
			app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
			app.metadataCache.getFileCache.mockReturnValue(null);
			app.vault.read.mockResolvedValue("# Other\nNo match\n");

			handler = new NoteHandler(app as any);

			const req = createMockReq({
				path: "/note/Note",
				headers: {
					"Target-Type": "heading",
					Target: "NonExistent",
				},
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).toHaveBeenCalledWith(300);
			for (const candidate of res._jsonBody.candidates) {
				expect(candidate.matchingTargets).toEqual([]);
			}
		});

		it("omits matchingTargets when no Target-Type header is sent", async () => {
			const file1 = new TFile("a/Note.md");
			const file2 = new TFile("b/Note.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file1);
			app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
			app.metadataCache.getFileCache.mockReturnValue(null);
			app.vault.read.mockResolvedValue("content");

			handler = new NoteHandler(app as any);

			const req = createMockReq({ path: "/note/Note" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).toHaveBeenCalledWith(300);
			for (const candidate of res._jsonBody.candidates) {
				expect(candidate.path).toBeDefined();
				expect(candidate.preview).toBeDefined();
				expect(candidate).not.toHaveProperty("matchingTargets");
			}
		});

		it("truncates preview to 200 characters", async () => {
			const file1 = new TFile("a/Note.md");
			const file2 = new TFile("b/Note.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file1);
			app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
			app.metadataCache.getFileCache.mockReturnValue(null);
			app.vault.read.mockResolvedValue("x".repeat(300));

			handler = new NoteHandler(app as any);

			const req = createMockReq({ path: "/note/Note" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).toHaveBeenCalledWith(300);
			for (const candidate of res._jsonBody.candidates) {
				expect(candidate.preview.length).toBeLessThanOrEqual(200);
			}
		});

		it("limits preview to 5 lines", async () => {
			const file1 = new TFile("a/Note.md");
			const file2 = new TFile("b/Note.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file1);
			app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
			app.metadataCache.getFileCache.mockReturnValue(null);
			const longContent = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join("\n");
			app.vault.read.mockResolvedValue(longContent);

			handler = new NoteHandler(app as any);

			const req = createMockReq({ path: "/note/Note" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).toHaveBeenCalledWith(300);
			for (const candidate of res._jsonBody.candidates) {
				const lineCount = candidate.preview.split("\n").length;
				expect(lineCount).toBeLessThanOrEqual(5);
			}
		});

		it("auto-resolves on PUT/PATCH with target when unique", async () => {
			const file1 = new TFile("a/Note.md");
			const file2 = new TFile("b/Note.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file1);
			app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
			app.metadataCache.getFileCache.mockReturnValue(null);
			app.vault.read.mockImplementation(async (f: any) => {
				if (f.path === "a/Note.md")
					return "# Tasks\nDo stuff\n";
				return "# Other\nNo tasks\n";
			});

			handler = new NoteHandler(app as any);

			const req = createMockReq({
				path: "/note/Note",
				body: "new content",
				headers: {
					"Target-Type": "heading",
					Target: "Tasks",
				},
			});
			const res = createMockRes();
			await handler.handlePut(req, res);

			expect(res.status).not.toHaveBeenCalledWith(300);
			expect(app.vault.adapter.write).toHaveBeenCalledWith(
				"a/Note.md",
				"new content"
			);
		});
	});

	// --- GET ---
	describe("handleGet", () => {
		it("returns raw markdown by default", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.vault.adapter.readBinary.mockResolvedValue(
				new TextEncoder().encode("# Hello").buffer
			);

			const req = createMockReq({ path: "/note/Test" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.set).toHaveBeenCalledWith(
				"Content-Location",
				"notes/Test.md"
			);
			expect(res.send).toHaveBeenCalled();
		});

		it("returns NoteJson when Accept header is set", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.metadataCache.getFileCache.mockReturnValue({
				frontmatter: { title: "Test" },
				tags: [{ tag: "#foo" }],
			});
			app.vault.cachedRead.mockResolvedValue("content");

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					accept: "application/vnd.olrapi.note+json",
				},
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.setHeader).toHaveBeenCalledWith(
				"Content-Type",
				"application/vnd.olrapi.note+json"
			);
			const body = JSON.parse(res._body);
			expect(body.path).toBe("notes/Test.md");
			expect(body.tags).toContain("foo");
		});

		it("sets Content-Location header", async () => {
			const file = new TFile("some/path/Note.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.vault.adapter.readBinary.mockResolvedValue(new ArrayBuffer(0));

			const req = createMockReq({ path: "/note/Note" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.set).toHaveBeenCalledWith(
				"Content-Location",
				"some/path/Note.md"
			);
		});
	});

	// --- GET with Target-Type (section extraction) ---
	describe("handleGet with Target-Type", () => {
		const markdownContent = [
			"# Intro",
			"Some intro text.",
			"# Details",
			"Detail content here.",
			"# Summary",
			"Summary content.",
		].join("\n");

		it("returns heading section as markdown", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.vault.read.mockResolvedValue(markdownContent);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					"Target-Type": "heading",
					Target: "Details",
				},
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.send).toHaveBeenCalled();
			const body = res._body;
			expect(body).toContain("Detail content here.");
			expect(body).not.toContain("Summary content.");
		});

		it("returns heading section in NoteJson mode", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.metadataCache.getFileCache.mockReturnValue({
				frontmatter: {},
			});
			app.vault.cachedRead.mockResolvedValue(markdownContent);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					accept: "application/vnd.olrapi.note+json",
					"Target-Type": "heading",
					Target: "Details",
				},
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			const body = JSON.parse(res._body);
			expect(body.content).toContain("Detail content here.");
			expect(body.content).not.toContain("Summary content.");
		});

		it("returns nested heading via delimiter", async () => {
			const nested = [
				"# Parent",
				"Parent text.",
				"## Child",
				"Child text.",
			].join("\n");
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.vault.read.mockResolvedValue(nested);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					"Target-Type": "heading",
					Target: "Parent::Child",
				},
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			const body = res._body;
			expect(body).toContain("Child text.");
		});

		it("returns 404 when heading not found", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.vault.read.mockResolvedValue(markdownContent);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					"Target-Type": "heading",
					Target: "NonExistent",
				},
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).toHaveBeenCalledWith(404);
			expect(res._jsonBody.errorCode).toBe(40463);
		});

		it("returns block section", async () => {
			const blockContent = "A paragraph with a reference. ^myblock\n";
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.vault.read.mockResolvedValue(blockContent);

			const req = createMockReq({
				path: "/note/Test",
				headers: {
					"Target-Type": "block",
					Target: "myblock",
				},
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.send).toHaveBeenCalled();
			expect(res._body).toContain("A paragraph with a reference.");
		});
	});

	// --- PUT ---
	describe("handlePut", () => {
		it("writes string body", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);

			const req = createMockReq({
				path: "/note/Test",
				body: "new content",
			});
			const res = createMockRes();
			await handler.handlePut(req, res);

			expect(app.vault.adapter.write).toHaveBeenCalledWith(
				"notes/Test.md",
				"new content"
			);
			expect(res.status).toHaveBeenCalledWith(204);
		});

		it("writes binary body", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);

			const buf = Buffer.from("binary data");
			const req = createMockReq({
				path: "/note/Test",
				body: buf,
			});
			const res = createMockRes();
			await handler.handlePut(req, res);

			expect(app.vault.adapter.writeBinary).toHaveBeenCalled();
			expect(res.status).toHaveBeenCalledWith(204);
		});

		it("returns 400 for invalid body type", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);

			const req = createMockReq({
				path: "/note/Test",
				body: { invalid: true },
			});
			const res = createMockRes();
			await handler.handlePut(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res._jsonBody.errorCode).toBe(40010);
		});

		it("returns 404 for unknown note", async () => {
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(null);

			const req = createMockReq({ path: "/note/Missing" });
			const res = createMockRes();
			await handler.handlePut(req, res);

			expect(res.status).toHaveBeenCalledWith(404);
		});
	});

	// --- POST ---
	describe("handlePost", () => {
		it("appends with newline when file doesn't end with one", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.vault.read.mockResolvedValue("existing content");

			const req = createMockReq({
				path: "/note/Test",
				body: "appended",
			});
			const res = createMockRes();
			await handler.handlePost(req, res);

			expect(app.vault.adapter.write).toHaveBeenCalledWith(
				"notes/Test.md",
				"existing content\nappended"
			);
			expect(res.status).toHaveBeenCalledWith(204);
		});

		it("appends without extra newline when file ends with one", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.vault.read.mockResolvedValue("existing\n");

			const req = createMockReq({
				path: "/note/Test",
				body: "appended",
			});
			const res = createMockRes();
			await handler.handlePost(req, res);

			expect(app.vault.adapter.write).toHaveBeenCalledWith(
				"notes/Test.md",
				"existing\nappended"
			);
		});

		it("returns 400 for non-string body", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);

			const req = createMockReq({
				path: "/note/Test",
				body: { object: true },
			});
			const res = createMockRes();
			await handler.handlePost(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res._jsonBody.errorCode).toBe(40010);
		});
	});

	// --- DELETE ---
	describe("handleDelete", () => {
		it("removes the file and returns 204", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);

			const req = createMockReq({ path: "/note/Test" });
			const res = createMockRes();
			await handler.handleDelete(req, res);

			expect(app.vault.adapter.remove).toHaveBeenCalledWith(
				"notes/Test.md"
			);
			expect(res.status).toHaveBeenCalledWith(204);
		});

		it("returns 404 for unknown note", async () => {
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(null);

			const req = createMockReq({ path: "/note/Missing" });
			const res = createMockRes();
			await handler.handleDelete(req, res);

			expect(res.status).toHaveBeenCalledWith(404);
		});
	});

	// --- getFileMetadata / NoteJson ---
	describe("getFileMetadata / NoteJson", () => {
		it("deduplicates tags appearing in both frontmatter and inline", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.metadataCache.getFileCache.mockReturnValue({
				frontmatter: { tags: ["shared"] },
				tags: [{ tag: "#shared" }],
			});
			app.vault.cachedRead.mockResolvedValue("content");

			const req = createMockReq({
				path: "/note/Test",
				headers: { accept: "application/vnd.olrapi.note+json" },
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			const body = JSON.parse(res._body);
			expect(body.tags).toEqual(["shared"]);
		});

		it("strips # prefix from inline tags", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.metadataCache.getFileCache.mockReturnValue({
				frontmatter: {},
				tags: [{ tag: "#inlineTag" }, { tag: "#another" }],
			});
			app.vault.cachedRead.mockResolvedValue("content");

			const req = createMockReq({
				path: "/note/Test",
				headers: { accept: "application/vnd.olrapi.note+json" },
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			const body = JSON.parse(res._body);
			expect(body.tags).toEqual(["inlineTag", "another"]);
		});

		it("returns empty tags array when no tags exist", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.metadataCache.getFileCache.mockReturnValue({
				frontmatter: {},
			});
			app.vault.cachedRead.mockResolvedValue("content");

			const req = createMockReq({
				path: "/note/Test",
				headers: { accept: "application/vnd.olrapi.note+json" },
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			const body = JSON.parse(res._body);
			expect(body.tags).toEqual([]);
		});

		it("strips position from frontmatter", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.metadataCache.getFileCache.mockReturnValue({
				frontmatter: {
					title: "Test",
					position: { start: { line: 0 }, end: { line: 3 } },
				},
			});
			app.vault.cachedRead.mockResolvedValue("content");

			const req = createMockReq({
				path: "/note/Test",
				headers: { accept: "application/vnd.olrapi.note+json" },
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			const body = JSON.parse(res._body);
			expect(body.frontmatter.title).toBe("Test");
			expect(body.frontmatter.position).toBeUndefined();
		});

		it("handles frontmatter.tags as non-array (single string tag)", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.metadataCache.getFileCache.mockReturnValue({
				frontmatter: { tags: "solo-tag" },
			});
			app.vault.cachedRead.mockResolvedValue("content");

			const req = createMockReq({
				path: "/note/Test",
				headers: { accept: "application/vnd.olrapi.note+json" },
			});
			const res = createMockRes();
			await handler.handleGet(req, res);

			const body = JSON.parse(res._body);
			expect(body.tags).toEqual(["solo-tag"]);
		});
	});

	// --- Move ---
	describe("handleMove", () => {
		it("renames file and returns new path", async () => {
			const file = new TFile("old/path.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);

			const req = createMockReq({
				path: "/note-move/",
				body: { from: "OldNote", to: "new/path.md" },
			});
			const res = createMockRes();
			await handler.handleMove(req, res);

			expect(app.fileManager.renameFile).toHaveBeenCalledWith(
				file,
				"new/path.md"
			);
			expect(res.status).toHaveBeenCalledWith(200);
			expect(res._jsonBody).toEqual({
				from: "old/path.md",
				to: "new/path.md",
			});
		});

		it("appends .md extension if missing", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);

			const req = createMockReq({
				path: "/note-move/",
				body: { from: "Test", to: "archive/Test" },
			});
			const res = createMockRes();
			await handler.handleMove(req, res);

			expect(app.fileManager.renameFile).toHaveBeenCalledWith(
				file,
				"archive/Test.md"
			);
		});

		it("returns 400 when from/to are missing", async () => {
			const req = createMockReq({
				path: "/note-move/",
				body: { from: "Test" },
			});
			const res = createMockRes();
			await handler.handleMove(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res._jsonBody.errorCode).toBe(40020);
		});

		it("creates destination directory if it doesn't exist", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.vault.adapter.exists.mockResolvedValue(false);

			const req = createMockReq({
				path: "/note-move/",
				body: { from: "Test", to: "new/nested/dir/Test.md" },
			});
			const res = createMockRes();
			await handler.handleMove(req, res);

			expect(app.vault.adapter.exists).toHaveBeenCalledWith("new/nested/dir");
			expect(app.vault.createFolder).toHaveBeenCalledWith("new/nested/dir");
			expect(app.fileManager.renameFile).toHaveBeenCalledWith(
				file,
				"new/nested/dir/Test.md"
			);
			expect(res.status).toHaveBeenCalledWith(200);
		});

		it("does not create directory if it already exists", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);
			app.vault.adapter.exists.mockResolvedValue(true);

			const req = createMockReq({
				path: "/note-move/",
				body: { from: "Test", to: "existing/dir/Test.md" },
			});
			const res = createMockRes();
			await handler.handleMove(req, res);

			expect(app.vault.adapter.exists).toHaveBeenCalledWith("existing/dir");
			expect(app.vault.createFolder).not.toHaveBeenCalled();
		});

		it("skips directory creation for root-level moves", async () => {
			const file = new TFile("notes/Test.md");
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(file);

			const req = createMockReq({
				path: "/note-move/",
				body: { from: "Test", to: "Test.md" },
			});
			const res = createMockRes();
			await handler.handleMove(req, res);

			expect(app.vault.adapter.exists).not.toHaveBeenCalled();
			expect(app.vault.createFolder).not.toHaveBeenCalled();
		});

		it("returns 404 when source not found", async () => {
			app.metadataCache.getFirstLinkpathDest.mockReturnValue(null);

			const req = createMockReq({
				path: "/note-move/",
				body: { from: "Missing", to: "dest" },
			});
			const res = createMockRes();
			await handler.handleMove(req, res);

			expect(res.status).toHaveBeenCalledWith(404);
		});
	});
});

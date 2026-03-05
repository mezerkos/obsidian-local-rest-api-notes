import { describe, it, expect, beforeEach } from "vitest";
import { AliasCache } from "../main";
import { TFile, createMockApp } from "../mocks/obsidian";

describe("AliasCache", () => {
	let app: ReturnType<typeof createMockApp>;
	let cache: AliasCache;

	beforeEach(() => {
		app = createMockApp();
		cache = new AliasCache(app as any);
	});

	it("returns null for unknown alias", () => {
		app.vault.getMarkdownFiles.mockReturnValue([]);
		expect(cache.resolve("nonexistent")).toBeNull();
	});

	it("resolves an alias (case-insensitive)", () => {
		const file = new TFile("notes/Hello World.md");
		app.vault.getMarkdownFiles.mockReturnValue([file]);
		app.metadataCache.getFileCache.mockReturnValue({
			frontmatter: { aliases: ["HW", "Hello"] },
		});

		expect(cache.resolve("hw")).toBe(file);
		expect(cache.resolve("HW")).toBe(file);
		expect(cache.resolve("hello")).toBe(file);
	});

	it("handles multiple aliases per file", () => {
		const file = new TFile("a.md");
		app.vault.getMarkdownFiles.mockReturnValue([file]);
		app.metadataCache.getFileCache.mockReturnValue({
			frontmatter: { aliases: ["Alpha", "Beta", "Gamma"] },
		});

		expect(cache.resolve("alpha")).toBe(file);
		expect(cache.resolve("beta")).toBe(file);
		expect(cache.resolve("gamma")).toBe(file);
	});

	it("handles files with no aliases", () => {
		const file = new TFile("plain.md");
		app.vault.getMarkdownFiles.mockReturnValue([file]);
		app.metadataCache.getFileCache.mockReturnValue({
			frontmatter: {},
		});

		expect(cache.resolve("plain")).toBeNull();
	});

	it("incrementally updates on metadata change", () => {
		const file = new TFile("x.md");
		app.vault.getMarkdownFiles.mockReturnValue([file]);
		app.metadataCache.getFileCache.mockReturnValue({
			frontmatter: { aliases: ["OldAlias"] },
		});

		// Force initial build
		expect(cache.resolve("oldalias")).toBe(file);

		// Simulate metadata change
		app.metadataCache.getFileCache.mockReturnValue({
			frontmatter: { aliases: ["NewAlias"] },
		});
		app.metadataCache._trigger("changed", file);

		expect(cache.resolve("oldalias")).toBeNull();
		expect(cache.resolve("newalias")).toBe(file);
	});

	it("removes aliases when file is deleted", () => {
		const file = new TFile("doomed.md");
		app.vault.getMarkdownFiles.mockReturnValue([file]);
		app.metadataCache.getFileCache.mockReturnValue({
			frontmatter: { aliases: ["RIP"] },
		});

		expect(cache.resolve("rip")).toBe(file);

		app.vault._trigger("delete", file);

		expect(cache.resolve("rip")).toBeNull();
	});

	it("updates aliases on rename", () => {
		const file = new TFile("old-name.md");
		app.vault.getMarkdownFiles.mockReturnValue([file]);
		app.metadataCache.getFileCache.mockReturnValue({
			frontmatter: { aliases: ["MyAlias"] },
		});

		expect(cache.resolve("myalias")).toBe(file);

		// Simulate rename
		const renamedFile = new TFile("new-name.md");
		app.metadataCache.getFileCache.mockReturnValue({
			frontmatter: { aliases: ["MyAlias"] },
		});
		app.vault._trigger("rename", renamedFile, "old-name.md");

		expect(cache.resolve("myalias")).toBe(renamedFile);
	});

	it("entries() returns all alias-to-file mappings", () => {
		const file1 = new TFile("a.md");
		const file2 = new TFile("b.md");
		app.vault.getMarkdownFiles.mockReturnValue([file1, file2]);
		app.metadataCache.getFileCache.mockImplementation((f: TFile) => {
			if (f.path === "a.md")
				return { frontmatter: { aliases: ["Aaa"] } };
			if (f.path === "b.md")
				return { frontmatter: { aliases: ["Bbb", "Ccc"] } };
			return null;
		});

		const entries = [...cache.entries()];
		expect(entries).toHaveLength(3);
		const keys = entries.map(([k]) => k);
		expect(keys).toContain("aaa");
		expect(keys).toContain("bbb");
		expect(keys).toContain("ccc");
	});
});

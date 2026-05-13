import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { PeriodicNoteHandler, NoteHandler } from "../main";
import { TFile, createMockApp } from "../mocks/obsidian";
import { createMockReq, createMockRes } from "../mocks/express";
import * as DailyNotesInterface from "obsidian-daily-notes-interface";

describe("PeriodicNoteHandler", () => {
	let app: ReturnType<typeof createMockApp>;
	let noteHandler: NoteHandler;
	let handler: PeriodicNoteHandler;
	let mockMoment: any;

	beforeEach(() => {
		// Reset all mocks first
		vi.clearAllMocks();

		app = createMockApp();
		app.vault.getMarkdownFiles.mockReturnValue([]);
		noteHandler = new NoteHandler(app as any, () => ({ maxReplaceRatio: 0.5 }));
		handler = new PeriodicNoteHandler(app as any, noteHandler);

		// Setup moment mock
		mockMoment = (input?: any, format?: string) => {
			const date = input ? new Date(input) : new Date("2024-01-15");
			return {
				isValid: () => !isNaN(date.getTime()),
				year: () => date.getFullYear(),
				month: () => date.getMonth(),
				format: (fmt: string) => {
					if (fmt === "YYYY-MM-DD") {
						return date.toISOString().split("T")[0];
					}
					if (fmt === "YYYY-[W]WW") {
						return "2024-W03";
					}
					if (fmt === "YYYY-MM") {
						return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
					}
					if (fmt === "YYYY") {
						return String(date.getFullYear());
					}
					return date.toISOString().split("T")[0];
				},
				add: vi.fn(function (amount: number, unit: string) {
					return this;
				}),
			};
		};
		(global as any).window = { moment: mockMoment };
	});

	afterEach(() => {
		delete (global as any).window;
	});

	describe("plugin availability", () => {
		it("returns 400 when neither Daily Notes nor Periodic Notes plugin is enabled", async () => {
			// No plugins enabled
			vi.mocked(DailyNotesInterface.appHasDailyNotesPluginLoaded).mockReturnValue(false);
			app.plugins.plugins = {};

			const req = createMockReq({ path: "/periodic-note/daily/" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res._jsonBody.errorCode).toBe(40002);
			expect(res._jsonBody.message).toContain("Neither Daily Notes nor Periodic Notes");
		});
	});

	describe("Bug fix: uses obsidian-daily-notes-interface", () => {
		it("should NOT call getAllDailyNotes on periodic-notes plugin object", async () => {
			// This test verifies the bug fix
			// The periodic-notes plugin object does NOT have getAllDailyNotes method
			// The code should use obsidian-daily-notes-interface instead

			vi.mocked(DailyNotesInterface.appHasDailyNotesPluginLoaded).mockReturnValue(false);
			// Periodic notes plugin exists but doesn't have the methods
			// (this was the bug - code was trying to call methods on this object)
			app.plugins.plugins = {
				"periodic-notes": {
					settings: {},
				},
			};

			const req = createMockReq({ path: "/periodic-note/daily/" });
			const res = createMockRes();

			// This should NOT throw "getAllDailyNotes is not a function"
			// because we should be using the interface, not the plugin object
			await handler.handleGet(req, res);

			// If the bug exists, this would have thrown an error
			// With the fix, it should return 404 (note not found) or 200
			expect(res.statusCode).toBeDefined();
		});

		it("uses getAllDailyNotes from obsidian-daily-notes-interface", async () => {
			vi.mocked(DailyNotesInterface.appHasDailyNotesPluginLoaded).mockReturnValue(true);
			app.plugins.plugins = {};

			const file = new TFile("daily/2024-01-15.md");
			vi.mocked(DailyNotesInterface.getAllDailyNotes).mockReturnValue({ "2024-01-15": file });
			vi.mocked(DailyNotesInterface.getDailyNote).mockReturnValue(file);
			app.vault.cachedRead.mockResolvedValue("test content");

			const req = createMockReq({ path: "/periodic-note/daily/" });
			const res = createMockRes();
			await handler.handleGet(req, res);

			// Verify the interface functions were called, not plugin methods
			expect(DailyNotesInterface.getAllDailyNotes).toHaveBeenCalled();
			expect(DailyNotesInterface.getDailyNote).toHaveBeenCalled();
		});
	});
});

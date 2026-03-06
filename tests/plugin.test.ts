import { describe, it, expect, beforeEach, vi } from "vitest";
import NoteApiExtensionPlugin from "../main";
import { createMockApp } from "../mocks/obsidian";

describe("NoteApiExtensionPlugin", () => {
	let app: ReturnType<typeof createMockApp>;
	let plugin: NoteApiExtensionPlugin;

	beforeEach(() => {
		app = createMockApp();
		app.vault.getMarkdownFiles.mockReturnValue([]);
		plugin = new NoteApiExtensionPlugin();
		plugin.app = app as any;
		plugin.manifest = { id: "obsidian-local-rest-api-notes" } as any;
	});

	/** Helper to access private api field */
	function getPluginApi(): any {
		return (plugin as any).api;
	}

	describe("onload", () => {
		it("calls registerRoutes immediately when REST API plugin is already enabled", async () => {
			app.plugins.enabledPlugins.add("obsidian-local-rest-api");
			const spy = vi.spyOn(plugin, "registerRoutes");

			await plugin.onload();

			expect(spy).toHaveBeenCalledOnce();
		});

		it("registers workspace event listener for deferred loading when REST API is not enabled", async () => {
			await plugin.onload();

			expect(app.workspace.on).toHaveBeenCalledWith(
				"obsidian-local-rest-api:loaded",
				expect.any(Function)
			);
		});

		it("does not call registerRoutes immediately when REST API is not enabled", async () => {
			const spy = vi.spyOn(plugin, "registerRoutes");

			await plugin.onload();

			expect(spy).not.toHaveBeenCalled();
		});
	});

	describe("registerRoutes", () => {
		it("registers /note/*, /note-move/, and /note-api.yaml routes", () => {
			plugin.registerRoutes();

			const api = getPluginApi();
			expect(api).toBeDefined();
			expect(api.addRoute).toHaveBeenCalledWith("/note/*");
			expect(api.addRoute).toHaveBeenCalledWith("/note-move/");
			expect(api.addRoute).toHaveBeenCalledWith("/note-api.yaml");
		});

		it("registers all HTTP methods on /note/* route", () => {
			plugin.registerRoutes();

			const api = getPluginApi();
			// addRoute returns a chainable route handler; all calls share the same mock
			const routeChain = api.addRoute.mock.results[0].value;
			expect(routeChain.get).toHaveBeenCalled();
			expect(routeChain.put).toHaveBeenCalled();
			expect(routeChain.post).toHaveBeenCalled();
			expect(routeChain.patch).toHaveBeenCalled();
			expect(routeChain.delete).toHaveBeenCalled();
		});
	});

	describe("onunload", () => {
		it("calls api.unregister() when api exists", () => {
			plugin.registerRoutes();
			const api = getPluginApi();

			plugin.onunload();

			expect(api.unregister).toHaveBeenCalledOnce();
		});

		it("is safe when api is undefined (plugin never loaded)", () => {
			expect(() => plugin.onunload()).not.toThrow();
		});
	});

	describe("/note-api.yaml route handler", () => {
		it("serves yaml with correct content type", () => {
			plugin.registerRoutes();

			const api = getPluginApi();
			const routeChain = api.addRoute.mock.results[0].value;

			// .get() is called twice: first for /note/*, second for /note-api.yaml
			const yamlHandler = routeChain.get.mock.calls[1][0];

			const mockRes: any = {
				set: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			};
			yamlHandler({}, mockRes);

			expect(mockRes.set).toHaveBeenCalledWith(
				"Content-Type",
				"text/yaml; charset=utf-8"
			);
			expect(mockRes.send).toHaveBeenCalled();
			const sentContent = mockRes.send.mock.calls[0][0];
			expect(typeof sentContent).toBe("string");
			expect(sentContent).toContain("openapi");
		});
	});
});

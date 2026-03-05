import { vi } from "vitest";

export interface LocalRestApiPublicApi {
	addRoute(path: string): any;
	unregister(): void;
}

export function getAPI(_app: any, _manifest: any): LocalRestApiPublicApi {
	const routeHandler = {
		get: vi.fn().mockReturnThis(),
		put: vi.fn().mockReturnThis(),
		post: vi.fn().mockReturnThis(),
		patch: vi.fn().mockReturnThis(),
		delete: vi.fn().mockReturnThis(),
	};

	return {
		addRoute: vi.fn(() => routeHandler),
		unregister: vi.fn(),
	};
}

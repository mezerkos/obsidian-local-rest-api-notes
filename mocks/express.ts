import { vi } from "vitest";

export function createMockReq(overrides: Record<string, any> = {}) {
	const headers: Record<string, string> = overrides.headers || {};
	return {
		path: overrides.path || "/note/Test",
		body: overrides.body ?? "",
		headers: {
			accept: "text/markdown",
			...headers,
		},
		get(name: string): string | undefined {
			// Express req.get is case-insensitive
			const lower = name.toLowerCase();
			for (const [key, value] of Object.entries(this.headers)) {
				if (key.toLowerCase() === lower) return value;
			}
			return undefined;
		},
		...overrides,
	};
}

export function createMockRes() {
	const res: any = {
		statusCode: 200,
		headersSent: false,
		_headers: {} as Record<string, string>,
		_body: undefined as any,
		_jsonBody: undefined as any,
	};

	res.status = vi.fn((code: number) => {
		res.statusCode = code;
		return res;
	});
	res.json = vi.fn((body: any) => {
		res._jsonBody = body;
		res._body = JSON.stringify(body);
		return res;
	});
	res.send = vi.fn((body?: any) => {
		if (body !== undefined) res._body = body;
		return res;
	});
	res.set = vi.fn((nameOrObj: any, value?: string) => {
		if (typeof nameOrObj === "string") {
			res._headers[nameOrObj] = value!;
		} else {
			Object.assign(res._headers, nameOrObj);
		}
		return res;
	});
	res.setHeader = vi.fn((name: string, value: string) => {
		res._headers[name] = value;
		return res;
	});
	res.header = vi.fn((name: string, value: string) => {
		res._headers[name] = value;
		return res;
	});

	return res;
}

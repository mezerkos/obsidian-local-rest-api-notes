import { describe, it, expect, vi } from "vitest";
import { asyncHandler } from "../main";
import { createMockRes } from "../mocks/express";

describe("asyncHandler", () => {
	it("invokes the wrapped async handler", async () => {
		const handler = vi.fn(async (_req: any, res: any) => {
			res.status(200).send("ok");
		});
		const wrapped = asyncHandler(handler);
		const res = createMockRes();

		wrapped({}, res);
		// Wait for the microtask to flush
		await new Promise((r) => setTimeout(r, 0));

		expect(handler).toHaveBeenCalledOnce();
		expect(res.statusCode).toBe(200);
	});

	it("sends 500 on unhandled error", async () => {
		const handler = vi.fn(async () => {
			throw new Error("boom");
		});
		const wrapped = asyncHandler(handler);
		const res = createMockRes();
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		wrapped({}, res);
		await new Promise((r) => setTimeout(r, 0));

		expect(res.status).toHaveBeenCalledWith(500);
		expect(res._jsonBody).toEqual({
			message: "boom",
		});
		consoleSpy.mockRestore();
	});

	it("skips response when headers already sent", async () => {
		const handler = vi.fn(async () => {
			throw new Error("boom");
		});
		const wrapped = asyncHandler(handler);
		const res = createMockRes();
		res.headersSent = true;
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		wrapped({}, res);
		await new Promise((r) => setTimeout(r, 0));

		expect(res.status).not.toHaveBeenCalled();
		consoleSpy.mockRestore();
	});
});

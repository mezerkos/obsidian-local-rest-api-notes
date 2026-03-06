import { describe, it, expect } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import { resolve } from "path";

const OPENAPI_PATH = resolve(__dirname, "../openapi.yaml");

const V2_PARAM_NAMES = [
	"Heading",
	"Heading-Boundary",
	"Content-Insertion-Position",
	"Content-Insertion-Ignore-Newline",
];

const V3_PARAM_NAMES = [
	"Operation",
	"Target-Type",
	"Target",
	"Target-Delimiter",
	"Trim-Target-Whitespace",
	"Create-Target-If-Missing",
	"Apply-If-Content-Preexists",
];

describe("OpenAPI spec", () => {
	it("is a valid OpenAPI 3.0 spec", async () => {
		const api = await SwaggerParser.validate(OPENAPI_PATH);
		expect(api.openapi).toMatch(/^3\.0/);
	});

	it("does not contain V2 parameters", async () => {
		const api = await SwaggerParser.dereference(OPENAPI_PATH);
		const patchOp = (api as any).paths["/note/{noteName}"]?.patch;
		expect(patchOp).toBeDefined();

		const paramNames = (patchOp.parameters || []).map(
			(p: any) => p.name
		);
		for (const v2Param of V2_PARAM_NAMES) {
			expect(paramNames).not.toContain(v2Param);
		}
	});

	it("contains V3 parameters", async () => {
		const api = await SwaggerParser.dereference(OPENAPI_PATH);
		const patchOp = (api as any).paths["/note/{noteName}"]?.patch;
		const paramNames = (patchOp.parameters || []).map(
			(p: any) => p.name
		);

		for (const v3Param of V3_PARAM_NAMES) {
			expect(paramNames).toContain(v3Param);
		}
	});
});

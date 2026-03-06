import { defineConfig } from "vitest/config";
import { readFileSync } from "fs";
import { resolve } from "path";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
	},
	resolve: {
		extensions: [".ts", ".js", ".mjs", ".json"],
		alias: {
			obsidian: resolve(__dirname, "mocks/obsidian.ts"),
			"obsidian-local-rest-api": resolve(
				__dirname,
				"mocks/obsidian-local-rest-api.ts"
			),
		},
	},
	plugins: [
		{
			name: "yaml-text-loader",
			transform(code, id) {
				if (id.endsWith(".yaml")) {
					const content = readFileSync(id, "utf-8");
					return {
						code: `export default ${JSON.stringify(content)};`,
						map: null,
					};
				}
			},
		},
	],
});

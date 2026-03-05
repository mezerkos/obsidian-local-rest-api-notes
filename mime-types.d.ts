declare module "mime-types" {
	export function lookup(path: string): string | false;
	const _default: { lookup: typeof lookup };
	export default _default;
}

declare module "*.yaml" {
	const content: string;
	export default content;
}

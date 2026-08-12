const STUB = `
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env } }
export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env } }
export const env = {};
export function connect() { throw new Error('stub') }
export default {};
`
export function resolve(specifier, context, next) {
	if (specifier.startsWith("cloudflare:")) return { shortCircuit: true, url: "stub:" + specifier }
	return next(specifier, context)
}
export function load(url, context, next) {
	if (url.startsWith("stub:")) return { shortCircuit: true, format: "module", source: STUB }
	return next(url, context)
}

// Stub for the `cloudflare:workers` virtual module so it can be imported in the
// node/vitest environment. Only `DurableObject` and `WorkflowEntrypoint` are
// needed — the modules in `@maple/effect-cloudflare` that statically import
// them are never exercised at runtime in unit tests (bindings are layered in).
//
// `DurableObject` keeps `ctx`/`env` because `ChatSession` uses both: `ctx.storage.sql` for the
// event log and `ctx.waitUntil` to own its own turn. `test/chat/fake-do-state.ts` hands it a real
// SQLite-backed `ctx`, so the class under test runs its actual SQL rather than a mock of it.
export class DurableObject<Env = unknown> {
	protected ctx: DurableObjectState
	protected env: Env

	constructor(ctx: DurableObjectState, env: Env) {
		this.ctx = ctx
		this.env = env
	}
}
export class WorkflowEntrypoint {}

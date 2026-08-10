// Stub for the `cloudflare:workers` virtual module so it can be imported in the
// node/vitest environment. Alongside `DurableObject` and `WorkflowEntrypoint`,
// this must export `env`: the real module always does, and `WorkerEnvironment`
// destructures it. Omitting it made the service yield `undefined` rather than an
// empty binding record, so the first consumer to read a binding off it (rather
// than layering one in) crashed with "Cannot read properties of undefined".
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

/** No bindings in node/vitest — tests layer in whatever they need. */
export const env: Record<string, unknown> = {}

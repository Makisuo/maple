// The worker env + `Config` surface: a `Context.Service` holding the Worker's
// `env`, the layers that source it, and the ConfigProvider built on it.
//
// This lived in `lib/effect-cloudflare` as hand-copied `alchemy-effect`
// modules, kept while that package was unpublished. `alchemy@2` ships them
// first-party (`WorkerEnvironment` and `WorkerConfigProvider` in
// `Cloudflare/Workers/{Worker,ConfigProvider}.ts`) — but they are not
// importable from a hand-written Worker entry:
//
//   alchemy's exports map has no entry finer than a directory
//   (`./Cloudflare/*` → `*/index.ts`), and the `Cloudflare/Workers` barrel
//   re-exports its provider and bundler modules (`Source.ts`,
//   `WorkerProvider.ts`, `LocalWorkerProvider.ts`) alongside the two runtime
//   services. Bundling that barrel pulls `fdir`, rolldown glue and Node
//   builtins — measured at 426 KB minified against 14 KB for the tag alone, and
//   `node:module` does not exist in workerd. Alchemy's own workers dodge this
//   because ITS bundler generates their entry, which is the class-form
//   `Cloudflare.Worker` migration, not this change.
//
// So the tag stays defined here — with alchemy's exact key. Effect resolves a
// service by that string, so this entry and alchemy's are the same service:
// anything later moved onto alchemy's Worker bridge keeps working, in either
// direction, with no call-site change.
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * The Worker's `env`, or an empty record outside a Worker isolate.
 *
 * The import is dynamic and its failure path resolves to `{}` so non-Worker
 * hosts (tsc, vitest outside miniflare) can load this module without crashing
 * on the bare specifier — bindings are simply absent there. `?? {}` covers the
 * other half: the service's type promises a record and consumers read bindings
 * straight off it, so a host whose module has no `env` (the vitest stub,
 * historically) would hand out `undefined` behind a non-nullable type, and the
 * first consumer to dereference a binding crashes instead of seeing "binding
 * absent".
 */
const workerEnv: Effect.Effect<Record<string, unknown>> = Effect.promise(() =>
	import("cloudflare:workers")
		.then(({ env }) => (env ?? {}) as Record<string, unknown>)
		.catch(() => ({}) as Record<string, unknown>),
)

/** @see alchemy's `WorkerEnvironment` — same key, so the same service. */
export class WorkerEnvironment extends Context.Service<WorkerEnvironment, Record<string, unknown>>()(
	"Cloudflare.Workers.WorkerEnvironment",
) {}

/** Source the env from the `cloudflare:workers` module. */
export const workerEnvironmentLayer: Layer.Layer<WorkerEnvironment> = Layer.effect(
	WorkerEnvironment,
	workerEnv,
)

/**
 * Alternative to {@link workerEnvironmentLayer} for cases where the caller
 * already has the env in hand (e.g. inside a Durable Object / Workflow
 * constructor, where CF passes env explicitly and the `cloudflare:workers`
 * global env may not reflect it).
 */
export const layerFromEnvRecord = (env: Record<string, unknown>): Layer.Layer<WorkerEnvironment> =>
	Layer.succeed(WorkerEnvironment, env)

/** A `ConfigProvider` reading the worker env. */
export const WorkerConfigProvider = (): Effect.Effect<ConfigProvider.ConfigProvider> =>
	Effect.map(workerEnv, ConfigProvider.fromUnknown)

/**
 * Sets Effect's ConfigProvider to read from the worker env, so
 * `Config.string("FOO")` — and anything downstream using Effect `Config` —
 * resolves against the runtime env without the worker passing env around.
 *
 * Alchemy's version additionally reifies the `{"_tag":"Redacted"}` markers its
 * deploy-time `Config` interceptor writes into the env. Maple binds plain vars
 * and secrets, so there is nothing to reify; that behaviour arrives with
 * alchemy's Worker resource, not by copying the function.
 */
export const WorkerConfigProviderLayer: Layer.Layer<never> = ConfigProvider.layer(WorkerConfigProvider())

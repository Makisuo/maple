// Inspired by alchemy-effect's `WorkerEnvironment` service (defined inside
// `packages/alchemy/src/Cloudflare/Workers/Worker.ts`). Copied here with the
// IaC machinery removed — we only need the runtime surface: a Context.Service
// holding the worker env, plus a Layer that reads it from
// `cloudflare:workers`.
//
// For future migration to alchemy-effect: the service tag name
// ("Cloudflare.WorkerEnvironment") matches upstream, so call sites that
// `yield* WorkerEnvironment` are source-compatible.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import cloudflareWorkers from "./cloudflare-workers.ts"

export class WorkerEnvironment extends Context.Service<WorkerEnvironment, Record<string, unknown>>()(
	"Cloudflare.Workers.WorkerEnvironment",
) {}

/**
 * Read the worker env from the `cloudflare:workers` global import. This is the
 * canonical way to source bindings at runtime. Outside a Worker isolate, the
 * dynamic import falls back to `{}` (see `cloudflare-workers.ts`), so this
 * layer is safe to provide even in test/local contexts — bindings will simply
 * be undefined.
 */
export const WorkerEnvironmentLive: Layer.Layer<WorkerEnvironment> = Layer.effect(
	WorkerEnvironment,
	cloudflareWorkers.pipe(Effect.map(({ env }) => env as Record<string, unknown>)),
)

/**
 * Alternative to `WorkerEnvironmentLive` for cases where the caller already
 * has the env in hand (e.g. inside a Durable Object / Workflow constructor,
 * where CF passes env explicitly and the `cloudflare:workers` global env
 * may not reflect it).
 */
export const layerFromEnvRecord = (env: Record<string, unknown>): Layer.Layer<WorkerEnvironment> =>
	Layer.succeed(WorkerEnvironment, env)

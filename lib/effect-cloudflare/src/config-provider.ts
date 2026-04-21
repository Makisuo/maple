// Copied from alchemy-effect to stay API-compatible for a future migration:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Workers/ConfigProvider.ts
//
// Produces an Effect ConfigProvider backed by the worker's env. Compose with
// `Layer.setConfigProvider(...)` to make `Config.string("FOO")` resolve from
// `env.FOO` inside an Effect workflow.
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import cloudflareWorkers from "./cloudflare-workers.ts"

export const WorkerConfigProvider = () =>
  cloudflareWorkers.pipe(
    Effect.map(({ env }) => ConfigProvider.fromUnknown(env)),
  )

/**
 * A Layer that sets Effect's ConfigProvider to read from the `cloudflare:workers`
 * env. Compose this into a worker's main layer so `Config.string("FOO")` —
 * and anything downstream that uses Effect `Config` — resolves against the
 * runtime env without the worker having to pass env around manually.
 */
export const WorkerConfigProviderLive: Layer.Layer<never> =
  ConfigProvider.layer(WorkerConfigProvider())

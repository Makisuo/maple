// Copied from alchemy-effect to stay API-compatible for a future migration:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Workers/ConfigProvider.ts
//
// Produces an Effect ConfigProvider backed by the worker's env. Compose with
// `Layer.setConfigProvider(...)` to make `Config.string("FOO")` resolve from
// `env.FOO` inside an Effect workflow.
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import cloudflareWorkers from "./cloudflare-workers.ts"

export const WorkerConfigProvider = () =>
  cloudflareWorkers.pipe(
    Effect.map(({ env }) => ConfigProvider.fromUnknown(env)),
  )

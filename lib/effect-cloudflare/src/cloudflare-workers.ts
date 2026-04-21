// Copied (with no adaptation) from alchemy-effect to stay API-compatible for a
// future migration:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Workers/cloudflare_workers.ts
//
// Dynamic import of the `cloudflare:workers` runtime module. Falls back to
// structural stubs so non-worker runtimes (local tsc, vitest outside miniflare)
// can still type-check and load this package without crashing on the bare
// specifier.
import * as Effect from "effect/Effect"

const cloudflareWorkers: Effect.Effect<typeof import("cloudflare:workers")> =
  /** @__PURE__ #__PURE__ */ Effect.promise(() =>
    import("cloudflare:workers").catch(
      () =>
        ({
          env: {},
          DurableObject: class {},
          WorkflowEntrypoint: class {
            async run() {}
          },
        }) as any,
    ),
  )

export default cloudflareWorkers

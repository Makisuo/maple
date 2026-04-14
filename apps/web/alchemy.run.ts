import { Stack } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

// Railway provisioning is commented out during the alchemy v2 migration.
// Re-enable once alchemy ships a Railway provider (or we port it to fetch).
// See packages/infra/src/railway/index.ts.
//
// import {
//   parseRailwayDeploymentTarget,
//   provisionRailwayStack,
// } from "@maple/infra/railway"

if (!process.env.VITE_MAPLE_AUTH_MODE) {
  process.env.VITE_MAPLE_AUTH_MODE =
    process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted"
}

if (!process.env.VITE_CLERK_PUBLISHABLE_KEY) {
  process.env.VITE_CLERK_PUBLISHABLE_KEY =
    process.env.CLERK_PUBLISHABLE_KEY?.trim() || ""
}

const stage = process.env.STAGE?.trim() ?? "dev"

// Custom domain routing (app.maple.dev / staging.maple.dev) is disabled during
// the alchemy v2 migration — the installed alchemy@2.0.0-beta.3 Worker props
// don't yet expose a `domains` binding. Re-add once the provider supports it.

export const Website = Cloudflare.Vite("app", {
  compatibility: {
    flags: ["nodejs_compat"],
  },
})

export default Stack(
  "MapleWeb",
  { providers: Cloudflare.providers() },
  Effect.gen(function* () {
    const site = yield* Website
    return {
      stage,
      webUrl: site.url,
    }
  }),
)

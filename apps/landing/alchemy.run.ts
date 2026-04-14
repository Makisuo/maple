import { Stack } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

// Custom domain routing (maple.dev / staging-landing.maple.dev) is disabled
// during the alchemy v2 migration — the installed alchemy@2.0.0-beta.3 doesn't
// yet expose a `domains` binding on Worker/StaticSite props. Re-add once the
// provider supports it.

const stage = process.env.STAGE?.trim() ?? "dev"

export const Landing = Cloudflare.StaticSite("landing", {
  command: "astro build",
  outdir: "dist",
  assetsConfig: {
    htmlHandling: "auto-trailing-slash",
    notFoundHandling: "404-page",
  },
})

export default Stack(
  "MapleLanding",
  { providers: Cloudflare.providers() },
  Effect.gen(function* () {
    const site = yield* Landing
    return {
      stage,
      landingUrl: site.url,
    }
  }),
)

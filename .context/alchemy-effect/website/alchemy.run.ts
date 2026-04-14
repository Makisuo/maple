import * as Alchemy from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AlchemyEffectWebsite",
  {
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
    const Website = yield* Cloudflare.Vite("Website", {
      memo: {
        include: [
          "src/**",
          "astro.config.mjs",
          "package.json",
          "../scripts/generate-api-reference.ts",
          "../alchemy-effect/src/**",
          "../bun.lock",
        ],
      },
      compatibility: {
        date: "2026-04-02",
        flags: ["nodejs_compat"],
      },
    });

    return {
      url: Website.url,
    };
  }),
);

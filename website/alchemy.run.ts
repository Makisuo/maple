import * as Alchemy from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AlchemyEffectWebsite",
  {
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
    const Website = yield* Cloudflare.StaticSite("Website", {
      main: "./src/worker.ts",
      command: "bun run build",
      dev: {
        command: "bun run dev:site",
      },
      outdir: "./public",
      memo: {
        include: [
          "./config.toml",
          "./content/**",
          "./src/**",
          "./static/**",
          "./templates/**",
          "./package.json",
          "../scripts/generate-api-reference.ts",
          "../alchemy-effect/src/**",
          "../bun.lock",
        ],
      },
      assetsConfig: {
        runWorkerFirst: true,
      },
      compatibility: {
        date: "2026-04-02",
        flags: ["nodejs_compat"],
      },
    });

    return {
      urk: Website.url,
    };
  }),
);

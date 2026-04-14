import * as Alchemy from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareVueExample",
  {
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Vite("Vue", {
      compatibility: {
        flags: ["nodejs_compat"],
      },
      memo: {},
      assets: {
        config: {
          htmlHandling: "auto-trailing-slash",
          notFoundHandling: "single-page-application",
        },
      },
    });

    return {
      url: worker.url,
    };
  }),
);

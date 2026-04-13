import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Stack from "alchemy-effect/Stack";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
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
}).pipe(Stack.make("CloudflareVueExample", Cloudflare.providers()));

import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Stack from "alchemy-effect/Stack";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const worker = yield* Cloudflare.Vite("SolidJSSrr", {
    compatibility: {
      flags: ["nodejs_compat"],
    },
    assets: {
      config: {
        runWorkerFirst: true,
      },
    },
  });

  return {
    url: worker.url,
  };
}).pipe(Stack.make("CloudflareSolidJSSSRExample", Cloudflare.providers()));

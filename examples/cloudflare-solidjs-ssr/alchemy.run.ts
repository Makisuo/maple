import * as Alchemy from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareSolidJSSSRExample",
  {
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
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
  }),
);

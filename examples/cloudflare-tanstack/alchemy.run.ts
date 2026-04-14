import * as Alchemy from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareTanstackExample",
  {
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Vite("TanStackStart", {
      compatibility: {
        flags: ["nodejs_compat"],
      },
    });

    return {
      url: worker.url,
    };
  }),
);

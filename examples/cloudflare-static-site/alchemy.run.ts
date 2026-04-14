import * as Alchemy from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareVite",
  {
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Vite("Website");

    return {
      url: worker.url,
    };
  }),
);

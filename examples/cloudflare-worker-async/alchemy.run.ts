import * as Alchemy from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";

export const DB = Cloudflare.D1Database("DB");

export const Bucket = Cloudflare.R2Bucket("Bucket");

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export const Worker = Cloudflare.Worker("Worker", {
  main: "./src/worker.ts",
  bindings: {
    DB,
    Bucket,
  },
});

export default Alchemy.Stack(
  "CloudflareWorker",
  {
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;

    return worker.url;
  }),
);

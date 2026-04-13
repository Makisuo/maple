import { Cloudflare, Stack } from "alchemy-effect";
import * as Effect from "effect/Effect";

const DB = Cloudflare.D1Database("DB");

const Bucket = Cloudflare.R2Bucket("Bucket");

const Worker = Cloudflare.Worker("Worker", {
  main: "./src/worker.ts",
  bindings: {
    DB,
    Bucket,
  },
});

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export default Worker.pipe(
  Effect.map((worker) => worker.url),
  Stack.make("CloudflareWorker", Cloudflare.providers()),
);

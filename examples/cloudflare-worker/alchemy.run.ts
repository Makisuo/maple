import { Cloudflare, Stack } from "alchemy-effect";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";
import { Bucket } from "./src/Bucket.ts";

export default Effect.gen(function* () {
  const api = yield* Api;
  const bucket = yield* Bucket;

  return {
    url: api.url.as<string>(),
    bucket: bucket.bucketName,
  };
}).pipe(Stack.make("CloudflareWorker", Cloudflare.providers()));

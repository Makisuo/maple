import * as Alchemy from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";
import { Bucket } from "./src/Bucket.ts";

export default Alchemy.Stack(
  "CloudflareWorkerExample",
  {
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    const bucket = yield* Bucket;

    return {
      url: api.url.as<string>(),
      bucket: bucket.bucketName,
    };
  }),
);

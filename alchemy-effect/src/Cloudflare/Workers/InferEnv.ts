/// <reference types="@cloudflare/workers-types" />
// import type * as cf from "@cloudflare/workers-types";

import type * as Effect from "effect/Effect";
import type { UnwrapEffect } from "../../Util/effect.ts";
import type * as Cloudflare from "../index.ts";
import type { Worker } from "./Worker.ts";

export type InferEnv<W> = W extends
  | Worker<infer Bindings>
  | Effect.Effect<Worker<infer Bindings>, any, any>
  ? {
      [K in keyof Bindings]: GetBindingType<UnwrapEffect<Bindings[K]>>;
    }
  : never;

type GetBindingType<T> = T extends Cloudflare.D1Database
  ? D1Database
  : T extends Cloudflare.R2Bucket
    ? R2Bucket
    : T extends Cloudflare.KVNamespace
      ? KVNamespace
      : never;

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HttpEffect } from "./Http.ts";
import type { Output } from "./Output.ts";
import { GenericService } from "./Util/service.ts";

export interface BaseExecutionContext {
  Type: string;
  id: string;
  env: Record<string, any>;
  get<T>(key: string): Effect.Effect<T>;
  set(id: string, output: Output): Effect.Effect<string>;
  exports?: Effect.Effect<Record<string, any>>;
  serve?<Req = never>(
    handler: HttpEffect<Req>,
  ): Effect.Effect<void, never, Req>;
}

export interface ExecutionContext<
  Ctx extends BaseExecutionContext = BaseExecutionContext,
> extends Context.Service<`ExecutionContext<${Ctx["Type"]}>`, Ctx> {}

export const ExecutionContext = GenericService<{
  <Ctx extends BaseExecutionContext>(type: Ctx["Type"]): ExecutionContext<Ctx>;
}>()("Alchemy::ExecutionContext");

export const CurrentExecutionContext = Effect.serviceOption(
  ExecutionContext,
).pipe(Effect.map(Option.getOrUndefined));

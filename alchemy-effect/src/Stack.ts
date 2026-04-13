import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import type { Scope } from "effect/Scope";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { DotAlchemy } from "./Config.ts";
import type { ResourceBinding, ResourceLike } from "./Resource.ts";
import { Stage } from "./Stage.ts";

export type StackServices =
  | Stack
  | Stage
  | Scope
  | FileSystem
  | Path
  | DotAlchemy
  | HttpClient
  | ChildProcessSpawner;

export class Stack extends Context.Service<Stack, Omit<StackSpec, "output">>()(
  "Stack",
) {}

export interface StackSpec<Output = any> {
  name: string;
  stage: string;
  // @internal
  resources: {
    [logicalId: string]: ResourceLike;
  };
  bindings: {
    [logicalId: string]: ResourceBinding[];
  };
  output: Output;
}

export interface CompiledStack<
  Output = any,
  Services = any,
> extends StackSpec<Output> {
  services: Context.Context<Services>;
}

export const StackName = Stack.use((stack) => Effect.succeed(stack.name));

export const make =
  <const Name extends string, ROut = never>(
    name: Name,
    providers: Layer.Layer<ROut, never, StackServices>,
    /** @internal */
    stack?: StackSpec,
  ) =>
  <A, Err = never, Req extends ROut | StackServices = never>(
    effect: Effect.Effect<A, Err, Req>,
  ) =>
    Effect.all([
      effect,
      Stack.asEffect(),
      Effect.context<ROut | StackServices>(),
    ]).pipe(
      Effect.map(
        ([output, stack, services]) =>
          ({
            output,
            services,
            ...stack,
          }) satisfies CompiledStack<A, ROut | StackServices> as CompiledStack<
            A,
            ROut | StackServices
          >,
      ),
      Effect.provide(providers),
      Effect.provideServiceEffect(
        Stack,
        Stage.asEffect().pipe(
          Effect.map(
            (stage) =>
              (stack ?? {
                name,
                stage,
                resources: {},
                bindings: {},
              }) satisfies Stack["Service"],
          ),
          Effect.tap(Effect.logInfo),
        ),
      ),
    );

export const CurrentStack = Effect.serviceOption(Stack)
  .asEffect()
  .pipe(Effect.map(Option.getOrUndefined));

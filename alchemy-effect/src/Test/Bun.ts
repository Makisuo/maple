import { BunServices } from "@effect/platform-bun";
import bun from "bun:test";
import { ConfigProvider } from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { HookOptions } from "node:test";
import * as Apply from "../Apply.ts";
import { provideFreshArtifactStore } from "../Artifacts.ts";
import { DotAlchemy, dotAlchemy } from "../Config.ts";
import type { Input } from "../Input.ts";
import * as Plan from "../Plan.ts";
import { type CompiledStack, type StackServices } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import * as State from "../State/index.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { TestCli } from "./TestCli.ts";

export type ProvidedServices = StackServices;

type TestEffect<A, Req = never> = Effect.Effect<
  A,
  any,
  BunServices.BunServices | HttpClient | Scope | Req
>;

const platform = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

// override alchemy state store, CLI/reporting and dotAlchemy
const alchemy = Layer.mergeAll(
  // TODO(sam): support overriding these
  State.LocalState,
  // CLI.inkCLI(),
  // optional
  Logger.layer([Logger.consolePretty()]),
  dotAlchemy,
);

const run = <A>(effect: TestEffect<A>) =>
  Effect.gen(function* () {
    const configProvider = yield* loadConfigProvider(Option.none());

    return yield* effect.pipe(
      provideFreshArtifactStore,
      Effect.provide(Layer.succeed(ConfigProvider, configProvider)),
    );
  }).pipe(
    Effect.provide(Layer.provideMerge(alchemy, platform)),
    Effect.scoped,
    Effect.runPromise,
  );

export const it = test;

export const expect = bun.expect;

export function test(
  name: string,
  test: TestEffect<void>,
  options?: bun.TestOptions,
) {
  bun.test(name, () => run(test), options);
}

export namespace test {
  export function skipIf(condition: boolean) {
    return (
      name: string,
      test: TestEffect<void>,
      options?: bun.TestOptions,
    ) => {
      bun.test.skipIf(condition)(name, () => run(test), options);
    };
  }

  export function skip(
    name: string,
    test: TestEffect<void>,
    options?: bun.TestOptions,
  ) {
    bun.test.skip(name, () => run(test), options);
  }

  export function only(
    name: string,
    test: TestEffect<void>,
    options?: bun.TestOptions,
  ) {
    bun.test.only(name, () => run(test), options);
  }

  export function todo(
    name: string,
    test: TestEffect<void>,
    options?: bun.TestOptions,
  ) {
    bun.test.todo(name, () => run(test), options);
  }
}

export const describe = bun.describe;

export function beforeAll<A>(
  eff: Effect.Effect<A, any>,
  options?: HookOptions,
) {
  let a: A;
  bun.beforeAll(
    () => run(eff).then((v) => (a = v)),
    options ?? {
      timeout: 120_000,
    },
  );
  return Effect.sync(() => a);
}

export function beforeEach(
  eff: Effect.Effect<void, any>,
  options?: HookOptions,
) {
  bun.beforeEach(() => run(eff), options);
}

export function afterAll(eff: Effect.Effect<any, any>, options?: HookOptions) {
  bun.afterAll(() => run(eff), options);
}

export namespace afterAll {
  export const skipIf =
    (predicate: boolean) =>
    (test: Effect.Effect<void, any>, options?: HookOptions) => {
      if (predicate) {
      } else {
        bun.afterAll(
          () => run(test),
          options ?? {
            timeout: 120_000,
          },
        );
      }
    };
}

export function afterEach(
  eff: Effect.Effect<void, any>,
  options?: HookOptions,
) {
  bun.afterEach(() => run(eff), options);
}

export const deploy = <A>(
  effect: TestEffect<CompiledStack<A>, Stage | DotAlchemy>,
  options?: {
    /** @default test */
    stage?: string;
  },
) =>
  exec(
    effect,
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* Plan.make(stack);
        const output = yield* Apply.apply(plan);
        return output as Input.Resolve<A>;
      }),
    options,
  );

export const destroy = (
  effect: TestEffect<CompiledStack, Stage | DotAlchemy>,
  options?: {
    /** @default test */
    stage?: string;
  },
) =>
  exec(
    effect,
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* Plan.make({
          ...stack,
          // zero these out (destroy will treat all as orphans)
          // TODO(sam): probably better to have Plan.destroy and Plan.update
          resources: {},
          bindings: {},
          output: {},
        });
        yield* Apply.apply(plan);
      }),
    options,
  );

const exec = <A, B>(
  effect: TestEffect<CompiledStack<A>, Stage | DotAlchemy>,
  fn: (stack: CompiledStack<A>) => Effect.Effect<B, any, any>,
  options?: {
    stage?: string;
  },
) =>
  Effect.gen(function* () {
    const stack = yield* effect;
    const configProvider = yield* loadConfigProvider(Option.none());

    return yield* fn(stack).pipe(
      provideFreshArtifactStore,
      Effect.provide(stack.services),
      Effect.provide(Layer.succeed(ConfigProvider, configProvider)),
    );
  }).pipe(
    Effect.provide(Layer.succeed(Stage, options?.stage ?? "test")),
    Effect.provide(TestCli),
    Effect.provide(Layer.provideMerge(alchemy, platform)),
    Effect.scoped,
  );

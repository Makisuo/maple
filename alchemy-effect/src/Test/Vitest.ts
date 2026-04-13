import type * as aws from "@distilled.cloud/aws";
import * as cf from "@distilled.cloud/cloudflare";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Logger } from "effect";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as NodePath from "node:path";
import {
  afterAll as vitestAfterAll,
  beforeAll as vitestBeforeAll,
} from "vitest";
import * as AWS from "../AWS/index.ts";
import * as Cloudflare from "../Cloudflare/index.ts";

import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { apply } from "../Apply.ts";
import { Artifacts, provideFreshArtifactStore } from "../Artifacts.ts";
import * as Credentials from "../AWS/Credentials.ts";
import * as Region from "../AWS/Region.ts";
import type { Command } from "../Build/Command.ts";
import type { Cli } from "../Cli/index.ts";
import {
  buildNamespaceTree,
  flattenTree,
  type DerivedAction,
} from "../Cli/NamespaceTree.ts";
import { DotAlchemy, dotAlchemy } from "../Config.ts";
import { ExecutionContext } from "../ExecutionContext.ts";
import type { Input } from "../Input.ts";
import type { Output } from "../Output.ts";
import * as Plan from "../Plan.ts";
import type { Provider } from "../Provider.ts";
import * as Server from "../Server/index.ts";
import * as Serverless from "../Serverless/index.ts";
import * as Stack from "../Stack.ts";
import * as Stage from "../Stage.ts";
import * as State from "../State/index.ts";
import { TestCli } from "./TestCli.ts";

export const expectEmptyObject = () =>
  expect.toSatisfy(
    (deletions) => Object.keys(deletions).length === 0,
    "empty object",
  );

export const expectPropExpr = (identifier: string, src: any) =>
  expect.objectContaining({
    kind: "PropExpr",
    identifier,
    expr: expect.objectContaining({
      kind: "ResourceExpr",
      src,
    }),
  });

type Provided =
  | Scope.Scope
  | Stack.Stack
  | State.State
  | Stage.Stage
  | DotAlchemy
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
  | aws.Credentials.Credentials
  | aws.Region.Region
  | Cli
  | ExecutionContext
  | Server.ProcessContext
  | Server.ServerHost
  | Serverless.FunctionContext
  | AWS.StageConfig
  | Artifacts
  | Provider<Command>
  | AWS.Providers
  | Cloudflare.Providers
  | ChildProcessSpawner;

const quietLogger = Logger.make(() => {
  // console.log(options.message);
});

const platform = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  Logger.layer([process.env.VERBOSE ? Logger.consolePretty() : quietLogger]),
);

const awsStageConfig = Layer.effect(
  AWS.StageConfig,
  Effect.gen(function* () {
    const AWS_PROFILE = yield* Config.string("AWS_PROFILE").pipe(
      Config.withDefault("default"),
    );

    const LOCAL = yield* Config.boolean("LOCAL").pipe(
      Config.withDefault(false),
    );

    const LOCALSTACK_ENDPOINT = yield* Config.string(
      "LOCALSTACK_ENDPOINT",
    ).pipe(Config.withDefault("http://localhost.localstack.cloud:4566"));

    return AWS.StageConfig.of({
      profile: LOCAL ? undefined : AWS_PROFILE,
      region: LOCAL ? "us-east-1" : undefined,
      credentials: LOCAL
        ? {
            accessKeyId: "test",
            secretAccessKey: "test",
            sessionToken: "test",
          }
        : undefined,
      endpoint: LOCAL ? LOCALSTACK_ENDPOINT : undefined,
    });
  }),
);

const awsProviders = Layer.provideMerge(
  AWS.providers(),
  Layer.mergeAll(Credentials.fromStageConfig(), Region.fromStageConfig()),
);

const cfProviders = Layer.provideMerge(
  Cloudflare.providers(),
  Layer.mergeAll(cf.CredentialsFromEnv, FetchHttpClient.layer),
);

const deriveStackName = (testPath: string, suffix: string) => {
  const testDir = testPath.includes("/test/")
    ? (testPath.split("/test/").pop() ?? "")
    : NodePath.basename(testPath);
  const testPathWithoutExt = testDir.replace(/\.[^.]+$/, "");
  return `${testPathWithoutExt}-${suffix}`
    .replaceAll(/[^a-zA-Z0-9_]/g, "-")
    .replace(/-+/g, "-");
};

const runWithContext = <A, Err>(
  stackName: string,
  effect: Effect.Effect<A, Err, Provided>,
  options: {
    state?: Layer.Layer<State.State, never, Stack.Stack>;
    providers?: boolean;
  } = {},
): Effect.Effect<
  A,
  aws.Credentials.CredentialsError | Config.ConfigError | Err,
  never
> => {
  const stack = Layer.effect(
    Stack.Stack,
    Effect.succeed({
      name: stackName,
      stage: "test",
      resources: {},
      bindings: {},
    }),
  );

  const alchemy = Layer.provideMerge(
    Layer.mergeAll(options.state ?? State.LocalState, TestCli),
    Layer.mergeAll(awsStageConfig, stack, dotAlchemy),
  );

  const context = {
    Type: "Test",
    id: "Test",
    env: {},
    exports: {},
    listen: () => Effect.void,
    serve: () => Effect.void,
    get: <T>(_key: string) => Effect.succeed<T>(undefined as T),
    set: (_id: string, _output: Output) =>
      Effect.sync(() => _id.replaceAll(/[^a-zA-Z0-9]/g, "_")),
  };

  // Test harness does not fully close `Req`; runtime provides enough for tests.
  // @ts-expect-error Residual requirement channel on `effect` after ConfigProvider.
  return Effect.gen(function* () {
    const configProvider = ConfigProvider.orElse(
      yield* ConfigProvider.fromDotEnv({ path: ".env" }),
      ConfigProvider.fromEnv(),
    );
    return yield* effect.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
    );
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        options.providers === false
          ? Layer.empty
          : Layer.mergeAll(awsProviders, cfProviders),
        Layer.provideMerge(alchemy, platform),
      ),
    ),
    Effect.provideService(Stage.Stage, "test"),
    Effect.provideService(ExecutionContext, context as any),
    Effect.provideService(Server.ServerHost, {
      run: (_effect) => Effect.void,
    }),
    Effect.provideService(
      MinimumLogLevel,
      process.env.DEBUG ? "Debug" : "Info",
    ),
    Effect.provide(NodeServices.layer),
  );
};

export function test(
  name: string,
  options: {
    timeout?: number;
    state?: Layer.Layer<State.State, never, Stack.Stack>;
    providers?: boolean;
  },
  testCase: Effect.Effect<void, any, Provided>,
): void;

export function test(
  name: string,
  testCase: Effect.Effect<void, any, Provided>,
): void;

export function test(
  name: string,
  ...args:
    | [
        {
          timeout?: number;
          state?: Layer.Layer<State.State, never, Stack.Stack>;
          providers?: boolean;
        },
        Effect.Effect<void, any, Provided>,
      ]
    | [Effect.Effect<void, any, Provided>]
) {
  const [options = {}, testCase] =
    args.length === 1 ? [undefined, args[0]] : args;

  const testPath = expect.getState().testPath ?? "";
  const stackName = deriveStackName(testPath, name);
  const effect = runWithContext(stackName, testCase, options);

  return it.live(name, () => effect, options.timeout);
}

export namespace test {
  export function skip(
    name: string,
    options: {
      timeout?: number;
      state?: Layer.Layer<State.State, never, Stack.Stack>;
      providers?: boolean;
    },
    testCase: Effect.Effect<void, any, Provided>,
  ): void;

  export function skip(
    name: string,
    testCase: Effect.Effect<void, any, Provided>,
  ): void;

  export function skip(
    name: string,
    ...args:
      | [
          {
            timeout?: number;
            state?: Layer.Layer<State.State, never, Stack.Stack>;
            providers?: boolean;
          },
          Effect.Effect<void, any, Provided>,
        ]
      | [Effect.Effect<void, any, Provided>]
  ) {
    const [options = {}, _testCase] =
      args.length === 1 ? [undefined, args[0]] : args;
    it.skip(name, () => {}, options.timeout);
  }

  export function skipIf(condition: boolean) {
    return function (
      name: string,
      ...args:
        | [
            {
              timeout?: number;
              state?: Layer.Layer<State.State, never, Stack.Stack>;
              providers?: boolean;
            },
            Effect.Effect<void, any, Provided>,
          ]
        | [Effect.Effect<void, any, Provided>]
    ) {
      if (condition) {
        const [options = {}, _testCase] =
          args.length === 1 ? [undefined, args[0]] : args;
        it.skip(name, () => {}, options.timeout);
      } else {
        test(name, ...(args as [Effect.Effect<void, any, Provided>]));
      }
    };
  }

  export const state = (resources: Record<string, State.ResourceState> = {}) =>
    Layer.effect(
      State.State,
      Effect.gen(function* () {
        const stack = yield* Stack.Stack;
        return State.InMemoryService({
          [stack.name]: {
            [stack.stage]: resources,
          },
        });
      }),
    );

  export const defaultState = (
    resources: Record<string, State.ResourceState> = {},
    other?: {
      [stack: string]: {
        [stage: string]: {
          [resourceId: string]: State.ResourceState;
        };
      };
    },
  ) =>
    Layer.succeed(
      State.State,
      State.InMemoryService({
        ["test-app"]: {
          ["test-stage"]: resources,
        },
        ...other,
      }),
    );

  export const deploy = <A, Err = never, Req = any>(
    effect: Effect.Effect<A, Err, Req>,
  ): Effect.Effect<Input.Resolve<A>, Err, Req | Stack.Stack> =>
    Stack.Stack.use((stack) => {
      return provideFreshArtifactStore(
        effect.pipe(
          // Effect.tap(Effect.logInfo),
          // @ts-expect-error
          Stack.make(stack.name, Layer.effectContext(Effect.context<never>()), {
            ...stack,
            resources: {},
            bindings: {},
            output: {},
          }),
          Effect.flatMap(Plan.make),
          Effect.tap((plan) => Effect.logInfo(formatPlan(plan))),
          Effect.flatMap(apply),
        ),
      );
    });
}

type AnyAction = Plan.CRUD["action"] | Plan.BindingAction | DerivedAction;

const formatPlan = (plan: Plan.Plan) => {
  const items = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions),
  ] as Plan.CRUD[];

  if (items.length === 0) {
    return "Plan: no changes planned";
  }

  const counts = items.reduce(
    (acc, item) => {
      acc[item.action] += 1;
      return acc;
    },
    {
      create: 0,
      update: 0,
      delete: 0,
      noop: 0,
      replace: 0,
    },
  );

  const summary = (["create", "update", "delete", "replace"] as const)
    .filter((action) => counts[action] > 0)
    .map((action) => `${counts[action]} to ${action}`)
    .join(" | ");

  const flatItems = flattenTree(buildNamespaceTree(items));
  const lines = [`Plan: ${summary}`];

  for (const item of flatItems) {
    const indent = "  ".repeat(item.depth);
    const icon = getActionIcon(item.action);

    if (item.type === "namespace") {
      lines.push(`${indent}${icon} ${item.id}`);
      continue;
    }

    if (item.type === "binding") {
      lines.push(`${indent}${icon} ${item.bindingSid}`);
      continue;
    }

    const bindingSuffix =
      item.bindingCount && item.bindingCount > 0
        ? ` (${item.bindingCount} bindings)`
        : "";
    lines.push(
      `${indent}${icon} ${item.id} (${item.resourceType})${bindingSuffix}`,
    );
  }

  return lines.join("\n");
};

const getActionIcon = (action: AnyAction): string =>
  ({
    create: "+",
    update: "~",
    delete: "-",
    noop: "•",
    replace: "!",
    mixed: "*",
  })[action] ?? "?";

export function skip(
  name: string,
  options: {
    timeout?: number;
    state?: Layer.Layer<State.State, never, Stack.Stack>;
    providers?: boolean;
  },
  testCase: Effect.Effect<void, any, Provided>,
): void;

export function skip(
  name: string,
  testCase: Effect.Effect<void, any, Provided>,
): void;

export function skip(
  name: string,
  ...args:
    | [
        {
          timeout?: number;
          state?: Layer.Layer<State.State, never, Stack.Stack>;
          providers?: boolean;
        },
        Effect.Effect<void, any, Provided>,
      ]
    | [Effect.Effect<void, any, Provided>]
) {
  const [options = {}, _testCase] =
    args.length === 1 ? [undefined, args[0]] : args;
  it.skip(name, () => {}, options.timeout);
}

export function skipIf(condition: boolean) {
  return function (
    name: string,
    ...args:
      | [
          {
            timeout?: number;
            state?: Layer.Layer<State.State, never, Stack.Stack>;
            providers?: boolean;
          },
          Effect.Effect<void, any, Provided>,
        ]
      | [Effect.Effect<void, any, Provided>]
  ) {
    if (condition) {
      const [options = {}, _testCase] =
        args.length === 1 ? [undefined, args[0]] : args;
      it.skip(name, () => {}, options.timeout);
    } else {
      test(name, ...(args as [Effect.Effect<void, any, Provided>]));
    }
  };
}

export function beforeAll<A, E = never, R extends Provided = never>(
  effect: Effect.Effect<A, E, R>,
  options?: { timeout?: number; stackName?: string },
): void {
  const testPath = expect.getState().testPath ?? "";
  const stackName = options?.stackName ?? deriveStackName(testPath, "suite");

  vitestBeforeAll(
    () => Effect.runPromise(Effect.scoped(runWithContext(stackName, effect))),
    options?.timeout,
  );
}

export function afterAll<A, E, R extends Provided = never>(
  effect: Effect.Effect<A, E, R>,
  options?: { timeout?: number; stackName?: string },
): void {
  const testPath = expect.getState().testPath ?? "";
  const stackName = options?.stackName ?? deriveStackName(testPath, "suite");

  vitestAfterAll(
    () => Effect.runPromise(Effect.scoped(runWithContext(stackName, effect))),
    options?.timeout,
  );
}

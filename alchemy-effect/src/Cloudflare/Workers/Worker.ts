import type * as cf from "@cloudflare/workers-types";
import cloudflareRolldown from "@distilled.cloud/cloudflare-rolldown-plugin";
import cloudflareVite from "@distilled.cloud/cloudflare-vite-plugin";
import * as workers from "@distilled.cloud/cloudflare/workers";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import type * as rolldown from "rolldown";
import Sonda from "sonda/rolldown";
import type * as vite from "vite";
import * as Artifacts from "../../Artifacts.ts";
import * as Binding from "../../Binding.ts";
import { hashDirectory, type MemoOptions } from "../../Build/Memo.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import { findCwdForBundle } from "../../Bundle/TempRoot.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved } from "../../Diff.ts";
import type { HttpEffect } from "../../Http.ts";
import type { Input, InputProps } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  Platform,
  type Main,
  type PlatformProps,
  type Rpc,
} from "../../Platform.ts";
import type { LogLine } from "../../Provider.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { Self } from "../../Self.ts";
import * as Serverless from "../../Serverless/index.ts";
import { Stack } from "../../Stack.ts";
import { Account } from "../Account.ts";
import { D1Database } from "../D1/D1Database.ts";
import { fromCloudflareFetcher } from "../Fetcher.ts";
import { CloudflareLogs } from "../Logs.ts";
import type { R2Bucket } from "../R2/R2Bucket.ts";
import type { AssetsConfig, AssetsProps } from "./Assets.ts";
import * as Assets from "./Assets.ts";
import cloudflare_workers from "./cloudflare_workers.ts";
import { isDurableObjectExport } from "./DurableObject.ts";
import { workersHttpHandler } from "./HttpServer.ts";
import { Request } from "./Request.ts";
import { makeRpcStub } from "./Rpc.ts";
import { isWorkflowExport } from "./Workflow.ts";

const WorkerTypeId = "Cloudflare.Worker";
type WorkerTypeId = typeof WorkerTypeId;

export const isWorker = <T>(value: T): value is T & Worker =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  value.Type === WorkerTypeId;

export class WorkerEnvironment extends Context.Service<
  WorkerEnvironment,
  Record<string, any>
>()("Cloudflare.Workers.WorkerEnvironment") {}

export const WorkerEnvironmentLive = Layer.effect(
  WorkerEnvironment,
  cloudflare_workers.pipe(Effect.map((m) => m.env)),
);

export class ExecutionContext extends Context.Service<
  ExecutionContext,
  cf.ExecutionContext
>()("Cloudflare.Workers.ExecutionContext") {}

export type WorkerEvent = Exclude<
  {
    [type in keyof cf.ExportedHandler]: {
      kind: "Cloudflare.Workers.WorkerEvent";
      type: type;
      input: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[0];
      env: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[1];
      context: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[2];
    };
  }[keyof cf.ExportedHandler],
  undefined
>;

export const isWorkerEvent = (value: any): value is WorkerEvent =>
  value?.kind === "Cloudflare.Workers.WorkerEvent";

/**
 * Assets configuration that includes a pre-computed hash.
 * When hash is provided, it's used directly for diffing instead of computing from directory contents.
 * This is useful when integrating with Build resources that produce a deterministic hash.
 */
export interface AssetsWithHash {
  /**
   * Path to the assets directory.
   */
  path: Input<string>;
  /**
   * Pre-computed hash of the assets. When provided, this hash is used for diffing
   * to determine if the worker needs to be redeployed.
   */
  hash: Input<string>;
  /**
   * Optional assets configuration.
   */
  config?: AssetsConfig;
}

export interface WorkerObservability extends Exclude<
  workers.PutScriptRequest["metadata"]["observability"],
  undefined
> {}

export interface WorkerLimits extends Exclude<
  workers.PutScriptRequest["metadata"]["limits"],
  undefined
> {}

export type WorkerPlacement = Exclude<
  workers.PutScriptRequest["metadata"]["placement"],
  undefined
>;

export type WorkerBinding = Exclude<
  workers.PutScriptRequest["metadata"]["bindings"],
  undefined
>[number];

type WorkerSettingsBinding = Exclude<
  workers.GetScriptScriptAndVersionSettingResponse["bindings"],
  null | undefined
>[number];

export const ExportedHandlerMethods = [
  "fetch",
  "tail",
  "trace",
  "tailStream",
  "scheduled",
  "test",
  "email",
  "queue",
] as const satisfies (keyof cf.ExportedHandler)[];

export interface WorkerExecutionContext extends Serverless.FunctionContext {
  export(name: string, value: any): Effect.Effect<void>;
}

export type WorkerServices = Worker | WorkerEnvironment | Request;

export type WorkerShape = Main<WorkerServices>;

export type WorkerBindingResource = R2Bucket | D1Database;

export type WorkerBindings = {
  [bindingName in string]: WorkerBindingResource;
};

export type WorkerBindingProps = {
  [bindingName in string]:
    | WorkerBindingResource
    | Effect.Effect<WorkerBindingResource, any, any>;
};

export interface WorkerProps<
  Bindings extends WorkerBindingProps = any,
> extends PlatformProps {
  /**
   * Worker name override. If omitted, Alchemy derives a deterministic physical
   * name from the stack, stage, and logical ID.
   */
  name?: string;
  /**
   * Whether to enable a workers.dev URL for this worker
   * @default true
   */
  url?: boolean;
  /**
   * Static assets to serve. Can be:
   * - A string path to the assets directory
   * - An AssetsProps object with directory and config
   * - An object with path and hash (e.g., from a Build resource)
   */
  assets?:
    | string
    | AssetsProps
    | AssetsWithHash
    | (AssetsWithHash & { [K: string]: any });
  subdomain?: {
    enabled?: boolean;
    previewsEnabled?: boolean;
  };
  /** @internal used by Cloudflare.Vite resource */
  vite?: {
    rootDir?: string;
    memo?: MemoOptions;
  };
  logpush?: boolean;
  observability?: WorkerObservability;
  tags?: string[];
  main: string;
  compatibility?: {
    date?: string;
    flags?: ("nodejs_compat" | "nodejs_als" | (string & {}))[];
  };
  limits?: WorkerLimits;
  placement?: WorkerPlacement;
  env?: Record<string, string | Redacted.Redacted<string>>;
  exports?: string[];
  bindings?: Bindings;
  build?: {
    /**
     * Whether to generate a metafile for the worker bundle.
     * @default false
     */
    metafile?: boolean;
  };
}

export type Worker<Bindings extends WorkerBindings = any> = Resource<
  WorkerTypeId,
  WorkerProps<Bindings>,
  {
    workerId: string;
    workerName: string;
    logpush: boolean | undefined;
    url: string | undefined;
    tags: string[] | undefined;
    durableObjectNamespaces: Record<string, string>;
    accountId: string;
    hash?: {
      assets: string | undefined;
      bundle: string | undefined;
      input: string | undefined;
    };
  },
  {
    bindings?: WorkerBinding[];
    containers?: { className: string }[];
  }
>;

/**
 * A Cloudflare Worker host with deploy-time binding support and runtime export
 * collection.
 *
 * `Worker` behaves like a resource during deploy, but it also carries a runtime
 * execution context so KV, R2, Durable Objects, assets, and service bindings
 * can be inferred from the worker program itself.
 *
 * @section Creating Workers
 * @example Basic Worker
 * ```typescript
 * const worker = yield* Worker("ApiWorker", {
 *   main: "./src/worker.ts",
 * });
 * ```
 */
export const Worker: Platform<
  Worker,
  WorkerServices,
  WorkerShape,
  WorkerExecutionContext
> & {
  <const Bindings extends WorkerBindingProps>(
    id: string,
    props: InputProps<WorkerProps<Bindings>>,
  ): Effect.Effect<
    Worker<{
      [B in keyof Bindings]: Bindings[B] extends Effect.Effect<
        infer T extends WorkerBindingResource,
        any,
        any
      >
        ? T
        : Extract<Bindings[B], WorkerBindingResource>;
    }>
  >;
} = Platform(WorkerTypeId, {
  onCreate: Effect.fnUntraced(function* (
    resource: Worker,
    props: InputProps<WorkerProps<WorkerBindingProps>>,
  ) {
    if (props.bindings) {
      for (const bindingName in props.bindings) {
        // @ts-expect-error
        const bindingEff = props.bindings?.[bindingName] as
          | WorkerBindingResource
          | Effect.Effect<WorkerBindingResource>;
        const binding = Effect.isEffect(bindingEff)
          ? yield* bindingEff
          : bindingEff;

        const bindingMeta: InputProps<WorkerBinding> | undefined =
          binding.Type === "Cloudflare.D1Database"
            ? {
                type: "d1",
                id: binding.databaseId,
                name: bindingName,
              }
            : binding.Type === "Cloudflare.R2Bucket"
              ? {
                  type: "r2_bucket",
                  name: bindingName,
                  bucketName: binding.bucketName,
                  jurisdiction: binding.jurisdiction.pipe(
                    Output.map((jurisdiction) =>
                      jurisdiction === "default" ? undefined : jurisdiction,
                    ),
                  ),
                }
              : // TODO(sam): handle others
                undefined;

        if (bindingMeta) {
          yield* resource.bind`${bindingName}`({
            bindings: [bindingMeta],
          });
        }
      }
    }
  }),
  createExecutionContext: (id: string): WorkerExecutionContext => {
    const listeners: Effect.Effect<Serverless.FunctionListener>[] = [];
    const exports: Record<string, any> = {};
    const env: Record<string, any> = {};

    const ctx = {
      Type: WorkerTypeId,
      id,
      env,
      get: (key: string) =>
        Effect.serviceOption(WorkerEnvironment).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.flatMap((env) =>
            env
              ? Effect.succeed(env[key])
              : Effect.die("WorkerEnvironment not found"),
          ),
          Effect.flatMap((value) =>
            value
              ? Effect.succeed(value)
              : Effect.die(`Environment variable '${key}' not found`),
          ),
          Effect.map((json) => {
            try {
              const value = JSON.parse(json);
              if (!Redacted.isRedacted(value)) {
                return Redacted.make(value.value);
              }
              return value;
            } catch {
              return json;
            }
          }),
        ) as any,
      set: (id: string, output: Output.Output) =>
        Effect.sync(() => {
          const key = id.replaceAll(/[^a-zA-Z0-9]/g, "_");
          env[key] = output.pipe(
            Output.map((value) =>
              Redacted.isRedacted(value)
                ? JSON.stringify({
                    _tag: "Redacted",
                    value: Redacted.value(value),
                  })
                : JSON.stringify(value),
            ),
          );
          return key;
        }),
      serve: <Req = never>(handler: HttpEffect<Req>) =>
        ctx.listen(workersHttpHandler(handler)),
      listen: ((
        handler:
          | Serverless.FunctionListener
          | Effect.Effect<Serverless.FunctionListener>,
      ) =>
        Effect.sync(() =>
          Effect.isEffect(handler)
            ? listeners.push(handler)
            : listeners.push(Effect.succeed(handler)),
        )) as any as Serverless.FunctionContext["listen"],
      export: (name: string, value: any) =>
        Effect.sync(() => {
          exports[name] = value;
        }),
      exports: Effect.gen(function* () {
        const handlers = yield* Effect.all(listeners, {
          concurrency: "unbounded",
        });
        const services = yield* Effect.context();
        const handle =
          (type: WorkerEvent["type"]) =>
          (request: any, env: unknown, context: cf.ExecutionContext) => {
            const event: WorkerEvent = {
              kind: "Cloudflare.Workers.WorkerEvent",
              type,
              input: request,
              env,
              context,
            };
            for (const handler of handlers) {
              const eff = handler(event);
              if (Effect.isEffect(eff)) {
                return eff.pipe(
                  Effect.provideContext(services),
                  Effect.provide(Layer.succeed(ExecutionContext, context)),
                  Effect.runPromise,
                );
              }
            }
            return Promise.reject(new Error("No event handler found"));
          };
        return {
          ...exports,
          default: Object.fromEntries(
            ExportedHandlerMethods.map((method) => [method, handle(method)]),
          ),
        };
      }),
    };
    return ctx;
  },
});

export const bindWorker = Effect.fnUntraced(function* <Shape, Req = never>(
  workerEff:
    | (Worker & Rpc<Shape>)
    | Effect.Effect<Worker & Rpc<Shape>, never, Req>,
) {
  const worker = Effect.isEffect(workerEff) ? yield* workerEff : workerEff;
  const self = yield* Worker;
  yield* self.bind`${worker}`({
    bindings: [
      {
        type: "service",
        name: worker.LogicalId,
        service: worker.workerName,
      },
    ],
  });

  const workerBinding = WorkerEnvironment.asEffect().pipe(
    Effect.map((env) => env[worker.LogicalId]),
  );

  const fetcher = workerBinding.pipe(Effect.map(fromCloudflareFetcher));
  // TODO(sam): update makeRpcStub to support lazily evaluating the Effect<Fetcher>
  return makeRpcStub<Shape>(fetcher);
});

export class BindWorkerPolicy extends Binding.Policy<
  BindWorkerPolicy,
  (worker: Worker) => Effect.Effect<void>
>()("Cloudflare.Worker.Bind") {}

export const BindWorkerPolicyLive = BindWorkerPolicy.layer.succeed(
  Effect.fn(function* (host, worker: Worker) {
    if (isWorker(host)) {
      yield* host.bind`${worker}`({
        bindings: [
          {
            type: "service",
            name: worker.LogicalId,
            service: worker.workerName,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`BindWorkerPolicy does not support runtime '${host.Type}'`),
      );
    }
  }),
);

class MissingDurableObjectNamespaces extends Data.TaggedError(
  "MissingDurableObjectNamespaces",
)<{
  scriptName: string;
  expected: string[];
}> {}

function bumpMigrationTagVersion(
  oldTag: string | undefined,
): string | undefined {
  if (!oldTag) return undefined;
  const version = oldTag.match(/^(alchemy:)?v(\d+)$/)?.[2];
  if (!version) return "alchemy:v1";
  return `alchemy:v${parseInt(version, 10) + 1}`;
}

function getDurableObjectBindings(
  bindings: ReadonlyArray<ResourceBinding>,
  workerName: string,
) {
  return bindings.flatMap((binding) =>
    (binding.data.bindings ?? []).flatMap((item: WorkerBinding) =>
      item.type === "durable_object_namespace" &&
      "className" in item &&
      item.className &&
      (!("scriptName" in item) ||
        !item.scriptName ||
        item.scriptName === workerName)
        ? [
            {
              logicalId: binding.sid,
              bindingName: item.name,
              className: item.className,
            },
          ]
        : [],
    ),
  );
}

function getDurableObjectTagMap(tags: ReadonlyArray<string>) {
  return Object.fromEntries(
    tags.flatMap((tag) => {
      if (!tag.startsWith("alchemy:do:")) {
        return [];
      }
      const parts = tag.split(":");
      const logicalId = parts[2];
      const className = parts.slice(3).join(":");
      return logicalId && className ? [[logicalId, className]] : [];
    }),
  );
}

export const WorkerProvider = () =>
  Provider.effect(
    Worker,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const accountId = yield* Account;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      const stack = yield* Stack;

      const { read, upload } = yield* Assets.Assets;
      const createScriptSubdomain = yield* workers.createScriptSubdomain;
      const createScriptTail = yield* workers.createScriptTail;
      const deleteScript = yield* workers.deleteScript;
      const deleteScriptTail = yield* workers.deleteScriptTail;
      const getScriptSubdomain = yield* workers.getScriptSubdomain;
      const getScriptSettings = yield* workers.getScriptScriptAndVersionSetting;
      const getSubdomain = yield* workers.getSubdomain;
      const listScripts = yield* workers.listScripts;
      const putScript = yield* workers.putScript;
      const telemetry = yield* CloudflareLogs;
      const defaultCompatibilityDate = yield* Effect.promise(() =>
        // @ts-expect-error no types for workerd
        import("workerd").then((m) => m.compatibilityDate as string),
      );

      const getAccountSubdomain = (accountId: string) =>
        getSubdomain({
          accountId,
        }).pipe(Effect.map((result) => result.subdomain));

      const setWorkerSubdomain = (name: string, enabled: boolean) =>
        createScriptSubdomain({
          accountId,
          scriptName: name,
          enabled,
        });

      const createWorkerName = (id: string, name: string | undefined) =>
        name
          ? Effect.succeed(name)
          : createPhysicalName({
              id,
              maxLength: 54,
            }).pipe(Effect.map((name) => name.toLowerCase()));

      const createAlchemyWorkerTags = (id: string) => [
        `alchemy:stack:${stack.name}`,
        `alchemy:stage:${stack.stage}`,
        `alchemy:id:${id}`,
      ];

      const hasAlchemyWorkerTags = (
        id: string,
        tags: readonly string[] | undefined,
      ) => {
        const actualTags = new Set(tags ?? []);
        return createAlchemyWorkerTags(id).every((tag) => actualTags.has(tag));
      };

      const getDurableObjectNamespaces = (
        bindings: readonly WorkerSettingsBinding[] | null | undefined,
      ) => {
        const namespaces = Object.fromEntries(
          (bindings ?? []).flatMap((binding) =>
            binding.type === "durable_object_namespace" &&
            binding.className &&
            binding.namespaceId
              ? [[binding.className, binding.namespaceId]]
              : [],
          ),
        );
        return namespaces;
      };

      const getExpectedDurableObjectClassNames = (
        bindings: readonly WorkerBinding[] | undefined,
      ) =>
        Array.from(
          new Set(
            bindings?.flatMap((binding) =>
              binding.type === "durable_object_namespace" && binding.className
                ? [binding.className]
                : [],
            ) ?? [],
          ),
        );

      const getWorkerSettingsWithDurableObjects = Effect.fnUntraced(function* (
        scriptName: string,
        expectedClassNames: readonly string[],
      ) {
        return yield* getScriptSettings({
          accountId,
          scriptName,
        }).pipe(
          Effect.map((settings) => {
            const namespaces = getDurableObjectNamespaces(settings.bindings);
            const missing = expectedClassNames.filter(
              (className) => !namespaces[className],
            );
            if (missing.length > 0) {
              return Effect.fail(
                new MissingDurableObjectNamespaces({
                  scriptName,
                  expected: missing,
                }),
              );
            }
            return Effect.succeed({
              settings,
              durableObjectNamespaces: namespaces,
            });
          }),
          Effect.flatten,
          Effect.retry({
            while: (error) => error._tag === "MissingDurableObjectNamespaces",
            schedule: Schedule.exponential(100).pipe(
              Schedule.both(Schedule.recurs(20)),
            ),
          }),
        );
      });

      const prepareAssets = Effect.fnUntraced(function* (
        assets: WorkerProps["assets"],
      ) {
        if (!assets) return undefined;

        // Handle AssetsWithHash (from Build resource)
        // Props are resolved by Plan, so Input<string> values are already strings at runtime
        if (
          typeof assets === "object" &&
          "path" in assets &&
          "hash" in assets
        ) {
          const result = yield* read({
            directory: assets.path as string,
            config: assets.config,
          });
          return {
            ...result,
            hash: assets.hash as string,
          };
        }

        // Handle string path or AssetsProps
        return yield* read(
          typeof assets === "string" ? { directory: assets } : assets,
        );
      });

      const prepareBundle = (id: string, props: WorkerProps) =>
        Effect.gen(function* () {
          const main = yield* fs.realPath(props.main);
          const cwd = yield* findCwdForBundle(main);
          const buildBundle = (plugins?: rolldown.RolldownPluginOption) =>
            Bundle.build(
              {
                input: main,
                cwd,
                plugins: [
                  cloudflareRolldown({
                    compatibilityDate:
                      props.compatibility?.date ?? defaultCompatibilityDate,
                    compatibilityFlags: props.compatibility?.flags,
                  }),
                  plugins,
                  ...(props.build?.metafile ? [Sonda({ open: false })] : []),
                ],
                checks: {
                  // Suppress unresolved import warnings for unrelated AWS packages
                  unresolvedImport: false,
                },
              },
              {
                format: "esm",
                sourcemap: "hidden",
                minify: true,
                keepNames: true,
                dir: `.alchemy/bundles/${id}`,
              },
            );

          if (props.isExternal) {
            const bundle = yield* buildBundle();
            return bundle;
          }

          const exportMap = (props.exports ?? {}) as Record<string, unknown>;
          const allExportNames = Object.keys(exportMap).filter(
            (id) => id !== "default",
          );
          const doClasses: string[] = [];
          const wfClasses: string[] = [];
          for (const name of allExportNames) {
            if (isWorkflowExport(exportMap[name])) {
              wfClasses.push(name);
            } else if (isDurableObjectExport(exportMap[name])) {
              doClasses.push(name);
            }
          }
          const hasDoClasses = doClasses.length > 0;
          const hasWfClasses = wfClasses.length > 0;
          const script = (importPath: string) => `
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";

import { env, DurableObject${hasWfClasses ? ", WorkflowEntrypoint" : ""} } from "cloudflare:workers";
import { MinimumLogLevel } from "effect/References";
import { NodeServices } from "@effect/platform-node";
import { Stack } from "alchemy-effect/Stack";
import { WorkerEnvironment, makeDurableObjectBridge${hasWfClasses ? ", makeWorkflowBridge" : ""}, ExportedHandlerMethods } from "alchemy-effect/Cloudflare";

import entry from "${importPath}";

const tag = Context.Service("${Self.key}")
const layer =
  typeof entry?.build === "function"
    ? entry
    : Layer.effect(tag, typeof entry?.asEffect === "function" ? entry.asEffect() : entry);

const platform = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  // TODO(sam): wire this up to telemetry more directly
  Logger.layer([Logger.consolePretty()]),
);

const stack = Layer.succeed(
  Stack,
  {
    name: "${stack.name}",
    stage: "${stack.stage}",
    bindings: {},
    resources: {}
  }
);

const exportsEffect = tag.asEffect().pipe(
  Effect.flatMap(func => func.ExecutionContext.exports),
  Effect.map(exports => exports),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(stack),
      // TODO(sam): additional credentials?
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.orElse(
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
            ConfigProvider.fromUnknown(env),
          ),
        )
      ),
      Layer.provideMerge(
        Layer.succeed(
          WorkerEnvironment,
          env,
        )
      ),
      Layer.provideMerge(
        Layer.succeed(
          MinimumLogLevel,
          env.DEBUG ? "Debug" : "Info",
        )
      ),
    )
  ),
  Effect.scoped
);

// TODO(sam): we could kick this off during module init, but any I/O will break deploy
// let exportsPromise = Effect.runPromise(exportsEffect);

// for now, we delay initializing the worker until the first request
let exportsPromise;

// don't initialize the workerEffect during module init because Cloudflare does not allow I/O during module init
// we cache it synchronously (??=) to guarnatee only one initialization ever happens
const getExports = () => (exportsPromise ??= Effect.runPromise(exportsEffect))
const getExport = (name) => getExports().then(exports => exports[name]?.make)
const worker = () => getExports().then(exports => exports.default)

export default Object.fromEntries(ExportedHandlerMethods.map(
  method => [method, async (...args) => (await worker())[method](...args)])
) satisfies Required<cf.ExportedHandler>;

// export class proxy stubs for Durable Objects and Workflows
${[
  ...(hasDoClasses
    ? [
        "const DurableObjectBridge = makeDurableObjectBridge(DurableObject, getExport);",
        ...doClasses.map(
          (id) => `export class ${id} extends DurableObjectBridge("${id}") {}`,
        ),
      ]
    : []),
  ...(hasWfClasses
    ? [
        "const WorkflowBridgeFn = makeWorkflowBridge(WorkflowEntrypoint, getExport);",
        ...wfClasses.map(
          (id) => `export class ${id} extends WorkflowBridgeFn("${id}") {}`,
        ),
      ]
    : []),
].join("\n")}
`;

          return yield* buildBundle(virtualEntryPlugin(script));
        }).pipe(Artifacts.cached("build"));

      const viteBuild = Effect.fnUntraced(function* (props: WorkerProps) {
        const vite = yield* Effect.promise(() => import("vite"));
        let assetsDirectory: string | undefined;
        let serverBundle: vite.Rolldown.OutputBundle | undefined;

        yield* Effect.promise(async () => {
          const builder = await vite.createBuilder(
            {
              root: props.vite?.rootDir,
              // Declare the ssr environment so Vite 8+ creates it.
              // The cloudflare-vite-plugin config hook merges its
              // SSR-specific settings on top of this stub.
              environments: {
                ssr: {
                  build: {
                    // Prevent the SSR build from wiping the client
                    // build's output (both share the dist/ directory).
                    emptyOutDir: false,
                  },
                },
              },
              builder: {
                sharedConfigBuild: true,
              },
              plugins: [
                cloudflareVite({
                  compatibilityDate:
                    props.compatibility?.date ?? defaultCompatibilityDate,
                  compatibilityFlags: props.compatibility?.flags,
                }),
                {
                  name: "output:ssr",
                  applyToEnvironment(environment) {
                    return environment.name === "ssr";
                  },
                  generateBundle(_outputOptions, bundle) {
                    serverBundle = bundle;
                  },
                },
                {
                  name: "output:client",
                  applyToEnvironment(environment) {
                    return environment.name === "client";
                  },
                  generateBundle(outputOptions) {
                    assetsDirectory = outputOptions.dir;
                  },
                },
              ],
            },
            // This is the `useLegacyBuilder` option. The Vite CLI implementation uses `null` here.
            // Originally we used `undefined` here, but this caused the static site build to fail.
            // https://github.com/vitejs/vite/blob/a07a4bd052ac75f916391c999c408ad5f2867e61/packages/vite/src/node/cli.ts#L367
            null,
          );
          await builder.buildApp();
        });
        if (!assetsDirectory && !serverBundle) {
          return yield* Effect.die(
            new Error("Vite build produced neither server nor client output"),
          );
        }
        const [assets, bundle] = yield* Effect.all(
          [
            assetsDirectory
              ? read({
                  directory: assetsDirectory,
                  config:
                    typeof props.assets === "object" && "config" in props.assets
                      ? props.assets.config
                      : undefined,
                })
              : Effect.succeed(undefined),
            serverBundle
              ? Bundle.bundleOutputFromRolldownOutputBundle(serverBundle)
              : Effect.succeed(undefined),
          ],
          { concurrency: "unbounded" },
        );
        return { assets, bundle };
      });

      const prepareAssetsAndBundle = (id: string, props: WorkerProps) =>
        Effect.gen(function* () {
          if (props.vite) {
            const [{ assets, bundle }, input] = yield* Effect.all(
              [viteBuild(props), hashDirectory(props.vite)],
              { concurrency: "unbounded" },
            );
            return { assets, bundle, input };
          }
          const [assets, bundle] = yield* Effect.all(
            [prepareAssets(props.assets), prepareBundle(id, props)],
            { concurrency: "unbounded" },
          );
          return { assets, bundle };
        }).pipe(
          Effect.map(({ assets, bundle, input }) => ({
            assets,
            bundle: {
              main: bundle?.files[0].path,
              files: bundle?.files.map(
                (file) =>
                  new File([file.content as BlobPart], file.path, {
                    type: contentTypeFromExtension(path.extname(file.path)),
                  }),
              ),
            },
            hash: {
              assets: assets?.hash,
              bundle: bundle?.hash,
              input,
            } satisfies Worker["Attributes"]["hash"],
          })),
        );

      const putWorker = Effect.fnUntraced(function* (
        id: string,
        news: WorkerProps,
        bindings: ResourceBinding<Worker["Binding"]>[],
        olds: WorkerProps | undefined,
        output: Worker["Attributes"] | undefined,
        session: ScopedPlanStatusSession,
        existingSettings?: workers.GetScriptScriptAndVersionSettingResponse,
      ) {
        const name = yield* createWorkerName(id, news.name);
        yield* Effect.logInfo(
          `Cloudflare Worker ${olds ? "update" : "create"}: preparing bundle for ${name}`,
        );
        const { assets, bundle, hash } = yield* prepareAssetsAndBundle(
          id,
          news,
        );
        const metadataBindings = bindings.flatMap((b) => b.data.bindings ?? []);
        const expectedDurableObjectClassNames =
          getExpectedDurableObjectClassNames(metadataBindings);
        let metadataAssets:
          | workers.PutScriptRequest["metadata"]["assets"]
          | undefined;
        let keepAssets = false;
        if (assets) {
          if (output?.hash?.assets !== assets.hash) {
            yield* Effect.logInfo(
              `Cloudflare Worker ${olds ? "update" : "create"}: uploading assets for ${name}`,
            );
            const { jwt } = yield* upload(accountId, name, assets, session);
            metadataAssets = {
              jwt,
              config: assets.config,
            };
          } else {
            yield* Effect.logInfo(
              `Cloudflare Worker update: reusing existing assets for ${name}`,
            );
            metadataAssets = {
              config: assets.config,
            };
            keepAssets = true;
          }
          metadataBindings.push({
            type: "assets",
            name: "ASSETS",
          });
        }
        metadataBindings.push(
          {
            type: "plain_text",
            name: "ALCHEMY_STACK_NAME",
            text: stack.name,
          },
          {
            type: "plain_text",
            name: "ALCHEMY_STAGE",
            text: stack.stage,
          },
        );
        // Add environment variables as metadata bindings
        if (news.env) {
          for (const [key, value] of Object.entries(news.env)) {
            if (value == null) continue;
            if (Redacted.isRedacted(value)) {
              metadataBindings.push({
                type: "secret_text",
                name: key,
                text: Redacted.value(value),
              });
            } else {
              metadataBindings.push({
                type: "plain_text",
                name: key,
                text: typeof value === "string" ? value : String(value),
              });
            }
          }
        }
        yield* Effect.logInfo(
          `Cloudflare Worker ${olds ? "update" : "create"}: uploading script for ${name}`,
        );
        const size =
          bundle.files
            ?.filter((file) => !file.name.endsWith(".map"))
            .reduce((acc, file) => acc + file.size, 0) ?? 0;
        const sizeKB = size / 1024;
        const sizeMB = sizeKB / 1024;
        const bundleSize = `${sizeKB > 1024 ? `${sizeMB.toFixed(2)} MB` : `${sizeKB.toFixed(2)} KB`}`;
        yield* session.note(`Uploading worker (${bundleSize}) ...`);

        // Read existing worker settings for migration tracking
        const oldSettings =
          existingSettings ??
          (yield* getScriptSettings({
            accountId,
            scriptName: name,
          }).pipe(
            Effect.map((s) => s as typeof s | undefined),
            Effect.catch(() => Effect.succeed(undefined)),
          ));

        const oldTags = Array.from(new Set(oldSettings?.tags ?? []));
        const oldBindings = oldSettings?.bindings ?? [];

        // Parse alchemy:do:{logicalId}:{className} tags
        const oldDoClassNameByLogicalId = getDurableObjectTagMap(oldTags);
        const currentDoBindings = getDurableObjectBindings(bindings, name);
        const currentDoClassNameByLogicalId = Object.fromEntries(
          currentDoBindings.map((binding) => [
            binding.logicalId,
            binding.className,
          ]),
        );

        // Parse alchemy:migration-tag:{version}
        const oldMigrationTag = oldTags.flatMap((tag) =>
          tag.startsWith("alchemy:migration-tag:")
            ? [tag.slice("alchemy:migration-tag:".length)]
            : [],
        )[0];
        const newMigrationTag = bumpMigrationTagVersion(oldMigrationTag);

        // Compute deleted classes
        const deletedClasses: string[] = [];
        for (const [logicalId, className] of Object.entries(
          oldDoClassNameByLogicalId,
        )) {
          if (!currentDoClassNameByLogicalId[logicalId]) {
            deletedClasses.push(className);
          }
        }

        // Backward compatibility for old workers that have DO bindings but no
        // alchemy:do tags yet.
        if (Object.keys(oldDoClassNameByLogicalId).length === 0) {
          for (const oldBinding of oldBindings) {
            if (
              oldBinding.type === "durable_object_namespace" &&
              "className" in oldBinding &&
              oldBinding.className &&
              (!("scriptName" in oldBinding) ||
                !oldBinding.scriptName ||
                oldBinding.scriptName === name) &&
              !currentDoBindings.some(
                (binding) => binding.bindingName === oldBinding.name,
              )
            ) {
              deletedClasses.push(oldBinding.className);
            }
          }
        }

        // Collect container-backed class names so we can send container metadata
        const containerClassNames = new Set(
          bindings.flatMap((b) =>
            (b.data.containers ?? []).map((c) => c.className),
          ),
        );

        // Compute new and renamed classes
        const newClasses: string[] = [];
        const newSqliteClasses: string[] = [];
        const renamedClasses: { from: string; to: string }[] = [];
        for (const binding of currentDoBindings) {
          const previousClassName =
            oldDoClassNameByLogicalId[binding.logicalId];
          if (!previousClassName) {
            // Default all new Durable Object classes to SQLite. Cloudflare
            // recommends SQLite for new namespaces, and container-backed
            // Durable Objects require it.
            newSqliteClasses.push(binding.className);
          } else if (previousClassName !== binding.className) {
            renamedClasses.push({
              from: previousClassName,
              to: binding.className,
            });
          }
        }

        yield* Effect.logInfo(
          `Cloudflare Worker put: durable object reconciliation ${JSON.stringify(
            {
              oldDoClassNameByLogicalId,
              currentDoClassNameByLogicalId,
              deletedClasses,
              renamedClasses,
              newSqliteClasses,
            },
          )}`,
        );

        // Build alchemy:do:{logicalId}:{className} tags for each DO binding
        const alchemyDoTags: string[] = [];
        for (const binding of currentDoBindings) {
          alchemyDoTags.push(
            `alchemy:do:${binding.logicalId}:${binding.className}`,
          );
        }

        const metadataTags = Array.from(
          new Set([
            ...createAlchemyWorkerTags(id),
            ...alchemyDoTags,
            ...(newMigrationTag
              ? [`alchemy:migration-tag:${newMigrationTag}`]
              : []),
            ...(news.tags ?? []),
          ]),
        );

        const migrations = {
          oldTag: oldMigrationTag,
          newTag: newMigrationTag,
          newClasses,
          deletedClasses,
          renamedClasses,
          transferredClasses: [] as { from: string; to: string }[],
          newSqliteClasses,
        };

        const metadataContainers = [...containerClassNames].map(
          (className) => ({
            className,
          }),
        );

        const metadata = {
          assets: metadataAssets,
          bindings: metadataBindings,
          bodyPart: undefined,
          compatibilityDate: news.compatibility?.date ?? "2026-03-10",
          compatibilityFlags: news.compatibility?.flags,
          containers:
            metadataContainers.length > 0 ? metadataContainers : undefined,
          keepAssets,
          keepBindings: undefined,
          limits: news.limits,
          logpush: news.logpush,
          mainModule: bundle.main,
          migrations,
          observability: news.observability ?? {
            enabled: true,
            logs: {
              enabled: true,
              invocationLogs: true,
            },
          },
          placement: news.placement,
          tags: metadataTags,
          tailConsumers: undefined,
          usageModel: undefined,
        };
        const worker = yield* putScript({
          accountId,
          scriptName: name,
          metadata,
          files: bundle.files,
        }).pipe(
          Effect.catch((err) => {
            // When adopting a Worker managed by Wrangler (or after a previous
            // deploy with mismatched migrations), the old_tag precondition
            // fails. The only way to discover the actual tag is through the
            // error message — getScriptSettings is meant to return it but
            // doesn't at runtime.
            const msg = String(
              typeof err === "object" && err !== null && "message" in err
                ? err.message
                : err,
            );
            const expectedTag = msg.match(
              /when expected tag is ['"]?([^'"]+)['"]?/,
            )?.[1];
            if (expectedTag) {
              return putScript({
                accountId,
                scriptName: name,
                metadata: {
                  ...metadata,
                  migrations: {
                    ...migrations,
                    oldTag: expectedTag,
                    newTag: bumpMigrationTagVersion(expectedTag),
                  },
                },
                files: bundle.files,
              });
            }
            return Effect.fail(err as any);
          }),
        );
        const { settings, durableObjectNamespaces } =
          yield* getWorkerSettingsWithDurableObjects(
            name,
            expectedDurableObjectClassNames,
          );
        if (!olds || news.url !== olds.url) {
          const enable = news.url !== false;
          yield* session.note(
            `${enable ? "Enabling" : "Disabling"} workers.dev subdomain...`,
          );
          yield* setWorkerSubdomain(name, enable);
        }
        return {
          workerId: worker.id ?? name,
          workerName: name,
          logpush: worker.logpush ?? undefined,
          url:
            news.url !== false
              ? `https://${name}.${yield* getAccountSubdomain(accountId)}.workers.dev`
              : undefined,
          tags: settings.tags ?? metadata.tags,
          durableObjectNamespaces,
          accountId,
          hash,
        } satisfies Worker["Attributes"];
      });

      const hasChanged = Effect.fnUntraced(function* (
        id: string,
        props: WorkerProps,
        output: Worker["Attributes"],
      ) {
        if (props.vite) {
          const input = yield* hashDirectory(props.vite);
          return input !== output.hash?.input;
        }
        const [assetsHash, bundleHash] = yield* Effect.all(
          [
            "assets" in output && output.hash?.assets
              ? Effect.succeed(output.hash.assets)
              : prepareAssets(props.assets).pipe(Effect.map((a) => a?.hash)),
            prepareBundle(id, props).pipe(Effect.map((b) => b.hash)),
          ],
          { concurrency: "unbounded" },
        );
        return (
          assetsHash !== output.hash?.assets ||
          bundleHash !== output.hash?.bundle
        );
      });

      return Worker.Provider.of({
        stables: ["workerId", "workerName"],
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" };
          }
          const workerName = yield* createWorkerName(id, news.name);
          const oldWorkerName = output?.workerName
            ? output.workerName
            : yield* createWorkerName(id, olds?.name);
          if (workerName !== oldWorkerName) {
            return { action: "replace" };
          }
          if (!output) {
            return;
          }
          if (yield* hasChanged(id, news, output)) {
            return {
              action: "update",
              stables:
                oldWorkerName === workerName ? ["workerName"] : undefined,
            };
          }
        }),
        precreate: Effect.fnUntraced(function* ({ id, news, session }) {
          const name = yield* createWorkerName(id, news.name);
          const exportMap = (news.exports ?? {}) as Record<string, unknown>;
          const durableObjects = Object.keys(exportMap)
            .filter((logicalId) => isDurableObjectExport(exportMap[logicalId]))
            .map((logicalId) => ({
              logicalId,
              className: logicalId,
            }));
          const doClasses = durableObjects.map((binding) => binding.className);
          const containers = doClasses.map((className) => ({ className }));
          const alchemyDoTags = durableObjects.map(
            ({ logicalId, className }) =>
              `alchemy:do:${logicalId}:${className}`,
          );
          const tags = Array.from(
            new Set([
              ...createAlchemyWorkerTags(id),
              ...alchemyDoTags,
              ...(news.tags ?? []),
            ]),
          );
          yield* Effect.logInfo(
            `Cloudflare Worker precreate: starting ${name}`,
          );
          yield* Effect.logInfo(
            `Cloudflare Worker precreate: durable objects ${JSON.stringify(
              durableObjects,
            )}`,
          );
          const existingSettings = yield* getScriptSettings({
            accountId,
            scriptName: name,
          }).pipe(
            Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
          );
          let durableObjectNamespaces = getDurableObjectNamespaces(
            existingSettings?.bindings,
          );

          if (existingSettings) {
            if (!hasAlchemyWorkerTags(id, existingSettings.tags ?? [])) {
              return yield* Effect.die(
                `Worker "${name}" already exists but is not owned by this stack/stage/resource`,
              );
            }
            yield* Effect.logInfo(
              `Cloudflare Worker precreate: adopting existing ${name} owned by this stack/stage/resource`,
            );
          } else {
            yield* session.note("Pre-creating worker...");
            const mainModule = "main.js";
            const placeholderScript = `${doClasses.length > 0 ? 'import { DurableObject } from "cloudflare:workers";\n\n' : ""}export default { fetch() { return new Response("Alchemy worker is being deployed...") } };\n${doClasses
              .map(
                (className) =>
                  `export class ${className} extends DurableObject {}`,
              )
              .join("\n")}`;
            yield* putScript({
              accountId,
              scriptName: name,
              metadata: {
                mainModule,
                bindings:
                  doClasses.length > 0
                    ? doClasses.map((className) => ({
                        type: "durable_object_namespace" as const,
                        name: className,
                        className,
                      }))
                    : undefined,
                compatibilityDate:
                  news.compatibility?.date ?? defaultCompatibilityDate,
                compatibilityFlags: news.compatibility?.flags,
                containers,
                migrations:
                  doClasses.length > 0
                    ? {
                        oldTag: undefined,
                        newTag: undefined,
                        newClasses: [],
                        deletedClasses: [],
                        renamedClasses: [],
                        transferredClasses: [],
                        newSqliteClasses: doClasses,
                      }
                    : undefined,
                observability: news.observability ?? {
                  enabled: true,
                  logs: {
                    enabled: true,
                    invocationLogs: true,
                  },
                },
                tags,
              },
              files: [
                new File([placeholderScript], mainModule, {
                  type: "application/javascript+module",
                }),
              ],
            });
            if (doClasses.length > 0) {
              ({ durableObjectNamespaces } =
                yield* getWorkerSettingsWithDurableObjects(name, doClasses));
            }
          }

          if (existingSettings && doClasses.length > 0) {
            ({ durableObjectNamespaces } =
              yield* getWorkerSettingsWithDurableObjects(name, doClasses));
          }

          return {
            workerId: name,
            workerName: name,
            logpush: existingSettings?.logpush ?? undefined,
            url: undefined,
            tags: existingSettings?.tags ?? tags,
            durableObjectNamespaces,
            accountId,
          } satisfies Worker["Attributes"];
        }),
        read: Effect.fnUntraced(
          function* ({ id, output, olds }) {
            const workerName =
              output?.workerName ?? (yield* createWorkerName(id, olds?.name));
            yield* Effect.logInfo(
              `Cloudflare Worker read: checking ${workerName}`,
            );
            const [worker, subdomain, settings] = yield* Effect.all([
              listScripts({
                accountId,
              }).pipe(
                Effect.map((workers) =>
                  workers.result.find((worker) => worker.id === workerName),
                ),
              ),
              getScriptSubdomain({
                accountId,
                scriptName: workerName,
              }),
              getScriptSettings({
                accountId,
                scriptName: workerName,
              }),
            ]);
            if (!worker) {
              yield* Effect.logInfo(
                `Cloudflare Worker read: ${workerName} not found in script list`,
              );
              return undefined;
            }
            yield* Effect.logInfo(
              `Cloudflare Worker read: found ${workerName}`,
            );
            return {
              accountId,
              workerId: worker.id ?? workerName,
              workerName,
              logpush: worker.logpush ?? undefined,
              url: subdomain.enabled
                ? `https://${workerName}.${yield* getAccountSubdomain(accountId)}.workers.dev`
                : undefined,
              tags: settings.tags ?? undefined,
              durableObjectNamespaces: getDurableObjectNamespaces(
                settings.bindings,
              ),
            } satisfies Worker["Attributes"];
          },
          (effect) =>
            effect.pipe(
              Effect.catchTag("WorkerNotFound", () =>
                Effect.succeed(undefined),
              ),
            ),
        ),
        create: Effect.fnUntraced(function* ({
          id,
          news,
          bindings,
          output,
          session,
        }) {
          const name = yield* createWorkerName(id, news.name);
          const durableObjects = getDurableObjectBindings(bindings, name).map(
            ({ logicalId, className }) => ({
              logicalId,
              className,
            }),
          );
          yield* Effect.logInfo(`Cloudflare Worker create: starting ${name}`);
          yield* Effect.logInfo(
            `Cloudflare Worker create: durable objects ${JSON.stringify(
              durableObjects,
            )}`,
          );
          const existingSettings = yield* getScriptSettings({
            accountId,
            scriptName: name,
          }).pipe(
            Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
          );
          yield* Effect.logInfo(
            `Cloudflare Worker create: existing durable object tags ${JSON.stringify(
              (existingSettings?.tags ?? []).filter((tag) =>
                tag.startsWith("alchemy:do:"),
              ),
            )}`,
          );
          if (existingSettings) {
            yield* Effect.logInfo(
              `Cloudflare Worker create: ${name} already exists`,
            );
            if (!hasAlchemyWorkerTags(id, existingSettings.tags ?? [])) {
              return yield* Effect.die(
                `Worker "${name}" already exists but is not owned by this stack/stage/resource`,
              );
            }
            yield* Effect.logInfo(
              `Cloudflare Worker create: adopting existing ${name} owned by this stack/stage/resource`,
            );
          }
          return yield* putWorker(
            id,
            news,
            bindings,
            undefined,
            output,
            session,
            existingSettings,
          );
        }),
        update: Effect.fnUntraced(function* ({
          id,
          olds,
          news,
          output,
          bindings,
          session,
        }) {
          const durableObjects = getDurableObjectBindings(
            bindings,
            output.workerName,
          ).map(({ logicalId, className }) => ({
            logicalId,
            className,
          }));
          yield* Effect.logInfo(
            `Cloudflare Worker update: starting ${output.workerName}`,
          );
          yield* Effect.logInfo(
            `Cloudflare Worker update: durable objects ${JSON.stringify(
              durableObjects,
            )}`,
          );
          yield* Effect.logInfo(
            `Cloudflare Worker update: previous durable object tags ${JSON.stringify(
              (output.tags ?? []).filter((tag) =>
                tag.startsWith("alchemy:do:"),
              ),
            )}`,
          );
          return yield* putWorker(id, news, bindings, olds, output, session);
        }),
        delete: Effect.fnUntraced(function* ({ output }) {
          yield* Effect.logInfo(
            `Cloudflare Worker delete: deleting ${output.workerName}`,
          );
          yield* deleteScript({
            accountId: output.accountId,
            scriptName: output.workerName,
          }).pipe(Effect.catchTag("WorkerNotFound", () => Effect.void));
        }),
        tail: ({ output }) => {
          const runTailSession = Effect.gen(function* () {
            const { id: tailId, url } = yield* createScriptTail({
              scriptName: output.workerName,
              accountId: output.accountId,
              body: { filters: [] },
            });

            const socket = yield* Socket.makeWebSocket(url, {
              protocols: ["trace-v1"],
            });

            const queue = yield* Queue.make<LogLine, Cause.Done>();

            yield* socket
              .runRaw((raw) => {
                const text =
                  typeof raw === "string" ? raw : new TextDecoder().decode(raw);
                const data: TailEventMessage = JSON.parse(text);
                const eventTs = new Date(data.eventTimestamp ?? Date.now());

                if (data.event && "request" in data.event) {
                  const reqEvent = data.event;
                  const pathname = (() => {
                    try {
                      return new URL(reqEvent.request.url).pathname;
                    } catch {
                      return reqEvent.request.url;
                    }
                  })();
                  const status = reqEvent.response?.status ?? 500;
                  Queue.offerUnsafe(queue, {
                    timestamp: eventTs,
                    message: `${reqEvent.request.method} ${pathname} > ${status} (cpu: ${Math.round(data.cpuTime)}ms, wall: ${Math.round(data.wallTime)}ms)`,
                  });
                }

                for (const log of data.logs) {
                  const msg = log.message.join(" ");
                  Queue.offerUnsafe(queue, {
                    timestamp: new Date(log.timestamp),
                    message: log.level === "log" ? msg : `${log.level}: ${msg}`,
                  });
                }

                for (const exception of data.exceptions) {
                  Queue.offerUnsafe(queue, {
                    timestamp: new Date(exception.timestamp),
                    message: `${exception.name} ${exception.message}\n${exception.stack}`,
                  });
                }
              })
              .pipe(
                Effect.ensuring(
                  Effect.all([
                    deleteScriptTail({
                      scriptName: output.workerName,
                      id: tailId,
                      accountId: output.accountId,
                    }).pipe(Effect.ignore),
                    Queue.end(queue),
                  ]),
                ),
                Effect.ignore,
                Effect.forkChild(),
              );

            return Stream.fromQueue(queue);
          });

          return Stream.unwrap(runTailSession).pipe(
            Stream.repeat(Schedule.spaced("1 second")),
          );
        },
        logs: ({ output, options }) =>
          telemetry.queryLogs({
            accountId: output.accountId,
            filters: [
              {
                key: "$workers.scriptName",
                operation: "eq",
                type: "string",
                value: output.workerName,
              },
            ],
            options,
          }),
      });
    }),
  );

interface TailEventMessage {
  eventTimestamp?: number;
  wallTime: number;
  cpuTime: number;
  truncated: boolean;
  outcome: string;
  scriptName: string;
  exceptions: {
    name: string;
    message: string;
    stack: string;
    timestamp: string;
  }[];
  logs: {
    message: string[];
    level: string;
    timestamp: string;
  }[];
  event:
    | {
        request: { method: string; url: string };
        response?: { status: number };
      }
    | null
    | undefined;
}

const contentTypeFromExtension = (extension: string) => {
  switch (extension) {
    case ".wasm":
      return "application/wasm";
    case ".txt":
    case ".html":
    case ".sql":
    case ".custom":
      return "text/plain";
    case ".bin":
      return "application/octet-stream";
    case ".mjs":
    case ".js":
      return "application/javascript+module";
    case ".cjs":
      return "application/javascript";
    case ".map":
      return "application/source-map";
    default:
      return "application/octet-stream";
  }
};

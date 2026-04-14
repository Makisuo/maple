import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { fromCloudflareFetcher, type Fetcher } from "../Fetcher.ts";
import { makeRpcStub } from "./Rpc.ts";
import { Worker, WorkerEnvironment } from "./Worker.ts";

type DynamicWorkerTypeId = "Cloudflare.DynamicWorker";
const DynamicWorkerTypeId: DynamicWorkerTypeId = "Cloudflare.DynamicWorker";

/**
 * Options for loading a dynamic worker at runtime.
 */
export interface DynamicWorkerLoadOptions {
  /**
   * Compatibility date for the dynamic worker runtime.
   */
  compatibilityDate: string;
  /**
   * Name of the main module entry point (must match a key in `modules`).
   */
  mainModule: string;
  /**
   * Map of module names to source code strings.
   */
  modules: Record<string, string>;
  /**
   * Environment bindings to pass to the dynamic worker.
   */
  env?: Record<string, unknown>;
  /**
   * Controls outbound network access. Set to `null` to block all outbound
   * fetch/connect calls. Pass an RPC stub to intercept them.
   */
  globalOutbound?: null | unknown;
}

/**
 * An entrypoint stub on a loaded dynamic worker.
 * Extends `Fetcher` for Effect-native HTTP, and proxies arbitrary
 * RPC method calls as Effects.
 */
export type DynamicWorkerEntrypoint<Shape = unknown> = Fetcher & {
  [K in keyof Shape]: Shape[K];
};

/**
 * A loaded dynamic worker instance. Extends `Fetcher` for Effect-native
 * HTTP on the default entrypoint, plus `.getEntrypoint()` for named ones.
 */
export interface DynamicWorkerInstance extends Fetcher {
  /**
   * Get a named entrypoint (or the default entrypoint if no name is given).
   * Returns a Fetcher + RPC stub where every method call yields an Effect.
   */
  getEntrypoint<Shape = unknown>(name?: string): DynamicWorkerEntrypoint<Shape>;
}

/**
 * The handle returned by `DynamicWorker(name)`. Provides a `.load()` method
 * for spinning up isolated dynamic workers at runtime.
 */
export type DynamicWorkerLoader = {
  Type: DynamicWorkerTypeId;
  name: string;
  /**
   * Load a dynamic worker with the given options. The returned instance
   * exposes `.getEntrypoint()` and `.fetch()` for calling into the worker.
   */
  load(options: DynamicWorkerLoadOptions): DynamicWorkerInstance;
};

/**
 * Load and run ephemeral Workers at runtime from inline JavaScript
 * modules.
 *
 * `DynamicWorkerLoader` registers a `worker_loader` binding on the
 * parent Worker at deploy time. At runtime you call `.load()` with
 * inline module source code and get back a fully typed Worker
 * instance you can `fetch` or call RPC methods on. Each loaded
 * Worker runs in its own isolate with full sandboxing.
 *
 * This is useful for evaluating user-provided code, running
 * untrusted plugins, or dynamically generating Workers from
 * templates.
 *
 * @resource
 *
 * @section Creating a Loader
 * Yield `Cloudflare.DynamicWorkerLoader` in your Worker's init
 * phase to register the binding. The string argument becomes the
 * binding name on the deployed Worker.
 *
 * @example Registering a loader
 * ```typescript
 * // init
 * const loader = yield* Cloudflare.DynamicWorkerLoader("Loader");
 * ```
 *
 * @section Loading a Worker
 * Call `loader.load()` with a compatibility date, a main module
 * name, and a map of module names to source code strings. The
 * returned instance exposes `.fetch()` for HTTP and RPC methods
 * for named entrypoints.
 *
 * @example Loading and calling a dynamic Worker
 * ```typescript
 * const worker = loader.load({
 *   compatibilityDate: "2026-01-28",
 *   mainModule: "worker.js",
 *   modules: {
 *     "worker.js": `export default {
 *       async fetch(request) {
 *         return new Response("Hello from dynamic worker!");
 *       }
 *     }`,
 *   },
 * });
 *
 * const response = yield* worker.fetch(
 *   HttpClientRequest.get("https://worker/"),
 * );
 * ```
 *
 * @section Sandboxing
 * Set `globalOutbound` to `null` to block all outbound network
 * access from the dynamic Worker, or pass an RPC stub to intercept
 * and proxy outbound requests.
 *
 * @example Blocking outbound access
 * ```typescript
 * const worker = loader.load({
 *   compatibilityDate: "2026-01-28",
 *   mainModule: "worker.js",
 *   modules: {
 *     "worker.js": `export default {
 *       async fetch(req) {
 *         // fetch() calls from here will fail
 *         return new Response("sandboxed");
 *       }
 *     }`,
 *   },
 *   globalOutbound: null,
 * });
 * ```
 *
 * @section Named Entrypoints
 * If the dynamic Worker exports named entrypoints, use
 * `.getEntrypoint(name)` to get a typed stub for calling its
 * methods.
 *
 * @example Calling a named entrypoint
 * ```typescript
 * const worker = loader.load({ ... });
 * const api = worker.getEntrypoint<{ greet: (name: string) => Effect.Effect<string> }>("api");
 * const greeting = yield* api.greet("world");
 * ```
 */
export const DynamicWorkerLoader = Effect.fnUntraced(function* (name: string) {
  const worker = yield* Worker;

  yield* worker.bind`${name}`({
    bindings: [{ type: "worker_loader", name } as any],
  });

  const binding = yield* Effect.serviceOption(WorkerEnvironment).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.flatMap((env) => {
      if (env === undefined) {
        return Effect.succeed(undefined as any);
      }
      const loader = env[name];
      if (!loader) {
        return Effect.die(
          new Error(`DynamicWorker '${name}' not found in env`),
        );
      }
      return Effect.succeed(loader);
    }),
  );

  const self: DynamicWorkerLoader = {
    Type: DynamicWorkerTypeId,
    name,
    load: (options: DynamicWorkerLoadOptions): DynamicWorkerInstance =>
      wrapLoadedWorker(binding.load(options)),
  };

  return self;
});

const wrapEntrypoint = <Shape>(raw: any): DynamicWorkerEntrypoint<Shape> =>
  Object.assign(makeRpcStub<any>(raw), fromCloudflareFetcher(raw));

const wrapLoadedWorker = (raw: any): DynamicWorkerInstance => {
  const defaultEntrypoint = fromCloudflareFetcher(raw.getEntrypoint());
  return {
    ...defaultEntrypoint,
    getEntrypoint: <Shape>(name?: string) =>
      wrapEntrypoint<Shape>(
        name ? raw.getEntrypoint(name) : raw.getEntrypoint(),
      ),
  };
};

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
 * Declare a Dynamic Worker loader binding inside a Worker program.
 *
 * At deploy time this registers a `worker_loader` binding on the parent
 * Worker. At runtime it exposes an Effect-wrapped interface for loading
 * and calling into dynamic workers.
 *
 * @example
 * ```typescript
 * const loader = yield* DynamicWorker("LOADER");
 *
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
 *   globalOutbound: null,
 * });
 *
 * const response = yield* worker.fetch(request);
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

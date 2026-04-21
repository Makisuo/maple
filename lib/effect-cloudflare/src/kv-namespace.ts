// Simplified port of alchemy-effect's KV namespace binding:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/KV/KVNamespaceBinding.ts
//
// Upstream distinguishes a `KVNamespace` resource (IaC — create/delete
// namespaces via the Cloudflare API) from the `KVNamespaceBinding` service
// (runtime — wraps the binding). We keep the runtime half and replace the
// resource with a lightweight token: `KVNamespace("MY_KV")` records the env
// var name from wrangler.jsonc — nothing more.
//
// API surface matches upstream so `yield* KVNamespace.bind(MY_KV)` is a
// source-compatible call.
import type * as runtime from "@cloudflare/workers-types"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { WorkerEnvironment } from "./worker-environment.ts"

export class KVNamespaceError extends Data.TaggedError("KVNamespaceError")<{
  message: string
  cause: unknown
}> {}

/**
 * A reference to a KV namespace binding declared in wrangler.jsonc.
 * `logicalId` is the env var name (e.g. `"MY_KV"`).
 */
export interface KVNamespaceToken {
  readonly Type: "Cloudflare.KVNamespace"
  readonly LogicalId: string
}

const makeToken = (logicalId: string): KVNamespaceToken => ({
  Type: "Cloudflare.KVNamespace",
  LogicalId: logicalId,
})

export interface KVNamespaceClient<Key extends string = string> {
  raw: Effect.Effect<runtime.KVNamespace, never, WorkerEnvironment>
  get(
    key: Key,
    options?: Partial<runtime.KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<string | null, KVNamespaceError, WorkerEnvironment>
  get(
    key: Key,
    type: "text",
  ): Effect.Effect<string | null, KVNamespaceError, WorkerEnvironment>
  get<ExpectedValue = unknown>(
    key: Key,
    type: "json",
  ): Effect.Effect<ExpectedValue | null, KVNamespaceError, WorkerEnvironment>
  get(
    key: Key,
    type: "arrayBuffer",
  ): Effect.Effect<ArrayBuffer | null, KVNamespaceError, WorkerEnvironment>
  get(
    key: Key,
    type: "stream",
  ): Effect.Effect<ReadableStream | null, KVNamespaceError, WorkerEnvironment>
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options?: Partial<runtime.KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<
    runtime.KVNamespaceGetWithMetadataResult<string, Metadata>,
    KVNamespaceError,
    WorkerEnvironment
  >
  list<Metadata = unknown>(
    options?: runtime.KVNamespaceListOptions,
  ): Effect.Effect<
    runtime.KVNamespaceListResult<Metadata, Key>,
    KVNamespaceError,
    WorkerEnvironment
  >
  put(
    key: Key,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: runtime.KVNamespacePutOptions,
  ): Effect.Effect<void, KVNamespaceError, WorkerEnvironment>
  delete(key: Key): Effect.Effect<void, KVNamespaceError, WorkerEnvironment>
}

const makeClient = (token: KVNamespaceToken): KVNamespaceClient => {
  const env = WorkerEnvironment.asEffect()
  const raw = env.pipe(
    Effect.map(
      (e) => (e as Record<string, runtime.KVNamespace>)[token.LogicalId],
    ),
  )
  const tryPromise = <T>(
    fn: () => Promise<T>,
  ): Effect.Effect<T, KVNamespaceError> =>
    Effect.tryPromise({
      try: fn,
      catch: (cause) =>
        new KVNamespaceError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    })

  const use = <T>(
    fn: (raw: runtime.KVNamespace<string>) => Promise<T>,
  ): Effect.Effect<T, KVNamespaceError, WorkerEnvironment> =>
    raw.pipe(Effect.flatMap((r) => tryPromise(() => fn(r))))

  return {
    raw,
    get: (...args: Parameters<runtime.KVNamespace["get"]>) =>
      use((r) => (r.get as any)(...args)),
    getWithMetadata: (
      ...args: Parameters<runtime.KVNamespace["getWithMetadata"]>
    ) => use((r) => (r.getWithMetadata as any)(...args)),
    put: (...args: Parameters<runtime.KVNamespace["put"]>) =>
      use((r) => r.put(...args)),
    list: (...args: Parameters<runtime.KVNamespace["list"]>) =>
      use((r) => r.list(...args)),
    delete: (...args: Parameters<runtime.KVNamespace["delete"]>) =>
      use((r) => r.delete(...args)),
  } as unknown as KVNamespaceClient
}

/**
 * Declare a KV namespace binding by env var name.
 *
 * ```ts
 * export const MY_KV = KVNamespace("MY_KV")
 *
 * // Then in worker handler:
 * const kv = yield* KVNamespace.bind(MY_KV)
 * yield* kv.put("key", "value")
 * ```
 */
export const KVNamespace = Object.assign(
  (logicalId: string): KVNamespaceToken => makeToken(logicalId),
  {
    bind: (
      token: KVNamespaceToken,
    ): Effect.Effect<KVNamespaceClient, never, never> =>
      Effect.succeed(makeClient(token)),
  },
)

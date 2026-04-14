import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { HttpEffect } from "../../Http.ts";
import * as Output from "../../Output.ts";
import type { PlatformServices } from "../../Platform.ts";
import { effectClass, taggedFunction } from "../../Util/effect.ts";
import { makeRpcStub } from "./Rpc.ts";
import { fromWebSocket, type DurableWebSocket } from "./WebSocket.ts";
import { Worker, WorkerEnvironment, type WorkerServices } from "./Worker.ts";

export interface DurableObjectExport {
  readonly kind: "durableObject";
  readonly make: (
    state: cf.DurableObjectState,
    env: any,
  ) => Effect.Effect<Record<string, unknown>>;
}

export const isDurableObjectExport = (
  value: unknown,
): value is DurableObjectExport =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as any).kind === "durableObject";

export type DurableObjectId = cf.DurableObjectId;
export type DurableObjectJurisdiction = cf.DurableObjectJurisdiction;
export type DurableObjectNamespaceGetDurableObjectOptions =
  cf.DurableObjectNamespaceGetDurableObjectOptions;

export type AlarmInvocationInfo = cf.AlarmInvocationInfo;

type TypeId = "Cloudflare.DurableObjectNamespace";
const TypeId = "Cloudflare.DurableObjectNamespace";

export interface DurableObjectNamespace<Shape = unknown> {
  Type: TypeId;
  name: string;
  namespaceId: Output.Output<string>;
  getByName: (name: string) => DurableObjectStub<Shape>;
  newUniqueId: () => DurableObjectId;
  idFromName: (name: string) => DurableObjectId;
  idFromString: (id: string) => DurableObjectId;
  get: (
    id: DurableObjectId,
    options?: DurableObjectNamespaceGetDurableObjectOptions,
  ) => DurableObjectStub<Shape>;
  jurisdiction: (
    jurisdiction: DurableObjectJurisdiction,
  ) => DurableObjectNamespace<Shape>;
}

export interface DurableObjectShape {
  fetch?: HttpEffect<DurableObjectState>;
  alarm?: (
    alarmInfo?: AlarmInvocationInfo,
  ) => Effect.Effect<void, never, never>;
  webSocketMessage?: (
    socket: DurableWebSocket,
    message: string | Uint8Array,
  ) => Effect.Effect<void>;
  webSocketClose?: (
    socket: DurableWebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void>;
}

export type DurableObjectServices =
  | DurableObjectNamespace
  | DurableObjectState
  | WorkerServices
  | PlatformServices;

export interface DurableObjectNamespaceClass extends Effect.Effect<
  DurableObjectNamespace,
  never,
  DurableObjectNamespace
> {
  <Self>(): {
    <Shape, InitReq = never>(
      name: string,
      impl: Effect.Effect<
        Effect.Effect<Shape, never, DurableObjectServices>,
        never,
        InitReq
      >,
    ): Effect.Effect<
      DurableObjectNamespace<Self>,
      never,
      Worker | Exclude<InitReq, DurableObjectServices>
    > & {
      new (_: never): Shape;
    };
  };
  <Shape, InitReq = never>(
    name: string,
    impl: Effect.Effect<
      Effect.Effect<Shape, never, DurableObjectServices>,
      never,
      InitReq
    >,
  ): Effect.Effect<
    DurableObjectNamespace<Shape>,
    never,
    Worker | Exclude<InitReq, DurableObjectServices>
  >;
}

export class DurableObjectNamespaceScope extends Context.Service<
  DurableObjectNamespaceScope,
  DurableObjectNamespace
>()("Cloudflare.DurableObjectNamespace") {}

/**
 * A Cloudflare Durable Object namespace that manages globally unique, stateful
 * instances with WebSocket hibernation support.
 *
 * A Durable Object uses a two-phase pattern with two nested `Effect.gen`
 * blocks. The outer Effect resolves shared dependencies (other DOs,
 * containers, etc.). The inner Effect runs once per instance and returns
 * the object's public methods and WebSocket handlers.
 *
 * ```typescript
 * Effect.gen(function* () {
 *   // Phase 1: resolve shared dependencies
 *   const db = yield* Cloudflare.D1Connection.bind(MyDB);
 *
 *   return Effect.gen(function* () {
 *     // Phase 2: per-instance setup and public API
 *     const state = yield* Cloudflare.DurableObjectState;
 *
 *     return {
 *       save: (data: string) => db.exec("INSERT ..."),
 *       fetch: Effect.gen(function* () { ... }),
 *       webSocketMessage: Effect.fnUntraced(function* (ws, msg) { ... }),
 *     };
 *   });
 * })
 * ```
 *
 * There are two ways to define a Durable Object. See the
 * {@link https://alchemy.run/concepts/platform | Platform concept} page
 * for the full explanation.
 *
 * - **Inline** — Effect implementation passed directly, single file.
 * - **Modular** — class and implementation in separate files for tree-shaking.
 *
 * @resource
 *
 * @section Inline Durable Objects
 * Pass the Effect implementation as the second argument. This is the
 * simplest approach — everything lives in one file. Convenient when
 * the DO doesn't need to be referenced by other Workers or DOs that
 * would pull in its runtime dependencies.
 *
 * @example Inline Durable Object
 * ```typescript
 * export default class Counter extends Cloudflare.DurableObjectNamespace<Counter>()(
 *   "Counter",
 *   Effect.gen(function* () {
 *     // init: bind resources
 *     const db = yield* Cloudflare.D1Connection.bind(MyDB);
 *
 *     return Effect.gen(function* () {
 *       const state = yield* Cloudflare.DurableObjectState;
 *       const count = (yield* state.storage.get<number>("count")) ?? 0;
 *
 *       return {
 *         // runtime: use them
 *         increment: () =>
 *           Effect.gen(function* () {
 *             const next = count + 1;
 *             yield* state.storage.put("count", next);
 *             return next;
 *           }),
 *         get: () => Effect.succeed(count),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @section Modular Durable Objects
 * When a Worker and a DO reference each other, or multiple Workers
 * bind the same DO, define the class separately from its `.make()`
 * call. The class is a lightweight identifier; `.make()` provides
 * the runtime implementation as an `export default`. Rolldown treats
 * `.make()` as pure, so the bundler tree-shakes it and all its
 * runtime dependencies out of any consumer's bundle.
 *
 * The class and `.make()` can live in the same file. This is the
 * same pattern used by `Worker` and `Container`.
 *
 * @example Modular Durable Object (class + .make() in one file)
 * ```typescript
 * // src/Counter.ts
 * export default class Counter extends Cloudflare.DurableObjectNamespace<Counter>()(
 *   "Counter",
 * ) {}
 *
 * export default Counter.make(
 *   Effect.gen(function* () {
 *     // init: bind resources
 *     const db = yield* Cloudflare.D1Connection.bind(MyDB);
 *
 *     return Effect.gen(function* () {
 *       const state = yield* Cloudflare.DurableObjectState;
 *       const count = (yield* state.storage.get<number>("count")) ?? 0;
 *
 *       return {
 *         // runtime: use them
 *         increment: () =>
 *           Effect.gen(function* () {
 *             const next = count + 1;
 *             yield* state.storage.put("count", next);
 *             yield* db.prepare("INSERT INTO logs (count) VALUES (?)").bind(next).run();
 *             return next;
 *           }),
 *         get: () => Effect.succeed(count),
 *       };
 *     });
 *   }),
 * );
 * ```
 *
 * @example Binding a modular DO from a Worker
 * ```typescript
 * // imports Counter; bundler tree-shakes .make()
 * import Counter from "./Counter.ts";
 *
 * // init
 * const counters = yield* Counter;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const counter = counters.getByName("user-123");
 *     return HttpServerResponse.text(String(yield* counter.get()));
 *   }),
 * };
 * ```
 *
 * @section RPC Methods
 * Any function you return from the inner Effect becomes an RPC method
 * that Workers can call through a stub. Methods must return an `Effect`.
 * The caller gets a fully typed stub — if your DO returns `increment`
 * and `get`, the stub exposes `counter.increment()` and `counter.get()`.
 *
 * @example Defining RPC methods
 * ```typescript
 * return {
 *   increment: () => Effect.succeed(++count),
 *   get: () => Effect.succeed(count),
 *   reset: () => Effect.sync(() => { count = 0; }),
 * };
 * ```
 *
 * @section Accessing Instance State
 * Each Durable Object instance has its own transactional key-value
 * storage via `Cloudflare.DurableObjectState`. Use `storage.get` and
 * `storage.put` inside the inner Effect to persist data across requests
 * and restarts.
 *
 * @example Reading and writing durable storage
 * ```typescript
 * const state = yield* Cloudflare.DurableObjectState;
 *
 * yield* state.storage.put("counter", 42);
 * const value = yield* state.storage.get("counter");
 * ```
 *
 * @section WebSocket Hibernation
 * Durable Objects support WebSocket hibernation — the runtime can
 * evict the object from memory while keeping connections open. Use
 * `Cloudflare.upgrade()` to accept a connection, and return
 * `webSocketMessage` / `webSocketClose` handlers to process events
 * when the object wakes back up.
 *
 * @example Accepting a WebSocket connection
 * ```typescript
 * return {
 *   fetch: Effect.gen(function* () {
 *     const [response, socket] = yield* Cloudflare.upgrade();
 *     socket.serializeAttachment({ id: crypto.randomUUID() });
 *     return response;
 *   }),
 * };
 * ```
 *
 * @example Handling messages and close events
 * ```typescript
 * return {
 *   webSocketMessage: Effect.fnUntraced(function* (
 *     socket: Cloudflare.DurableWebSocket,
 *     message: string | Uint8Array,
 *   ) {
 *     const text = typeof message === "string"
 *       ? message
 *       : new TextDecoder().decode(message);
 *     // process the message
 *   }),
 *   webSocketClose: Effect.fnUntraced(function* (
 *     ws: Cloudflare.DurableWebSocket,
 *     code: number,
 *     reason: string,
 *   ) {
 *     yield* ws.close(code, reason);
 *   }),
 * };
 * ```
 *
 * @example Recovering sessions after hibernation
 * ```typescript
 * const state = yield* Cloudflare.DurableObjectState;
 * const sockets = yield* state.getWebSockets();
 *
 * for (const socket of sockets) {
 *   const data = socket.deserializeAttachment<{ id: string }>();
 *   // re-populate your session map
 * }
 * ```
 *
 * @section Using from a Worker
 * Yield the DO class in your Worker's init phase to get a namespace
 * handle. Call `getByName` or `getById` to get a typed stub, then
 * call any RPC method or forward an HTTP request with `fetch`.
 *
 * @example Calling RPC methods
 * ```typescript
 * // init
 * const counters = yield* Counter;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const counter = counters.getByName("user-123");
 *     yield* counter.increment();
 *     const value = yield* counter.get();
 *     return HttpServerResponse.text(String(value));
 *   }),
 * };
 * ```
 *
 * @example Forwarding an HTTP request
 * ```typescript
 * // init
 * const rooms = yield* Room;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const request = yield* HttpServerRequest;
 *     const room = rooms.getByName(roomId);
 *     return yield* room.fetch(request);
 *   }),
 * };
 * ```
 */
export const DurableObjectNamespace: DurableObjectNamespaceClass =
  taggedFunction(DurableObjectNamespaceScope, ((
    ...args:
      | []
      | [
          name: string,
          impl: Effect.Effect<
            Effect.Effect<
              DurableObjectNamespace<any>,
              never,
              DurableObjectState
            >
          >,
        ]
  ) =>
    args.length === 0
      ? DurableObjectNamespace
      : effectClass(
          Effect.gen(function* () {
            const [namespace, impl] = args;
            const worker = yield* Worker;

            yield* worker.bind`${namespace}`({
              // TODO(sam): automate class migrations, probably in the provider
              bindings: [
                {
                  type: "durable_object_namespace",
                  name: namespace,
                  className: namespace,
                  // scriptName:
                  //   binding.scriptName === props.workerName
                  //     ? undefined
                  //     : binding.scriptName,
                  // environment: binding.environment,
                  // namespaceId: binding.namespaceId,
                },
              ],
            });

            const services =
              yield* Effect.context<Effect.Services<typeof impl>>();

            yield* worker.export(namespace, {
              kind: "durableObject",
              make: (state: cf.DurableObjectState, env: any) => {
                const doState = fromDurableObjectState(state);
                return constructor.pipe(
                  Effect.provideContext(services),
                  Effect.provideService(DurableObjectState, doState),
                  Effect.provideService(WorkerEnvironment, env),
                  Effect.map((methods: any) => {
                    console.log(
                      "[DurableObject] wrapping methods:",
                      Object.keys(methods),
                      "own:",
                      Object.getOwnPropertyNames(methods),
                    );
                    const wrapped: Record<string, unknown> = {};
                    for (const key of Object.getOwnPropertyNames(methods)) {
                      const value = methods[key];
                      if (Effect.isEffect(value)) {
                        wrapped[key] = (
                          value as Effect.Effect<any, any, any>
                        ).pipe(
                          Effect.provideService(DurableObjectState, doState),
                        );
                      } else if (typeof value === "function") {
                        wrapped[key] = (...args: unknown[]) => {
                          const result = (value as Function)(...args);
                          if (Effect.isEffect(result)) {
                            return (
                              result as Effect.Effect<any, any, any>
                            ).pipe(
                              Effect.provideService(
                                DurableObjectState,
                                doState,
                              ),
                            );
                          }
                          return result;
                        };
                      } else {
                        wrapped[key] = value;
                      }
                    }
                    return wrapped;
                  }),
                );
              },
            } satisfies DurableObjectExport);

            const binding = yield* Effect.serviceOption(WorkerEnvironment).pipe(
              Effect.map(Option.getOrUndefined),
              Effect.flatMap((env) => {
                if (env === undefined) {
                  // should be fine to return undefined here (it is only undefined at plantime)
                  return Effect.succeed(undefined);
                }
                const ns = env[namespace];
                if (!ns) {
                  return Effect.die(
                    new Error(
                      `DurableObjectNamespace '${namespace}' not found`,
                    ),
                  );
                } else if (typeof ns.getByName === "function") {
                  return Effect.succeed(ns);
                } else {
                  return Effect.die(
                    new Error(
                      `DurableObjectNamespace '${namespace}' is not a DurableObjectNamespace`,
                    ),
                  );
                }
              }),
            );

            const namespaceId = worker.durableObjectNamespaces.pipe(
              Output.map(
                (durableObjectNamespaces) =>
                  durableObjectNamespaces?.[namespace],
              ),
            );

            const self = {
              Type: TypeId,
              LogicalId: namespace,
              name: namespace,
              namespaceId,
              getByName: (name: string) => makeRpcStub(binding.getByName(name)),
              // newUniqueId: () => use((ns) => ns.newUniqueId()),
              // idFromName: (name: string) => use((ns) => ns.idFromName(name)),
              // idFromString: (id: string) => use((ns) => ns.idFromString(id)),
              // get: (
              //   id: cf.DurableObjectId,
              //   options?: cf.DurableObjectNamespaceGetDurableObjectOptions,
              // ) => use((ns) => makeRpcStub(ns.get(id, options))),
              // jurisdiction: (jurisdiction: cf.DurableObjectJurisdiction) =>
              //   use((ns) => ns.jurisdiction(jurisdiction) as any),
            };

            const constructor = yield* impl.pipe(
              Effect.provideService(DurableObjectNamespaceScope, self as any),
            );

            return self;
          }),
        )) as any);

export type DurableObjectStub<Shape> = {
  // TODO(sam): do we need to transform? hopefully not
  [key in keyof Shape]: Shape[key];
} & {
  fetch: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError,
    never
  >;
};

export class DurableObjectState extends Context.Service<
  DurableObjectState,
  {
    // TODO(sam): is this needed when we have Effect?
    // waitUntil(promise: Promise<any>): Effect.Effect<void>;

    // TODO(sam): what are these? Where do they come from?
    // readonly props: Props;

    readonly id: cf.DurableObjectId;
    readonly storage: DurableObjectStorage;
    // TODO(sam): effect-native interface for container
    container?: cf.Container;
    blockConcurrencyWhile<T>(
      callback: () => Effect.Effect<T>,
    ): Effect.Effect<T>;
    acceptWebSocket(ws: DurableWebSocket, tags?: string[]): Effect.Effect<void>;
    getWebSockets(tag?: string): Effect.Effect<DurableWebSocket[]>;
    setWebSocketAutoResponse(
      maybeReqResp?: cf.WebSocketRequestResponsePair,
    ): Effect.Effect<void>;
    getWebSocketAutoResponse(): Effect.Effect<cf.WebSocketRequestResponsePair | null>;
    getWebSocketAutoResponseTimestamp(
      ws: cf.WebSocket,
    ): Effect.Effect<Date | null>;
    setHibernatableWebSocketEventTimeout(
      timeoutMs?: number,
    ): Effect.Effect<void>;
    getHibernatableWebSocketEventTimeout(): Effect.Effect<number | null>;
    getTags(ws: cf.WebSocket): Effect.Effect<string[]>;
    abort(reason?: string): Effect.Effect<void>;
  }
>()("Cloudflare.DurableObjectState") {}

export interface DurableObjectTransaction {
  get<T = unknown>(
    key: string,
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<T | undefined>;
  get<T = unknown>(
    keys: string[],
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<Map<string, T>>;
  list<T = unknown>(
    options?: cf.DurableObjectListOptions,
  ): Effect.Effect<Map<string, T>>;
  put<T>(
    key: string,
    value: T,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void>;
  put<T>(
    entries: Record<string, T>,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void>;
  delete(
    key: string,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<boolean>;
  delete(
    keys: string[],
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<number>;
  rollback(): Effect.Effect<void>;
  getAlarm(
    options?: cf.DurableObjectGetAlarmOptions,
  ): Effect.Effect<number | null>;
  setAlarm(
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ): Effect.Effect<void>;
  deleteAlarm(options?: cf.DurableObjectSetAlarmOptions): Effect.Effect<void>;
}
export interface DurableObjectStorage {
  get<T = unknown>(
    key: string,
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<T | undefined>;
  get<T = unknown>(
    keys: string[],
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<Map<string, T>>;
  list<T = unknown>(
    options?: cf.DurableObjectListOptions,
  ): Effect.Effect<Map<string, T>>;
  put<T>(
    key: string,
    value: T,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void>;
  put<T>(
    entries: Record<string, T>,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void>;
  delete(
    key: string,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<boolean>;
  delete(
    keys: string[],
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<number>;
  deleteAll(options?: cf.DurableObjectPutOptions): Effect.Effect<void>;
  transaction<T>(
    closure: (txn: DurableObjectTransaction) => Effect.Effect<T>,
  ): Effect.Effect<T>;
  getAlarm(
    options?: cf.DurableObjectGetAlarmOptions,
  ): Effect.Effect<number | null>;
  setAlarm(
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ): Effect.Effect<void>;
  deleteAlarm(options?: cf.DurableObjectSetAlarmOptions): Effect.Effect<void>;
  sync(): Effect.Effect<void>;
  sql: cf.SqlStorage;
  kv: cf.SyncKvStorage;
  transactionSync<T>(closure: () => T): T;
  getCurrentBookmark(): Effect.Effect<string>;
  getBookmarkForTime(timestamp: number | Date): Effect.Effect<string>;
  onNextSessionRestoreBookmark(bookmark: string): Effect.Effect<string>;
}

const fromDurableObjectState = (
  state: cf.DurableObjectState,
): DurableObjectState["Service"] => ({
  id: state.id,
  container: state.container,
  storage: fromDurableObjectStorage(state.storage),
  blockConcurrencyWhile: <T>(callback: () => Effect.Effect<T>) =>
    Effect.tryPromise(() =>
      state.blockConcurrencyWhile(() => Effect.runPromise(callback())),
    ),
  acceptWebSocket: (ws: DurableWebSocket, tags?: string[]) =>
    Effect.sync(() => state.acceptWebSocket(ws.ws, tags)),
  getWebSockets: (tag?: string) =>
    Effect.sync(() => state.getWebSockets(tag).map(fromWebSocket)),
  setWebSocketAutoResponse: (maybeReqResp?: cf.WebSocketRequestResponsePair) =>
    Effect.sync(() => state.setWebSocketAutoResponse(maybeReqResp)),
  getWebSocketAutoResponse: () =>
    Effect.sync(() => state.getWebSocketAutoResponse()),
  getWebSocketAutoResponseTimestamp: (ws: cf.WebSocket) =>
    Effect.sync(() => state.getWebSocketAutoResponseTimestamp(ws)),
  setHibernatableWebSocketEventTimeout: (timeoutMs?: number) =>
    Effect.sync(() => state.setHibernatableWebSocketEventTimeout(timeoutMs)),
  getHibernatableWebSocketEventTimeout: () =>
    Effect.sync(() => state.getHibernatableWebSocketEventTimeout()),
  getTags: (ws: cf.WebSocket) => Effect.sync(() => state.getTags(ws)),
  abort: (reason?: string) => Effect.sync(() => state.abort(reason)),
});

const fromDurableObjectTransaction = (
  txn: cf.DurableObjectTransaction,
): DurableObjectTransaction => ({
  get: ((keyOrKeys: string | string[], options?: cf.DurableObjectGetOptions) =>
    Effect.tryPromise(() => txn.get(keyOrKeys as any, options))) as any,
  list: (options?: cf.DurableObjectListOptions) =>
    Effect.tryPromise(() => txn.list(options)),
  put: ((
    keyOrEntries: string | Record<string, unknown>,
    valueOrOptions?: unknown,
    maybeOptions?: cf.DurableObjectPutOptions,
  ) =>
    typeof keyOrEntries === "string"
      ? Effect.tryPromise(() =>
          txn.put(keyOrEntries, valueOrOptions, maybeOptions),
        )
      : Effect.tryPromise(() =>
          txn.put(
            keyOrEntries,
            valueOrOptions as cf.DurableObjectPutOptions | undefined,
          ),
        )) as any,
  delete: ((
    keyOrKeys: string | string[],
    options?: cf.DurableObjectPutOptions,
  ) => Effect.tryPromise(() => txn.delete(keyOrKeys as any, options))) as any,
  rollback: () => Effect.sync(() => txn.rollback()),
  getAlarm: (options?: cf.DurableObjectGetAlarmOptions) =>
    Effect.tryPromise(() => txn.getAlarm(options)),
  setAlarm: (
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ) => Effect.tryPromise(() => txn.setAlarm(scheduledTime, options)),
  deleteAlarm: (options?: cf.DurableObjectSetAlarmOptions) =>
    Effect.tryPromise(() => txn.deleteAlarm(options)),
});

const fromDurableObjectStorage = (
  storage: cf.DurableObjectStorage,
): DurableObjectStorage => ({
  get: ((keyOrKeys: string | string[], options?: cf.DurableObjectGetOptions) =>
    Effect.tryPromise(() => storage.get(keyOrKeys as any, options))) as any,
  list: (options?: cf.DurableObjectListOptions) =>
    Effect.tryPromise(() => storage.list(options)),
  put: ((
    keyOrEntries: string | Record<string, unknown>,
    valueOrOptions?: unknown,
    maybeOptions?: cf.DurableObjectPutOptions,
  ) =>
    typeof keyOrEntries === "string"
      ? Effect.tryPromise(() =>
          storage.put(keyOrEntries, valueOrOptions, maybeOptions),
        )
      : Effect.tryPromise(() =>
          storage.put(
            keyOrEntries,
            valueOrOptions as cf.DurableObjectPutOptions | undefined,
          ),
        )) as any,
  delete: ((
    keyOrKeys: string | string[],
    options?: cf.DurableObjectPutOptions,
  ) =>
    Effect.tryPromise(() => storage.delete(keyOrKeys as any, options))) as any,
  deleteAll: (options?: cf.DurableObjectPutOptions) =>
    Effect.tryPromise(() => storage.deleteAll(options)),
  transaction: <T>(
    closure: (txn: DurableObjectTransaction) => Effect.Effect<T>,
  ) =>
    Effect.tryPromise(() =>
      storage.transaction((txn) =>
        Effect.runPromise(closure(fromDurableObjectTransaction(txn))),
      ),
    ),
  getAlarm: (options?: cf.DurableObjectGetAlarmOptions) =>
    Effect.tryPromise(() => storage.getAlarm(options)),
  setAlarm: (
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ) => Effect.tryPromise(() => storage.setAlarm(scheduledTime, options)),
  deleteAlarm: (options?: cf.DurableObjectSetAlarmOptions) =>
    Effect.tryPromise(() => storage.deleteAlarm(options)),
  sync: () => Effect.tryPromise(() => storage.sync()),
  sql: storage.sql,
  kv: storage.kv,
  transactionSync: <T>(closure: () => T) => storage.transactionSync(closure),
  getCurrentBookmark: () =>
    Effect.tryPromise(() => storage.getCurrentBookmark()),
  getBookmarkForTime: (timestamp: number | Date) =>
    Effect.tryPromise(() => storage.getBookmarkForTime(timestamp)),
  onNextSessionRestoreBookmark: (bookmark: string) =>
    Effect.tryPromise(() => storage.onNextSessionRestoreBookmark(bookmark)),
});

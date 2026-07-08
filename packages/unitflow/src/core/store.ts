import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { type Pipeable, pipeArguments } from "effect/Pipeable";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { type Flatten, isFlatten, stateOf as flattenStateOf } from "./internals.js";
import {
  InstanceScope,
  ownerScope,
  Registry,
  type RegistryService,
  releaseSubscription,
  type SubscriptionTracker,
  trackedStream,
  trackPublish,
  trackSubscription,
} from "./registry.js";
import type * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import * as Event from "./event.js";
import { makeSlot, type PersistOptions } from "./persistence.js";
import { awaitFirst, evaluate, type WaitPredicate } from "./wait-for.js";

const TypeId = Symbol.for("@unitflow/core/Store");

let nextStoreId = 0;

/** The shared `.pipe(...)` implementation: descriptors are `Pipeable`, so
 * combinators compose at the declaration site. */
const PipeableProto: Pipeable = {
  pipe() {
    return pipeArguments(this, arguments);
  },
};

/** The read capability of a store: accepted by `get` and `stream`, rejected
 * by `set`. Model `outputs` and `ui` state ports are typed as `Source`. */
export interface Source<A> extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly id: string;
  readonly initial: A;
  readonly name?: string;
  readonly "~source": true;
}

/** The write capability of a store: accepted by `set`, rejected by `get` and
 * `stream`. Model `inputs` store ports are typed as `Sink`. */
export interface Sink<A> extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly id: string;
  readonly initial: A;
  readonly name?: string;
  readonly "~sink": true;
}

/** The full descriptor, held privately by the model that created it. */
export interface Store<A> extends Source<A>, Sink<A> {}

export interface Options {
  readonly name?: string;
}

export const make = <A>(initial: A, options?: Options): Store<A> => ({
  ...PipeableProto,
  [TypeId]: TypeId,
  id: `store:${++nextStoreId}`,
  initial,
  "~source": true,
  "~sink": true,
  ...(options?.name === undefined ? {} : { name: options.name }),
});

export const isStore = (value: unknown): value is Store<unknown> =>
  typeof value === "object" && value !== null && TypeId in value;

const CombinedTypeId = Symbol.for("@unitflow/core/CombinedStore");

interface CombinedState<A> {
  readonly sources: ReadonlyArray<Source<any>>;
  readonly compute: (...values: Array<any>) => A;
}

/** A combined read-only store: no state of its own — `get` computes from the
 * current source values, `stream` recombines on every source change. */
export interface Combined<A> extends Source<A> {
  readonly [CombinedTypeId]: CombinedState<A>;
}

export const isCombined = (value: unknown): value is Combined<any> =>
  typeof value === "object" && value !== null && CombinedTypeId in value;

export const sourcesOf = (store: Combined<any>): ReadonlyArray<Source<any>> =>
  store[CombinedTypeId].sources;

type SourceValues<Sources extends ReadonlyArray<Source<any>>> = {
  readonly [K in keyof Sources]: Sources[K] extends Source<infer A> ? A : never;
};

export const combine = <const Sources extends ReadonlyArray<Source<any>>, A>(
  sources: Sources,
  compute: (...values: SourceValues<Sources>) => A,
  options?: Options,
): Combined<A> => ({
  ...PipeableProto,
  [TypeId]: TypeId,
  [CombinedTypeId]: { sources, compute },
  id: `store:${++nextStoreId}`,
  // `initial` mirrors the sources' initials so pre-subscription snapshots
  // (the React binding) stay consistent with `get`.
  // eslint-disable-next-line revizo/no-type-assertion
  initial: compute(...(sources.map((source) => source.initial) as SourceValues<Sources>)),
  "~source": true,
  ...(options?.name === undefined ? {} : { name: options.name }),
});

/**
 * Data-last projection of one source, for `.pipe` chains at the declaration
 * site: `source.pipe(Store.map(f))` is `combine([source], f)` — the same
 * pull-based `get` and deduped `stream` semantics included.
 */
export const map =
  <A, B>(f: (value: A) => B, options?: Options) =>
  (source: Source<A>): Combined<B> =>
    combine([source], f, options);

export const ref = <A>(
  store: Source<A> | Sink<A>,
): Effect.Effect<SubscriptionRef.SubscriptionRef<A>, never, Registry> => {
  if (isCombined(store)) {
    return Effect.die(
      new Error("Unitflow combined stores are computed and have no backing ref."),
    );
  }
  if (isFlatten(store)) {
    return Effect.die(
      new Error("Unitflow flattened stores are computed and have no backing ref."),
    );
  }
  return Effect.flatMap(Registry, (registry) => refFromRegistry(registry, store));
};

const refFromRegistry = <A>(
  registry: RegistryService,
  store: Source<A> | Sink<A>,
): Effect.Effect<SubscriptionRef.SubscriptionRef<A>, never, Registry> => {
  const existing = registry.stores.get(store.id);
  if (existing !== undefined) return Effect.succeed(existing);

  return Effect.gen(function* () {
    const instance = yield* Effect.serviceOption(InstanceScope);
    const owner = Option.getOrElse(instance, () => registry.scope);
    const subscriptionRef = yield* SubscriptionRef.make(store.initial);
    registry.stores.set(store.id, subscriptionRef);
    yield* Scope.addFinalizer(
      owner,
      Effect.suspend(() => {
        registry.stores.delete(store.id);
        closeStoreListeners(registry, store);
        return PubSub.shutdown(subscriptionRef.pubsub);
      }),
    );
    return subscriptionRef;
  });
};

const setUnsafe = <A>(subscriptionRef: SubscriptionRef.SubscriptionRef<A>, value: A): void => {
  subscriptionRef.value = value;
  PubSub.publishUnsafe(subscriptionRef.pubsub, value);
};

/** Sentinel for the synchronous evaluator: some backing ref has not been
 * materialized yet, so the caller must take the effectful path (which creates
 * refs with their scope finalizers). */
const Unresolved = Symbol.for("@unitflow/core/Store/Unresolved");

/**
 * Whether the ref's write semaphore has a free permit right now. Effect's v4
 * `SemaphoreImpl` exposes `free`, but the public `Semaphore` type does not —
 * read it defensively: anything unexpected reports contention, which only
 * means taking the equivalent `withPermit` path.
 */
const uncontended = (subscriptionRef: SubscriptionRef.SubscriptionRef<any>): boolean => {
  const free: unknown = Reflect.get(subscriptionRef.semaphore, "free");
  return typeof free === "number" && free >= 1;
};

/**
 * Evaluates a source synchronously against already-materialized refs.
 * Combined values are memoized per call, so a shared node computes once per
 * pull — O(nodes), where the effectful recursion was O(paths). Returns
 * {@link Unresolved} when any needed plain ref is missing.
 */
const evalSync = (
  registry: RegistryService,
  store: Source<any>,
  memo: Map<string, unknown> | undefined,
): unknown => {
  if (isCombined(store)) {
    if (memo !== undefined && memo.has(store.id)) return memo.get(store.id);
    const { compute, sources } = store[CombinedTypeId];
    const values = new Array<unknown>(sources.length);
    let index = 0;
    for (const source of sources) {
      const value = evalSync(registry, source, memo);
      if (value === Unresolved) return Unresolved;
      values[index++] = value;
    }
    const result = compute(...values);
    memo?.set(store.id, result);
    return result;
  }
  if (isFlatten(store)) {
    const { pick, source } = flattenStateOf(store);
    const items = evalSync(registry, source, memo);
    if (items === Unresolved) return Unresolved;
    const results: Array<unknown> = [];
    // eslint-disable-next-line revizo/no-type-assertion
    for (const item of items as ReadonlyArray<unknown>) {
      const value = evalSync(registry, pick(item), memo);
      if (value === Unresolved) return Unresolved;
      results.push(value);
    }
    return results;
  }
  const subscriptionRef = registry.stores.get(store.id);
  return subscriptionRef === undefined ? Unresolved : SubscriptionRef.getUnsafe(subscriptionRef);
};

interface StoreStreamListener<A = unknown> {
  readonly offer: (value: A) => void;
  readonly close: () => void;
}

const storeStreamListeners = new WeakMap<
  RegistryService,
  Map<string, Set<StoreStreamListener<any>>>
>();

const listenersFor = (
  registry: RegistryService,
): Map<string, Set<StoreStreamListener<any>>> => {
  let listeners = storeStreamListeners.get(registry);
  if (listeners === undefined) {
    listeners = new Map();
    storeStreamListeners.set(registry, listeners);
  }
  return listeners;
};

const offerStoreListeners = <A>(registry: RegistryService, store: Sink<A>, value: A): void => {
  const listeners = storeStreamListeners.get(registry)?.get(store.id);
  if (listeners === undefined || listeners.size === 0) return;
  for (const listener of listeners) listener.offer(value);
};

const closeStoreListeners = (registry: RegistryService, store: Sink<any> | Source<any>): void => {
  const byStore = storeStreamListeners.get(registry);
  const listeners = byStore?.get(store.id);
  if (listeners === undefined) return;
  byStore?.delete(store.id);
  for (const listener of listeners) listener.close();
};

const completeStoreOutstanding = (
  registry: RegistryService,
  tracker: SubscriptionTracker,
): void => {
  if (tracker.outstanding === 0) return;
  while (tracker.outstanding > 0) {
    tracker.outstanding -= 1;
    if (tracker.uncounted > 0) {
      tracker.uncounted -= 1;
    } else if (tracker.count > 0) {
      tracker.count -= 1;
      registry.settle.pending -= 1;
    }
  }
  if (registry.settle.pending !== 0 || registry.settle.waiters.size === 0) return;
  const waiters = [...registry.settle.waiters];
  registry.settle.waiters.clear();
  for (const waiter of waiters) {
    Deferred.doneUnsafe(waiter, Effect.void);
  }
};

/** The full write in one synchronous critical section: the settle count lands
 * before the publish wakes a subscriber (see `trackedModify`). The debug
 * window spans the whole section, so everything dispatched synchronously by
 * the publish (changed events, handler cascades) records this write as its
 * cause. */
const writeUnsafe = <A>(
  registry: RegistryService,
  subscriptionRef: SubscriptionRef.SubscriptionRef<A>,
  store: Sink<A>,
  value: A,
): void => {
  const closeWindow = registry.debug !== undefined ? registry.debug.write(store, value) : undefined;
  trackPublish(registry, store.id);
  setUnsafe(subscriptionRef, value);
  offerStoreListeners(registry, store, value);
  closeWindow?.();
};

const trackedSetSlow = <A>(
  store: Sink<A>,
  value: A,
): Effect.Effect<void, never, Registry> =>
  Effect.flatMap(Registry, (registry) =>
    Effect.flatMap(refFromRegistry(registry, store), (subscriptionRef) =>
      subscriptionRef.semaphore.withPermit(
        Effect.sync(() => writeUnsafe(registry, subscriptionRef, store, value)),
      ),
    ),
  );

/**
 * The hot write path: with the ref materialized and its semaphore free, the
 * whole critical section runs synchronously inside one `withFiber` — nothing
 * can interleave within a synchronous block, so this is exactly `withPermit`
 * minus the bookkeeping. A missing ref or a held permit (an effectful
 * `SubscriptionRef` update in flight) falls back to the effectful path.
 */
const trackedSet = <A>(store: Sink<A>, value: A): Effect.Effect<void, never, Registry> =>
  Effect.withFiber((fiber) => {
    const registry = Context.getOrUndefined(fiber.context, Registry);
    if (registry !== undefined) {
      const subscriptionRef = registry.stores.get(store.id);
      if (subscriptionRef !== undefined && uncontended(subscriptionRef)) {
        writeUnsafe(registry, subscriptionRef, store, value);
        return Effect.void;
      }
    }
    return trackedSetSlow(store, value);
  });

/** The effectful pull path: materializes any missing refs (with their scope
 * finalizers) while resolving. Only taken when {@link evalSync} bailed. */
const getSlow = <A>(store: Source<A>): Effect.Effect<A, never, Registry> => {
  if (isCombined(store)) {
    const { compute, sources } = store[CombinedTypeId];
    return Effect.map(Effect.forEach(sources, get), (values) => compute(...values));
  }
  if (isFlatten(store)) {
    const { pick, source } = flattenStateOf(store);
    // Resolve the outer composition, then every picked inner source, all
    // through the registry.
    const resolved: Effect.Effect<any, never, Registry> = Effect.flatMap(get(source), (items) =>
      Effect.forEach(items, (item) => get(pick(item))),
    );
    return resolved;
  }
  return Effect.map(ref(store), SubscriptionRef.getUnsafe);
};

/** INTERNAL. The debug inspector's snapshot evaluator: resolves any source —
 * plain, combined, flattened — against materialized refs, synchronously and
 * without effects. `None` when a needed ref is not materialized. */
export const evalForDebug = (
  registry: RegistryService,
  store: Source<any>,
): Option.Option<unknown> => {
  const value = evalSync(registry, store, new Map());
  return value === Unresolved ? Option.none() : Option.some(value);
};

export const get = <A>(store: Source<A>): Effect.Effect<A, never, Registry> =>
  Effect.withFiber((fiber) => {
    const registry = Context.getOrUndefined(fiber.context, Registry);
    if (registry !== undefined) {
      // Only a graph pull benefits from the memo table; a plain store read
      // has nothing to share.
      const memo = isCombined(store) || isFlatten(store) ? new Map<string, unknown>() : undefined;
      const value = evalSync(registry, store, memo);
      // eslint-disable-next-line revizo/no-type-assertion
      if (value !== Unresolved) return Effect.succeed(value as A);
    }
    return getSlow(store);
  });

const trackedModifySlow = <A, B>(
  store: Sink<A>,
  f: (value: A) => readonly [B, A],
): Effect.Effect<B, never, Registry> =>
  Effect.flatMap(Registry, (registry) =>
    Effect.flatMap(refFromRegistry(registry, store), (subscriptionRef) =>
      subscriptionRef.semaphore.withPermit(
        Effect.sync(() => {
          const [result, value] = f(SubscriptionRef.getUnsafe(subscriptionRef));
          writeUnsafe(registry, subscriptionRef, store, value);
          return result;
        }),
      ),
    ),
  );

/** Runs a `SubscriptionRef` read-modify-write with settle accounting and
 * publication in one synchronous critical section: the count lands before
 * publish wakes a subscriber, and the semaphore keeps direct `ref` users
 * serialized. Fast path mirrors {@link trackedSet}; a throwing `f` dies just
 * like it would inside `Effect.sync`. */
const trackedModify = <A, B>(
  store: Sink<A>,
  f: (value: A) => readonly [B, A],
): Effect.Effect<B, never, Registry> =>
  Effect.withFiber((fiber) => {
    const registry = Context.getOrUndefined(fiber.context, Registry);
    if (registry !== undefined) {
      const subscriptionRef = registry.stores.get(store.id);
      if (subscriptionRef !== undefined && uncontended(subscriptionRef)) {
        const [result, value] = f(SubscriptionRef.getUnsafe(subscriptionRef));
        writeUnsafe(registry, subscriptionRef, store, value);
        return Effect.succeed(result);
      }
    }
    return trackedModifySlow(store, f);
  });

export const set = <A>(store: Sink<A>, value: A): Effect.Effect<void, never, Registry> =>
  trackedSet(store, value);

/** Sets every given store back to its initial value, in argument order. */
export const reset = (...stores: ReadonlyArray<Sink<any>>): Effect.Effect<void, never, Registry> =>
  Effect.forEach(stores, (store) => set(store, store.initial), { discard: true });

/** Reads the current value, so it requires the full store — a model updates
 * only its own state. */
export const update = <A>(
  store: Store<A>,
  f: (value: A) => A,
): Effect.Effect<void, never, Registry> =>
  Effect.asVoid(trackedModify(store, (value) => [undefined, f(value)]));

/** Reads the current value, so it requires the full store — a model updates
 * only its own state. */
export const modify = <A, B>(
  store: Store<A>,
  f: (value: A) => readonly [B, A],
): Effect.Effect<B, never, Registry> =>
  trackedModify(store, f);

let nextFlattenSubscription = 0;

/**
 * Streams a flattened store with two-level reactivity and exact settle
 * accounting. Per subscription: one sequential tracked pipeline per source —
 * the outer composition plus each picked inner store — recomputes the current
 * array (through the synchronous pull path) into a private snapshot ref, and
 * the subscriber consumes that snapshot through its own tracked subscription.
 * A composition change closes the previous inner pipelines' scope (releasing
 * their subscriptions) and watches the new set, so a removed item's store can
 * never re-emit. The publish into the snapshot is counted before the source
 * pipeline confirms its item, so `allSettled` stays pending until the
 * subscriber has handled the recomputation — cascades included.
 */
const flattenStream = (store: Flatten<any>): Stream.Stream<any, never, Registry> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const scope = yield* Effect.scope;
      const { pick, source } = flattenStateOf(store);
      // The snapshot channel is private to this subscription: counting under
      // a shared id would count one subscriber's recomputation into another
      // subscriber's tracker and stall `allSettled`.
      const channelId = `${store.id}:subscription:${++nextFlattenSubscription}`;

      let current: ReadonlyArray<any> = yield* get(store);
      const snapshot = yield* SubscriptionRef.make(current);

      // One permit: concurrent recomputations queue, so a stale snapshot can
      // never overwrite a fresher one.
      const semaphore = yield* Semaphore.make(1);
      const recompute = semaphore.withPermit(
        Effect.flatMap(get(store), (values: ReadonlyArray<any>) =>
          Effect.suspend(() => {
            const unchanged =
              values.length === current.length &&
              values.every((value, index) => Object.is(value, current[index]));
            if (unchanged) return Effect.void;
            current = values;
            // Counted first, atomically with the publish (see `trackedWrite`).
            return Effect.uninterruptible(
              Effect.suspend(() => {
                trackPublish(registry, channelId);
                return Effect.asVoid(SubscriptionRef.setAndGet(snapshot, values));
              }),
            );
          }),
        ),
      );

      // One simple tracked source per pipeline, each consumed sequentially by
      // its own drain — the item a pipeline is handling stays pending until
      // the recomputation (and its counted snapshot publish) completed.
      const watch = (innerSource: Source<any>, target: Scope.Scope) =>
        Effect.forkIn(
          Stream.runDrain(stream(innerSource).pipe(Stream.mapEffect(() => recompute))),
          target,
          { startImmediately: true },
        );

      // Incremental composition tracking: one closeable scope per watched
      // occurrence, keyed by the picked source's id (an array keeps duplicate
      // picks at their exact multiplicity). A composition change only closes
      // watchers of removed occurrences and forks watchers for added ones —
      // an unchanged item's subscription is never interrupted, so a change
      // costs O(delta), not O(items).
      const watched = new Map<string, { source: Source<any>; scopes: Array<Scope.Closeable> }>();
      const resubscribe = Effect.gen(function* () {
        const targets = new Map<string, { source: Source<any>; count: number }>();
        for (const item of yield* get(source)) {
          const picked = pick(item);
          const target = targets.get(picked.id);
          if (target === undefined) {
            targets.set(picked.id, { source: picked, count: 1 });
          } else {
            target.count += 1;
          }
        }
        // Removed occurrences close first — a removed item's store must never
        // re-emit into the snapshot, exactly like the full-resubscribe did.
        for (const [id, entry] of watched) {
          const keep = targets.get(id)?.count ?? 0;
          while (entry.scopes.length > keep) {
            const closeable = entry.scopes.pop();
            if (closeable !== undefined) yield* Scope.close(closeable, Exit.void);
          }
          if (entry.scopes.length === 0) watched.delete(id);
        }
        for (const [id, target] of targets) {
          let entry = watched.get(id);
          if (entry === undefined) {
            entry = { source: target.source, scopes: [] };
            watched.set(id, entry);
          }
          while (entry.scopes.length < target.count) {
            const forked = Scope.forkUnsafe(scope);
            entry.scopes.push(forked);
            yield* watch(target.source, forked);
          }
        }
        yield* recompute;
      });

      // The outer pipeline replays the current composition, so the initial
      // inner watchers attach without a separate bootstrap.
      yield* Effect.forkIn(
        Stream.runDrain(stream(source).pipe(Stream.mapEffect(() => resubscribe))),
        scope,
        { startImmediately: true },
      );

      // The subscriber's own tracked subscription over the snapshot (the
      // replayed current value was never counted — see the store twin).
      const subscription = yield* PubSub.subscribe(snapshot.pubsub);
      const tracker = trackSubscription(registry, channelId, 1);
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => releaseSubscription(registry, channelId, tracker)),
      );
      return trackedStream(registry, subscription, tracker);
    }),
  );

const storeStream = <A>(store: Source<A>): Stream.Stream<A, never, Registry> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const subscriptionRef = yield* refFromRegistry(registry, store);
      const scope = yield* Effect.scope;
      const tracker = trackSubscription(registry, store.id, 1);
      let queue: Array<A> = [SubscriptionRef.getUnsafe(subscriptionRef)];
      let waiter: Deferred.Deferred<void> | undefined;
      let closed = false;
      const listener: StoreStreamListener<A> = {
        offer(value) {
          if (closed) return;
          queue.push(value);
          if (waiter !== undefined) {
            const deferred = waiter;
            waiter = undefined;
            Deferred.doneUnsafe(deferred, Effect.void);
          }
        },
        close() {
          if (closed) return;
          closed = true;
          queue = [];
          if (waiter !== undefined) {
            const deferred = waiter;
            waiter = undefined;
            Deferred.doneUnsafe(deferred, Effect.void);
          }
        },
      };

      const listenersByStore = listenersFor(registry);
      const listeners = listenersByStore.get(store.id);
      if (listeners === undefined) {
        listenersByStore.set(store.id, new Set([listener]));
      } else {
        listeners.add(listener);
      }

      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          closed = true;
          const listenersByStore = storeStreamListeners.get(registry);
          const listeners = listenersByStore?.get(store.id);
          if (listeners !== undefined) {
            listeners.delete(listener);
            if (listeners.size === 0) listenersByStore?.delete(store.id);
          }
          releaseSubscription(registry, store.id, tracker);
        }),
      );

      const pull = Effect.suspend(() => {
        completeStoreOutstanding(registry, tracker);
        if (queue.length > 0) {
          const items = queue;
          queue = [];
          tracker.outstanding = items.length;
          // eslint-disable-next-line revizo/no-type-assertion
          return Effect.succeed(items as unknown as readonly [A, ...Array<A>]);
        }
        if (closed) return Cause.done();
        const deferred = Deferred.makeUnsafe<void>();
        waiter = deferred;
        return Deferred.await(deferred).pipe(
          Effect.flatMap(() => {
            if (closed && queue.length === 0) return Cause.done();
            if (queue.length === 0) return Cause.done();
            const items = queue;
            queue = [];
            tracker.outstanding = items.length;
            // eslint-disable-next-line revizo/no-type-assertion
            return Effect.succeed(items as unknown as readonly [A, ...Array<A>]);
          }),
          Effect.onInterrupt(() => {
            if (waiter === deferred) waiter = undefined;
            return Cause.done();
          }),
        );
      });

      return Stream.fromPull(Effect.succeed(pull));
    }),
  );

export const stream = <A>(store: Source<A>): Stream.Stream<A, never, Registry> => {
  if (isFlatten(store)) return flattenStream(store);
  if (isCombined(store)) {
    const sources = uniqueSources(watchSources(store));
    if (sources.length === 0) return Stream.make(store.initial);
    // One deduped watch source needs no zip layer: `zipLatestAll` over a
    // single stream emits exactly once per source emission anyway, so recombine
    // directly and skip its coordination fiber.
    const [only] = sources;
    const emissions =
      sources.length === 1 && only !== undefined
        ? stream(only)
        : Stream.zipLatestAll(...sources.map(stream));
    return emissions.pipe(
      Stream.mapEffect(() => get(store)),
      Stream.changes,
    );
  }
  return storeStream(store);
};

const watchSources = (source: Source<any>): ReadonlyArray<Source<any>> =>
  isCombined(source) ? sourcesOf(source).flatMap(watchSources) : [source];

const uniqueSources = (
  sources: ReadonlyArray<Source<any>>,
): ReadonlyArray<Source<any>> => [...new Map(sources.map((source) => [source.id, source])).values()];

/** Creates an event that emits the store's value on every subsequent store
 * emission. The current replayed value is skipped, so construction does not
 * count as a change. */
export const changed = <A>(
  store: Source<A>,
  options?: Pick<Event.Options, "name">,
): Effect.Effect<Event.Event<A>, never, Registry> =>
  Effect.gen(function* () {
    const changedEvent = Event.make<A>(
      options?.name !== undefined
        ? { name: options.name }
        : store.name === undefined
          ? undefined
          : { name: `${store.name}.changed` },
    );
    const sources = uniqueSources(watchSources(store));

    // Flattened sources need the two-level stream watcher; everything else
    // takes the fused path below: a synchronous store listener recomputes,
    // dedupes, and dispatches into the event — no watcher pipeline at all.
    if (sources.some(isFlatten)) {
      let current = yield* get(store);
      const emitIfChanged = Effect.flatMap(get(store), (value) =>
        Effect.suspend(() => {
          if (Object.is(value, current)) return Effect.void;
          current = value;
          return Event.emit(changedEvent, value);
        }),
      );
      yield* Effect.forEach(
        sources,
        (source) =>
          Registry.run(
            stream(source).pipe(
              Stream.drop(1),
              Stream.mapEffect(() => emitIfChanged),
            ),
          ),
        { discard: true },
      );
      return changedEvent;
    }

    const registry = yield* Registry;
    const scope = yield* ownerScope;
    // The event channel binds to the declaring scope now — the same owner the
    // watcher pipeline's subscription would have bound it to.
    const channel = yield* Event.pubsub(changedEvent);
    // Materialize every watched ref, so the sync evaluator always resolves.
    yield* Effect.forEach(sources, ref, { discard: true });
    let current: unknown = yield* get(store);
    const needsMemo = isCombined(store);
    let closed = false;
    // Reads at dispatch time (not the offered value): a recomputation always
    // reflects the latest source values, exactly like the watcher's `get`.
    const listener: StoreStreamListener<unknown> = {
      offer() {
        if (closed) return;
        const value = evalSync(registry, store, needsMemo ? new Map() : undefined);
        if (value === Unresolved || Object.is(value, current)) return;
        current = value;
        // The store may have been named after this event was created (port
        // naming runs when `make` returns) — inherit lazily.
        if (changedEvent.name === undefined && store.name !== undefined) {
          // eslint-disable-next-line revizo/no-type-assertion
          (changedEvent as { name?: string }).name = `${store.name}.changed`;
        }
        // The evaluator returns this source's value type.
        // eslint-disable-next-line revizo/no-type-assertion
        Event.dispatchUnsafe(registry, channel, changedEvent, value as A);
      },
      close() {
        closed = true;
      },
    };
    const listenersByStore = listenersFor(registry);
    for (const source of sources) {
      const listeners = listenersByStore.get(source.id);
      if (listeners === undefined) {
        listenersByStore.set(source.id, new Set([listener]));
      } else {
        listeners.add(listener);
      }
    }
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        closed = true;
        const byStore = storeStreamListeners.get(registry);
        for (const source of sources) {
          const listeners = byStore?.get(source.id);
          if (listeners === undefined) continue;
          listeners.delete(listener);
          if (listeners.size === 0) byStore?.delete(source.id);
        }
      }),
    );
    return changedEvent;
  });

/** `waitFor` options without a timeout: the wait can only end with a match
 * (or the interruption/failure paths documented on {@link waitFor}). */
export interface WaitForOptions {
  /** Only subsequent emissions count: the current value is skipped. */
  readonly skipCurrent?: boolean | undefined;
  readonly timeout?: undefined;
}

/** `waitFor` options with a timeout: the wait additionally fails with
 * `Cause.TimeoutError` when no value matched in time. */
export interface WaitForTimeoutOptions {
  /** Only subsequent emissions count: the current value is skipped. */
  readonly skipCurrent?: boolean | undefined;
  readonly timeout: Duration.Input;
}

/**
 * Waits for the first store value satisfying `predicate`, resolving through
 * the registry like `get`/`stream`: the CURRENT value is checked first (pass
 * `skipCurrent: true` to only consider subsequent emissions), then every
 * emission until one matches.
 *
 * - A plain predicate keeps `E = never` (the timeout error only enters the
 *   error channel when `timeout` is passed); a refinement narrows the result.
 * - An effectful predicate runs one evaluation at a time, switching to the
 *   latest value: a value landing mid-evaluation interrupts the running check
 *   and the newest value is evaluated instead — the newest value is the
 *   store's truth, so a verdict about a superseded one is worthless. A
 *   failing predicate effect fails `waitFor` with that error.
 * - `timeout` fails with `Cause.TimeoutError` — exactly the error
 *   `Effect.timeout` raises.
 * - The store's stream ending before a match (the owning scope shut the
 *   backing ref down) interrupts the waiter: the awaited value can never
 *   arrive.
 *
 * The subscription is tracked like any `stream` subscription and released on
 * every exit path — match, predicate failure, timeout, interruption. A value
 * the predicate rejected is confirmed as handled, so a parked `waitFor` holds
 * nothing and never wedges `Registry.allSettled`.
 */
export function waitFor<A, B extends A>(
  store: Source<A>,
  predicate: (value: A) => value is B,
  options: WaitForTimeoutOptions,
): Effect.Effect<B, Cause.TimeoutError, Registry>;
export function waitFor<A, B extends A>(
  store: Source<A>,
  predicate: (value: A) => value is B,
  options?: WaitForOptions,
): Effect.Effect<B, never, Registry>;
export function waitFor<A>(
  store: Source<A>,
  predicate: (value: A) => boolean,
  options: WaitForTimeoutOptions,
): Effect.Effect<A, Cause.TimeoutError, Registry>;
export function waitFor<A>(
  store: Source<A>,
  predicate: (value: A) => boolean,
  options?: WaitForOptions,
): Effect.Effect<A, never, Registry>;
export function waitFor<A, E, R>(
  store: Source<A>,
  predicate: (value: A) => Effect.Effect<boolean, E, R>,
  options: WaitForTimeoutOptions,
): Effect.Effect<A, E | Cause.TimeoutError, Registry | R>;
export function waitFor<A, E, R>(
  store: Source<A>,
  predicate: (value: A) => Effect.Effect<boolean, E, R>,
  options?: WaitForOptions,
): Effect.Effect<A, E, Registry | R>;
export function waitFor(
  store: Source<any>,
  predicate: WaitPredicate<any>,
  options?: WaitForOptions | WaitForTimeoutOptions,
): Effect.Effect<any, any, any> {
  const emissions = options?.skipCurrent === true ? Stream.drop(stream(store), 1) : stream(store);
  return awaitFirst(
    emissions.pipe(
      // Switch-to-latest: a new value interrupts the in-flight evaluation.
      Stream.switchMap((value) =>
        Stream.fromEffect(evaluate(predicate, value)).pipe(
          Stream.filter((matched) => matched),
          Stream.map(() => value),
        ),
      ),
    ),
    options?.timeout,
  );
}

/**
 * Persists every change of the store into a `KeyValueStore` under `key`, and
 * hydrates the store from the stored copy inline: by the time `persist`
 * returns, the store already holds the restored value, so anything built on
 * top of it afterwards (a dependent query, a combined store) sees the
 * restored value from its first run. Best-effort: storage and codec failures
 * are logged as warnings and never affect the store itself. A stored entry
 * that fails to decode — or is older than `timeToLive` — is a miss, leaving
 * the initial value in place.
 */
export const persist =
  <A, I>(options: PersistOptions<A, I>) =>
  (self: Store<A>): Effect.Effect<Store<A>, never, KeyValueStore.KeyValueStore | Registry> =>
    Effect.gen(function* () {
      const slot = yield* makeSlot(options);

      const restored = yield* slot.load;
      if (Option.isSome(restored)) yield* set(self, restored.value);

      // The subscription starts after hydration, and the replayed current
      // value is dropped, so the restored value is not echoed back into the
      // KVS: only future changes are saved.
      yield* Registry.run(
        stream(self).pipe(
          Stream.drop(1),
          Stream.mapEffect((value) => slot.save(value)),
        ),
      );

      return self;
    });

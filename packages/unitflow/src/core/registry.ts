import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as RcMap from "effect/RcMap";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * A model instance's identity in the registry: the model's id plus its key,
 * as one plain composite record. The instance `RcMap` buckets object keys by
 * `Hash.hash` and compares within a bucket via `Equal.equals` — in v4 both
 * are deeply structural for plain records — so two structurally equal keys
 * resolve the same instance without any serialization. Keys must not be
 * mutated after use (`Equal`/`Hash` cache per object).
 */
export interface InstanceKey {
  readonly model: string;
  readonly key: unknown;
}

export const instanceKey = (model: string, key: unknown): InstanceKey => ({ model, key });

/**
 * The mutable accounting of one channel subscription, all maintained
 * synchronously with the pulls of its stream. Internal to `allSettled`.
 */
export interface SubscriptionTracker {
  /** Items counted into this subscription (published while it was active)
   * that have not completed yet — queued or currently being handled. */
  count: number;
  /** Deliveries this subscription receives without a matching publish count —
   * a store subscription's replayed current value. They were never counted,
   * so completing them must not decrement anything. */
  uncounted: number;
  /** Items handed downstream by the last pull whose handling has not been
   * confirmed yet — the next pull confirms them. */
  outstanding: number;
}

/** The `allSettled` ledger: how many published-and-counted items are still
 * undelivered or being handled, and who is waiting for that to hit zero. */
interface SettleState {
  pending: number;
  readonly waiters: Set<Deferred.Deferred<void>>;
  readonly subscriptions: Map<string, Set<SubscriptionTracker>>;
}

/**
 * The debug tap of one registry (see `Debug.attach`): `write`/`emit` open a
 * causality window around the synchronous dispatch of one publication and
 * return its closer; `instance` records model lifecycle. `undefined` on the
 * registry means debugging is off — the hot paths pay one property check.
 */
export interface DebugSink {
  readonly write: (
    store: { readonly id: string; readonly name?: string },
    value: unknown,
  ) => () => void;
  readonly emit: (
    event: { readonly id: string; readonly name?: string },
    value: unknown,
  ) => () => void;
  readonly instance: (key: InstanceKey, phase: "created" | "disposed") => void;
  /** Called for every descriptor the port-naming walk touches at instance
   * construction — the inspector's directory for retroactive log names and
   * derived-store snapshot evaluation. */
  readonly port: (port: { readonly id: string; readonly name?: string }) => void;
}

export interface RegistryService {
  /** Mutable: installed and removed by `Debug.attach`/`detach`. */
  debug: DebugSink | undefined;
  readonly scope: Scope.Scope;
  readonly stores: Map<string, SubscriptionRef.SubscriptionRef<any>>;
  readonly events: Map<string, PubSub.PubSub<any>>;
  /** Reference-counted model instances: `Model.get` leases one in the
   * caller's ambient scope; the last release starts the model's idle TTL.
   * Values are the models' resolved shapes — each accessor re-narrows its
   * own, hence `any` here. */
  readonly instances: RcMap.RcMap<InstanceKey, any, any>;
  /** Per-model construction, registered when the model's layer is built and
   * dispatched by the instance map's lookup. */
  readonly constructors: Map<string, (key: InstanceKey) => Effect.Effect<any, any, Scope.Scope>>;
  /** Per-model idle policy, consulted when an instance entry is created. */
  readonly lifetimes: Map<string, Duration.Duration>;
  /** Live instances' closeable scopes — the deterministic `dispose` handle:
   * closing one kills the instance even while leases are outstanding. */
  readonly instanceScopes: MutableHashMap.MutableHashMap<InstanceKey, Scope.Closeable>;
  /** Mirror of the instance map's per-key lease counts — `RcMap` exposes no
   * refcounts, and `Model.list`'s release-then-check removal needs to know
   * whether anyone else still holds a child. Maintained exclusively by the
   * accessors' `get` (every lease path goes through one): {@link trackLease}
   * on acquisition, {@link releaseLease} by a finalizer in the leasing scope.
   * Internal accounting — not exported from the package index. */
  readonly leaseCounts: MutableHashMap.MutableHashMap<InstanceKey, number>;
  readonly settle: SettleState;
}

/** The idle grace of a keyed model instance after its last lease is released
 * — state survives navigation this long, then the instance is disposed. A
 * `"keepAlive"` model (singleton default) never idles out. */
export const defaultIdleTimeToLive = Duration.minutes(10);

/** Count one lease of an instance into the registry's mirror. Called by the
 * accessors' `get` right after the RcMap lease is acquired, paired with a
 * {@link releaseLease} finalizer in the leasing scope. */
export const trackLease = (registry: RegistryService, key: InstanceKey): void => {
  const current = MutableHashMap.get(registry.leaseCounts, key);
  MutableHashMap.set(registry.leaseCounts, key, Option.getOrElse(current, () => 0) + 1);
};

/** Count one lease out of the mirror, dropping the entry at zero. */
export const releaseLease = (registry: RegistryService, key: InstanceKey): void => {
  const current = MutableHashMap.get(registry.leaseCounts, key);
  if (Option.isNone(current)) return;
  if (current.value <= 1) {
    MutableHashMap.remove(registry.leaseCounts, key);
  } else {
    MutableHashMap.set(registry.leaseCounts, key, current.value - 1);
  }
};

/** How many leases of the instance are currently held, across ALL holders —
 * lists, parents' `make`, React binding scopes, bare gets. */
export const leaseCount = (registry: RegistryService, key: InstanceKey): number =>
  Option.getOrElse(MutableHashMap.get(registry.leaseCounts, key), () => 0);

const wakeIfSettled = (settle: SettleState): void => {
  if (settle.pending !== 0 || settle.waiters.size === 0) return;
  const waiters = [...settle.waiters];
  settle.waiters.clear();
  for (const waiter of waiters) {
    Deferred.doneUnsafe(waiter, Effect.void);
  }
};

/** Count one published item into every active subscription of the channel.
 * Must run synchronously BEFORE the publish itself: a handler woken by the
 * publish has to find its item already accounted for. */
export const trackPublish = (registry: RegistryService, id: string): void => {
  const trackers = registry.settle.subscriptions.get(id);
  if (trackers === undefined || trackers.size === 0) return;
  for (const tracker of trackers) {
    tracker.count += 1;
  }
  registry.settle.pending += trackers.size;
};

/** Register a subscription so publishes start counting toward it. Call
 * synchronously AFTER the pubsub subscription is created — an item delivered
 * but never counted completes silently, while a counted item that is never
 * delivered would stall `allSettled` until release. */
export const trackSubscription = (
  registry: RegistryService,
  id: string,
  replayed: number,
): SubscriptionTracker => {
  const tracker: SubscriptionTracker = { count: 0, uncounted: replayed, outstanding: 0 };
  const existing = registry.settle.subscriptions.get(id);
  if (existing === undefined) {
    registry.settle.subscriptions.set(id, new Set([tracker]));
  } else {
    existing.add(tracker);
  }
  return tracker;
};

/** Unregister a subscription and drain whatever it still had counted —
 * queued, outstanding, or never-to-be-delivered items alike. */
export const releaseSubscription = (
  registry: RegistryService,
  id: string,
  tracker: SubscriptionTracker,
): void => {
  const trackers = registry.settle.subscriptions.get(id);
  if (trackers !== undefined) {
    trackers.delete(tracker);
    if (trackers.size === 0) registry.settle.subscriptions.delete(id);
  }
  tracker.outstanding = 0;
  if (tracker.count > 0) {
    registry.settle.pending -= tracker.count;
    tracker.count = 0;
    wakeIfSettled(registry.settle);
  }
};

/** Confirm the previous batch: pulling again means downstream finished
 * handling every item of it. Uncounted items (a store subscription's replayed
 * current value) complete silently; the clamp keeps a mixed or raced batch
 * from going negative. */
const completeOutstanding = (registry: RegistryService, tracker: SubscriptionTracker): void => {
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
  wakeIfSettled(registry.settle);
};

/** The tracked twin of `Stream.fromSubscription`: each pull first confirms
 * the previously delivered batch, then blocks on the next one — so an item
 * stays pending exactly until its handler returned. */
export const trackedStream = <A>(
  registry: RegistryService,
  subscription: PubSub.Subscription<A>,
  tracker: SubscriptionTracker,
): Stream.Stream<A> =>
  Stream.fromPull(
    Effect.succeed(
      Effect.suspend(() => {
        completeOutstanding(registry, tracker);
        return Effect.onInterrupt(PubSub.takeAll(subscription), () => Cause.done());
      }).pipe(
        Effect.map((items) => {
          tracker.outstanding = items.length;
          return items;
        }),
      ),
    ),
  );

/** Confirm one counted item outside the pull machinery — the direct handler
 * dispatch path completes an item as soon as its handling finished. The
 * guard mirrors `completeOutstanding`: a released tracker already returned
 * its counts, so completing late must not double-decrement. */
export const completeCounted = (registry: RegistryService, tracker: SubscriptionTracker): void => {
  if (tracker.count === 0) return;
  tracker.count -= 1;
  registry.settle.pending -= 1;
  wakeIfSettled(registry.settle);
};

/** Interrupts and `Done` signals (a source pubsub shut down during disposal)
 * are the normal ways a pipeline ends; anything else is a bug worth logging. */
export const isExpectedTermination = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.every(
    (reason) =>
      Cause.isInterruptReason(reason) ||
      (Cause.isFailReason(reason) && Cause.isDone(reason.error)) ||
      (Cause.isDieReason(reason) && Cause.isDone(reason.defect)),
  );

export class Registry extends Context.Service<Registry, RegistryService>()(
  "@unitflow/core/Registry",
) {
  static readonly layer = Layer.effect(
    Registry,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const constructors = new Map<
        string,
        (key: InstanceKey) => Effect.Effect<any, any, Scope.Scope>
      >();
      const lifetimes = new Map<string, Duration.Duration>();
      // The RcMap owns instance lifecycle: lazy memoized construction, one
      // construction under concurrent first-gets, a lease per `get` released
      // with the leasing scope, and the per-model idle TTL after the last
      // release. Closing the registry scope closes every instance.
      const instances = yield* RcMap.make({
        // Dispatched per model id — every `get` goes through the model's
        // accessor, which registers its constructor at layer build.
        lookup: (key: InstanceKey) =>
          Effect.suspend(() => {
            const construct = constructors.get(key.model);
            return construct === undefined
              ? Effect.die(new Error(`Unitflow has no constructor for model "${key.model}".`))
              : construct(key);
          }),
        idleTimeToLive: (key) => lifetimes.get(key.model) ?? defaultIdleTimeToLive,
      });
      return Registry.of({
        debug: undefined,
        scope,
        stores: new Map(),
        events: new Map(),
        instances,
        constructors,
        lifetimes,
        instanceScopes: MutableHashMap.empty(),
        leaseCounts: MutableHashMap.empty(),
        settle: {
          pending: 0,
          waiters: new Set(),
          subscriptions: new Map(),
        },
      });
    }),
  );

  /** Fork a pipeline into the enclosing model instance's scope (the registry
   * scope outside a model). The stream's error channel must be `never` —
   * handle failures inside the pipeline. Defects still kill only this
   * pipeline and are logged; they never fail `run` itself. */
  static readonly run = <A, R>(
    stream: Stream.Stream<A, never, R>,
  ): Effect.Effect<void, never, R | Registry> =>
    Effect.gen(function* () {
      const scope = yield* ownerScope;
      yield* Effect.forkIn(
        Stream.runDrain(stream).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && !isExpectedTermination(exit.cause)
              ? Effect.logError("Unitflow pipeline terminated unexpectedly", exit.cause)
              : Effect.void,
          ),
        ),
        scope,
        { startImmediately: true },
      );
    });

  /** Run the triggers sequentially in order, then wait until the registry is
   * settled: no subscription is executing a handler and no subscription holds
   * undelivered counted items — cascades of any depth included. With no
   * triggers it just awaits quiescence; an idle registry resolves
   * immediately. Replay deliveries (a store's current value) are not waited
   * for, and neither are pipelines over non-Event/Store sources. */
  static readonly allSettled = <Triggers extends ReadonlyArray<Effect.Effect<unknown, never, any>>>(
    ...triggers: Triggers
  ): Effect.Effect<void, never, Registry | Effect.Services<Triggers[number]>> =>
    Effect.gen(function* () {
      const registry = yield* Registry;
      for (const trigger of triggers) {
        yield* trigger;
      }
      while (registry.settle.pending > 0) {
        const waiter = Deferred.makeUnsafe<void>();
        registry.settle.waiters.add(waiter);
        yield* Deferred.await(waiter).pipe(
          Effect.onInterrupt(() => Effect.sync(() => registry.settle.waiters.delete(waiter))),
        );
      }
    });
}

/**
 * The scope of the model instance currently being constructed. Stores and
 * events lazily materialized while it is in context register their cleanup
 * there, so disposing the instance also removes its registry entries.
 */
export class InstanceScope extends Context.Service<InstanceScope, Scope.Scope>()(
  "@unitflow/core/InstanceScope",
) {}

/** The scope that owns resources created by the current fiber: the enclosing
 * model instance's scope when inside one, the registry scope otherwise. */
export const ownerScope: Effect.Effect<Scope.Scope, never, Registry> = Effect.gen(function* () {
  const registry = yield* Registry;
  const instance = yield* Effect.serviceOption(InstanceScope);
  return Option.getOrElse(instance, () => registry.scope);
});

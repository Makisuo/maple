import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { type Pipeable, pipeArguments } from "effect/Pipeable";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  completeCounted,
  isExpectedTermination,
  ownerScope,
  Registry,
  type RegistryService,
  releaseSubscription,
  type SubscriptionTracker,
  trackedStream,
  trackPublish,
  trackSubscription,
} from "./registry.js";
import * as Store from "./store.js";
import { awaitFirst, evaluate, type WaitPredicate } from "./wait-for.js";

const TypeId = Symbol.for("@unitflow/core/Event");

let nextEventId = 0;

/** The shared `.pipe(...)` implementation: descriptors are `Pipeable`, so
 * combinators like {@link handler} compose at the declaration site. */
const PipeableProto: Pipeable = {
  pipe() {
    return pipeArguments(this, arguments);
  },
};

/** The subscribe capability of an event: accepted by `stream`, rejected by
 * `emit`. Model `outputs` event ports are typed as `Source`. */
export interface Source<A> extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly id: string;
  readonly name?: string;
  readonly "~source": true;
  readonly _A?: (_: A) => A;
}

/** The emit capability of an event: accepted by `emit`, rejected by `stream`.
 * Model `inputs` and `ui` event ports are typed as `Sink`. */
export interface Sink<A> extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly id: string;
  readonly name?: string;
  readonly "~sink": true;
  readonly _A?: (_: A) => A;
}

/** The full descriptor, held privately by the model that created it. */
export interface Event<A> extends Source<A>, Sink<A> {}

export type PayloadOf<E> = E extends Sink<infer A> ? A : never;
export type EmitArgs<A> = [A] extends [void] ? [value?: A] : [value: A];

export interface Options {
  readonly name?: string;
}

export const make = <A = void>(options?: Options): Event<A> => ({
  ...PipeableProto,
  [TypeId]: TypeId,
  id: `event:${++nextEventId}`,
  "~source": true,
  "~sink": true,
  ...(options?.name === undefined ? {} : { name: options.name }),
});

export const isEvent = (value: unknown): value is Event<unknown> =>
  typeof value === "object" && value !== null && TypeId in value;

const SetterTypeId = Symbol.for("@unitflow/core/SetterEvent");

/** An event-shaped port backed by a store: emitting writes the value into the
 * store, subscribing streams the store's changes. No channel of its own —
 * the `value`/`onChange` pair without a hand-written pipeline. */
export interface Setter<A> extends Event<A> {
  readonly [SetterTypeId]: Store.Store<A>;
}

export const isSetter = (value: unknown): value is Setter<any> =>
  typeof value === "object" && value !== null && SetterTypeId in value;

export const targetOf = (event: Setter<any>): Store.Store<any> => event[SetterTypeId];

export const setter = <A>(store: Store.Store<A>, options?: Pick<Options, "name">): Setter<A> => ({
  ...PipeableProto,
  [TypeId]: TypeId,
  [SetterTypeId]: store,
  id: `event:${++nextEventId}`,
  "~source": true,
  "~sink": true,
  ...(options?.name === undefined ? {} : { name: options.name }),
});

const CombinedTypeId = Symbol.for("@unitflow/core/CombinedEvent");

interface CombinedState {
  readonly sources: ReadonlyArray<Source<any>>;
}

/** A merged read-only event: no channel of its own — `stream` emits whenever
 * any source emits. Emitting into it does not compile (it is a `Source`). */
export interface Combined<A> extends Source<A> {
  readonly [CombinedTypeId]: CombinedState;
}

export const isCombined = (value: unknown): value is Combined<any> =>
  typeof value === "object" && value !== null && CombinedTypeId in value;

export const sourcesOf = (event: Combined<any>): ReadonlyArray<Source<any>> =>
  event[CombinedTypeId].sources;

type SourceValue<Sources extends ReadonlyArray<Source<any>>> =
  Sources[number] extends Source<infer A> ? A : never;

export const combine = <const Sources extends ReadonlyArray<Source<any>>>(
  sources: Sources,
  options?: Pick<Options, "name">,
): Combined<SourceValue<Sources>> => ({
  ...PipeableProto,
  [TypeId]: TypeId,
  [CombinedTypeId]: { sources },
  id: `event:${++nextEventId}`,
  "~source": true,
  ...(options?.name === undefined ? {} : { name: options.name }),
});

export const pubsub = Effect.fnUntraced(function* <A>(
  event: Source<A> | Sink<A>,
): Generator<Effect.Effect<unknown, never, Registry>, PubSub.PubSub<A>, never> {
  if (isCombined(event)) {
    return yield* Effect.die(
      new Error("Unitflow combined events are merged and have no backing pubsub."),
    );
  }
  if (isSetter(event)) {
    return yield* Effect.die(
      new Error("Unitflow setter events are backed by their store and have no pubsub."),
    );
  }
  const registry = yield* Registry;
  const existing = registry.events.get(event.id);
  if (existing !== undefined) return existing;

  const owner = yield* ownerScope;
  const created = yield* PubSub.unbounded<A>();
  registry.events.set(event.id, created);
  yield* Scope.addFinalizer(
    owner,
    Effect.suspend(() => {
      registry.events.delete(event.id);
      return PubSub.shutdown(created);
    }),
  );
  return created;
});

/**
 * A direct handler subscription: `emit` feeds the queue synchronously and a
 * dedicated drain fiber runs the handler — no pubsub subscription, no stream
 * pipeline. One entry per attached `Event.handler`.
 */
interface HandlerEntry {
  queue: Array<unknown>;
  waiter: Deferred.Deferred<void> | undefined;
  closed: boolean;
  readonly tracker: SubscriptionTracker;
}

const handlerEntries = new WeakMap<RegistryService, Map<string, Set<HandlerEntry>>>();

const registerHandlerEntry = (
  registry: RegistryService,
  id: string,
  entry: HandlerEntry,
): void => {
  let byEvent = handlerEntries.get(registry);
  if (byEvent === undefined) {
    byEvent = new Map();
    handlerEntries.set(registry, byEvent);
  }
  const entries = byEvent.get(id);
  if (entries === undefined) {
    byEvent.set(id, new Set([entry]));
  } else {
    entries.add(entry);
  }
};

const offerHandlers = (registry: RegistryService, id: string, value: unknown): void => {
  const entries = handlerEntries.get(registry)?.get(id);
  if (entries === undefined || entries.size === 0) return;
  for (const entry of entries) {
    if (entry.closed) continue;
    entry.queue.push(value);
    if (entry.waiter !== undefined) {
      const waiter = entry.waiter;
      entry.waiter = undefined;
      Deferred.doneUnsafe(waiter, Effect.void);
    }
  }
};

/** Idempotent teardown: unregister, return the tracker's counts to the settle
 * ledger, and let a parked drain observe `closed` and exit. */
const closeHandlerEntry = (registry: RegistryService, id: string, entry: HandlerEntry): void => {
  if (entry.closed) return;
  entry.closed = true;
  entry.queue = [];
  const byEvent = handlerEntries.get(registry);
  const entries = byEvent?.get(id);
  if (entries !== undefined) {
    entries.delete(entry);
    if (entries.size === 0) byEvent?.delete(id);
  }
  releaseSubscription(registry, id, entry.tracker);
  if (entry.waiter !== undefined) {
    const waiter = entry.waiter;
    entry.waiter = undefined;
    Deferred.doneUnsafe(waiter, Effect.void);
  }
};

/**
 * INTERNAL. One synchronous dispatch step: counting, pubsub publication, and
 * direct handler delivery — the order every emit path must keep (a subscriber
 * woken by the publish must already find its item accounted for). The store
 * layer feeds `Store.changed` events through this without a watcher pipeline.
 * The debug window spans the whole step, so synchronously ran handlers (and
 * whatever they publish) record this emit as their cause.
 */
export const dispatchUnsafe = <A>(
  registry: RegistryService,
  channel: PubSub.PubSub<A>,
  event: { readonly id: string; readonly name?: string },
  value: A,
): void => {
  const closeWindow = registry.debug !== undefined ? registry.debug.emit(event, value) : undefined;
  trackPublish(registry, event.id);
  PubSub.publishUnsafe(channel, value);
  offerHandlers(registry, event.id, value);
  closeWindow?.();
};

const emitSlow = <A>(event: Sink<A>, value: A): Effect.Effect<void, never, Registry> =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    const channel = yield* pubsub(event);
    yield* Effect.sync(() => dispatchUnsafe(registry, channel, event, value));
  });

export const emit = <E extends Sink<any>>(
  event: E,
  ...args: EmitArgs<PayloadOf<E>>
): Effect.Effect<void, never, Registry> => {
  // `EmitArgs<void>` permits zero arguments; the runtime payload is still
  // exactly the event value, i.e. `undefined`.
  // eslint-disable-next-line revizo/no-type-assertion
  const value = args[0] as PayloadOf<E>;
  if (isSetter(event)) return Store.set(targetOf(event), value);
  // The hot path: with the channel already materialized, counting, publishing
  // and handler dispatch run in one synchronous step on the current fiber —
  // exactly the `Effect.sync` critical section of the slow path.
  return Effect.withFiber((fiber) => {
    const registry = Context.getOrUndefined(fiber.context, Registry);
    if (registry !== undefined) {
      const channel = registry.events.get(event.id);
      if (channel !== undefined) {
        dispatchUnsafe(registry, channel, event, value);
        return Effect.void;
      }
    }
    return emitSlow(event, value);
  });
};

/** Builds the source's stream by registering every channel subscription in
 * one effect — combined sources are all subscribed before the first value
 * flows, so a merged stream cannot miss an early emit on a source whose
 * inner subscription would otherwise still be spinning up. The subscriptions
 * live in the `Scope` this runs in (the stream's own scope via
 * `Stream.unwrap` — released when the stream ends). */
const subscribedSource = <A>(
  event: Source<A>,
): Effect.Effect<Stream.Stream<A, never, Registry>, never, Registry | Scope.Scope> => {
  if (isSetter(event)) return Effect.succeed(Store.stream(targetOf(event)));
  if (isCombined(event)) {
    return Effect.forEach(event[CombinedTypeId].sources, subscribedSource).pipe(
      Effect.map((streams) => Stream.mergeAll(streams, { concurrency: "unbounded" })),
    );
  }
  return Effect.gen(function* () {
    const registry = yield* Registry;
    const channel = yield* pubsub(event);
    const scope = yield* Effect.scope;
    // Subscribe first, register right after: an item slipping in between is
    // merely delivered uncounted and completes silently, while the reverse
    // order could count an item the subscription never receives.
    const subscription = yield* PubSub.subscribe(channel);
    const tracker = trackSubscription(registry, event.id, 0);
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => releaseSubscription(registry, event.id, tracker)),
    );
    return trackedStream(registry, subscription, tracker);
  });
};

export const stream = <A>(event: Source<A>): Stream.Stream<A, never, Registry> => {
  if (isSetter(event)) return Store.stream(targetOf(event));
  return Stream.unwrap(subscribedSource(event));
};

/** `waitFor` options without a timeout: the wait can only end with a match
 * (or the interruption/failure paths documented on {@link waitFor}). */
export interface WaitForOptions {
  readonly timeout?: undefined;
}

/** `waitFor` options with a timeout: the wait additionally fails with
 * `Cause.TimeoutError` when no emission matched in time. */
export interface WaitForTimeoutOptions {
  readonly timeout: Duration.Input;
}

/**
 * Waits for the event's first emission satisfying `predicate` — the first
 * emission at all without one. Events have no current value (subscribers only
 * see emits after they attach), so there is no `skipCurrent`.
 *
 * - A plain predicate keeps `E = never` (the timeout error only enters the
 *   error channel when `timeout` is passed); a refinement narrows the payload.
 * - An effectful predicate runs sequentially, one emission at a time in
 *   order: every payload is checked and none is skipped — unlike
 *   `Store.waitFor`'s switch-to-latest, an event is a discrete fact, not a
 *   superseding snapshot. A failing predicate effect fails `waitFor` with
 *   that error.
 * - `timeout` fails with `Cause.TimeoutError` — exactly the error
 *   `Effect.timeout` raises.
 * - The event's stream ending before a match (the owning scope shut the
 *   channel down) interrupts the waiter: the awaited emission can never
 *   arrive.
 *
 * The subscription is tracked like any `stream` subscription and released on
 * every exit path — match, predicate failure, timeout, interruption. An
 * emission the predicate rejected is confirmed as handled, so a parked
 * `waitFor` holds nothing and never wedges `Registry.allSettled`.
 */
export function waitFor<A, B extends A>(
  event: Source<A>,
  predicate: (payload: A) => payload is B,
  options: WaitForTimeoutOptions,
): Effect.Effect<B, Cause.TimeoutError, Registry>;
export function waitFor<A, B extends A>(
  event: Source<A>,
  predicate: (payload: A) => payload is B,
  options?: WaitForOptions,
): Effect.Effect<B, never, Registry>;
export function waitFor<A>(
  event: Source<A>,
  predicate: (payload: A) => boolean,
  options: WaitForTimeoutOptions,
): Effect.Effect<A, Cause.TimeoutError, Registry>;
export function waitFor<A>(
  event: Source<A>,
  predicate: (payload: A) => boolean,
  options?: WaitForOptions,
): Effect.Effect<A, never, Registry>;
export function waitFor<A, E, R>(
  event: Source<A>,
  predicate: (payload: A) => Effect.Effect<boolean, E, R>,
  options: WaitForTimeoutOptions,
): Effect.Effect<A, E | Cause.TimeoutError, Registry | R>;
export function waitFor<A, E, R>(
  event: Source<A>,
  predicate: (payload: A) => Effect.Effect<boolean, E, R>,
  options?: WaitForOptions,
): Effect.Effect<A, E, Registry | R>;
export function waitFor<A>(
  event: Source<A>,
  options: WaitForTimeoutOptions,
): Effect.Effect<A, Cause.TimeoutError, Registry>;
export function waitFor<A>(
  event: Source<A>,
  options?: WaitForOptions,
): Effect.Effect<A, never, Registry>;
export function waitFor(
  event: Source<any>,
  predicateOrOptions?: WaitPredicate<any> | WaitForOptions | WaitForTimeoutOptions,
  options?: WaitForOptions | WaitForTimeoutOptions,
): Effect.Effect<any, any, any> {
  const predicate = typeof predicateOrOptions === "function" ? predicateOrOptions : undefined;
  const resolved = typeof predicateOrOptions === "function" ? options : predicateOrOptions;
  const matches =
    predicate === undefined
      ? stream(event)
      : // Sequential: each payload is evaluated in order, none is skipped.
        Stream.filterEffect(stream(event), (payload) => evaluate(predicate, payload));
  return awaitFirst(matches, resolved?.timeout);
}

type HandlerInput<A> = Source<A> | Effect.Effect<Source<A>, any, any>;

type HandlerResult<A, R, Input extends HandlerInput<A>> =
  Input extends Effect.Effect<infer E extends Source<A>, infer EffE, infer EffR>
    ? Effect.Effect<E, EffE, EffR | R | Registry>
    : Input extends Source<A>
      ? Effect.Effect<Input, never, R | Registry>
      : never;

/**
 * Pipe-combinator for "on event source, do effect": forks a sequential
 * pipeline that runs `handle` for every emit, in the owner scope via
 * `Registry.run` — same error-free gate (`E = never`), same defect logging,
 * same `allSettled` accounting as a hand-written pipeline. Returns the
 * descriptor itself, so it composes at the declaration site:
 *
 * ```ts
 * const open = yield* Event.make<string>().pipe(Event.handler((url) => ...));
 * ```
 *
 * Owner-only: it takes an `Event.Source`, never a sink-only port. Apply it
 * more than once for multiple independent handlers.
 *
 * `{ concurrency: "unbounded" }` forks each emission's handling into the
 * owner's scope instead of processing sequentially. This is the ONLY
 * sanctioned way to handle an event concurrently: piping `Event.stream`
 * through `Stream.mapEffect(..., { concurrency })` yourself breaks the
 * subscribe-synchronously-at-fork invariant (the merge machinery inserts a
 * scheduler hop before the first pull), so an emission fired later in the
 * same synchronous chain is silently lost. Here the pull loop stays
 * sequential — the subscription registers at fork like any simple pipeline —
 * and only the handling forks.
 */
/** The drain loop of one direct handler subscription: batches like a pull,
 * runs the handler per item (sequentially, or forked for
 * `concurrency: "unbounded"`), and confirms each item for `allSettled` the
 * moment its handling finished (fork counts as handled at fork — the pull
 * loop it replaces confirmed a forked item on the very next pull). */
const drainHandler = <A, R>(
  registry: RegistryService,
  entry: HandlerEntry,
  handle: (value: A) => Effect.Effect<unknown, never, R>,
  scope: Scope.Scope,
  concurrent: boolean,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    while (true) {
      if (entry.queue.length === 0) {
        if (entry.closed) return;
        const waiter = Deferred.makeUnsafe<void>();
        entry.waiter = waiter;
        yield* Deferred.await(waiter);
        continue;
      }
      const items = entry.queue;
      entry.queue = [];
      for (const item of items) {
        if (entry.closed) return;
        // The queue only ever holds this handler's payload type.
        // eslint-disable-next-line revizo/no-type-assertion
        const value = item as A;
        if (concurrent) {
          yield* Effect.forkIn(
            handle(value).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                  ? Effect.logError(
                      "Unitflow concurrent handler terminated unexpectedly",
                      exit.cause,
                    )
                  : Effect.void,
              ),
            ),
            scope,
            { startImmediately: true },
          );
        } else {
          yield* handle(value);
        }
        completeCounted(registry, entry.tracker);
      }
    }
  });

export const handler =
  <A = any, R = never>(
    handle: (value: A) => Effect.Effect<unknown, never, R>,
    options?: { readonly concurrency?: "unbounded" },
  ): (<Input extends HandlerInput<A>>(event: Input) => HandlerResult<A, R, Input>) => {
    // Setter sources are store-backed: their handler pipeline is the store
    // stream, unchanged. Plain events take the direct dispatch path.
    const attachStream = (source: Source<A>): Effect.Effect<void, never, R | Registry> =>
      options?.concurrency === "unbounded"
        ? Effect.gen(function* () {
            const scope = yield* ownerScope;
            yield* Registry.run(
              stream(source).pipe(
                Stream.mapEffect((value) =>
                  Effect.forkIn(
                    handle(value).pipe(
                      Effect.onExit((exit) =>
                        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                          ? Effect.logError(
                              "Unitflow concurrent handler terminated unexpectedly",
                              exit.cause,
                            )
                          : Effect.void,
                      ),
                    ),
                    scope,
                    { startImmediately: true },
                  ),
                ),
              ),
            );
          })
        : Registry.run(stream(source).pipe(Stream.mapEffect(handle)));

    const attachDirect = (source: Source<A>): Effect.Effect<void, never, R | Registry> =>
      Effect.gen(function* () {
        const registry = yield* Registry;
        const scope = yield* ownerScope;
        // Materialize the channel exactly like the stream subscription would
        // have: pubsub ownership (who created it, whose scope shuts it down)
        // must not depend on the dispatch mechanism.
        yield* pubsub(source);
        const tracker = trackSubscription(registry, source.id, 0);
        const entry: HandlerEntry = { queue: [], waiter: undefined, closed: false, tracker };
        registerHandlerEntry(registry, source.id, entry);
        // Finalizer order on scope close: the drain fiber (attached by
        // `forkIn` below, LIFO-first) is interrupted before this cleanup
        // returns the tracker's counts — the order the stream pipeline died in.
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => closeHandlerEntry(registry, source.id, entry)),
        );
        yield* Effect.forkIn(
          drainHandler(registry, entry, handle, scope, options?.concurrency === "unbounded").pipe(
            Effect.onExit((exit) =>
              Effect.suspend(() => {
                closeHandlerEntry(registry, source.id, entry);
                return Exit.isFailure(exit) && !isExpectedTermination(exit.cause)
                  ? Effect.logError("Unitflow pipeline terminated unexpectedly", exit.cause)
                  : Effect.void;
              }),
            ),
          ),
          scope,
          { startImmediately: true },
        );
      });

    const attachSource = (source: Source<A>): Effect.Effect<void, never, R | Registry> => {
      if (isCombined(source)) {
        return Effect.forEach(
          sourcesOf(source),
          (inner) => attachSource(inner as Source<A>),
          { discard: true },
        );
      }
      return isSetter(source) ? attachStream(source) : attachDirect(source);
    };
    const attach = (
      eventOrEffect: Source<A> | Effect.Effect<Source<A>, unknown, unknown>,
    ): Effect.Effect<Source<A>, unknown, unknown> =>
      Effect.isEffect(eventOrEffect)
        ? Effect.flatMap(eventOrEffect, attach)
        : Effect.as(attachSource(eventOrEffect), eventOrEffect);
    return attach as <Input extends HandlerInput<A>>(event: Input) => HandlerResult<A, R, Input>;
  };

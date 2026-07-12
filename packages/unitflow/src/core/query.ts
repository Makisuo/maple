import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Event from "./event.js";
import { makeSlot, type PersistOptions } from "./persistence.js";
import { Registry } from "./registry.js";
import * as Store from "./store.js";

/**
 * A remote read owned by a model: an `AsyncResult` store fed by one loader
 * pipeline. It loads eagerly at construction, reloads on every `refresh`
 * emit, and when declared with dependency stores, reloads whenever a
 * dependency changes, handing the handler fresh dependency values each run.
 */
export interface Query<
  A,
  E,
  Deps extends Record<string, Store.Source<any>> = Record<never, never>,
> {
  /** The full store: the owning model may override it manually
   * (`Store.set(query.state, ...)`). */
  readonly state: Store.Store<AsyncResult.AsyncResult<A, E>>;
  /** Emitting reloads. Expose it directly as an input/ui port. */
  readonly refresh: Event.Event<void>;
  /** The declared dependency stores: combinators read fresh values here. */
  readonly stores: Deps;
}

export type DepValues<Deps> = {
  readonly [K in keyof Deps]: Deps[K] extends Store.Source<infer A> ? A : never;
};

/** A query created by {@link makeInfinite}: its state is the flat
 * concatenation of every loaded page. */
export interface Paginated<
  Item,
  E,
  Deps extends Record<string, Store.Source<any>> = Record<never, never>,
> extends Query<ReadonlyArray<Item>, E, Deps> {
  /** Emitting appends the next page (no-op while loading or exhausted). */
  readonly loadMore: Event.Event<void>;
  /** Whether another page exists, derived from the last page's `next`. */
  readonly hasMore: Store.Combined<boolean>;
}

export interface MakeOptions<Deps extends Record<string, Store.Source<any>>, A, E, R> {
  readonly stores?: Deps;
  readonly handler: (deps: DepValues<Deps>) => Effect.Effect<A, E, R>;
}

/** One page from a {@link makeInfinite} handler: the items plus the cursor of
 * the next page — `Option.some(cursor)` when another page exists,
 * `Option.none()` when exhausted. */
export interface PageResult<Item, Cursor> {
  readonly data: ReadonlyArray<Item>;
  readonly next: Option.Option<Cursor>;
}

export interface InfiniteOptions<
  Deps extends Record<string, Store.Source<any>>,
  Item,
  Cursor,
  E,
  R,
> {
  readonly stores?: Deps;
  /** The cursor of the first page — `refresh` and dependency changes restart
   * from it. Doubles as the inference anchor for the cursor type: token
   * cursors start from `null as string | null`. */
  readonly initialCursor: Cursor;
  /** Fetches one page: `cursor` is `initialCursor` for the first page,
   * afterwards the previous page's `next`. */
  readonly handler: (
    deps: DepValues<Deps>,
    cursor: Cursor,
  ) => Effect.Effect<PageResult<Item, Cursor>, E, R>;
}

/**
 * Runs one fetch into an `AsyncResult` store: marks it waiting (keeping the
 * previous value on screen), then records success or failure (a failure keeps
 * the previous success, so a flaky refetch never blanks loaded data). The
 * returned effect never fails: failures are state.
 */
const load = <A, E, R>(
  store: Store.Store<AsyncResult.AsyncResult<A, E>>,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, R | Registry> =>
  Effect.gen(function* () {
    // Start the request before publishing waiting so an observer woken by the
    // waiting emission finds the request already in flight.
    const fiber = yield* Effect.forkChild(request, { startImmediately: true });
    yield* Store.update(store, (current) => AsyncResult.waiting(current));
    yield* Fiber.join(fiber).pipe(
      Effect.matchCauseEffect({
        onSuccess: (value) => Store.set(store, AsyncResult.success(value)),
        onFailure: (cause) =>
          Store.update(store, (current) =>
            AsyncResult.failureWithPrevious(cause, { previous: Option.some(current) }),
          ),
      }),
    );
  });

/** Reads the current value of every dependency store, keyed as declared. */
const depValues = <Deps extends Record<string, Store.Source<any>>>(
  stores: Deps,
): Effect.Effect<DepValues<Deps>, never, Registry> =>
  Effect.gen(function* () {
    const out: Record<string, unknown> = {};
    for (const [key, source] of Object.entries(stores)) {
      out[key] = yield* Store.get(source);
    }
    return out as DepValues<Deps>;
  });

/** Builds the shared query skeleton: an `AsyncResult` store fed by `request`,
 * reloaded on `refresh` and on every dependency change. */
const base = <Deps extends Record<string, Store.Source<any>>, A, E, R>(
  stores: Deps,
  request: (deps: DepValues<Deps>) => Effect.Effect<A, E, R>,
): Effect.Effect<Query<A, E, Deps>, never, R | Registry> =>
  Effect.gen(function* () {
    const state = Store.make<AsyncResult.AsyncResult<A, E>>(AsyncResult.initial(true));

    // The handler always receives fresh dependency values, read right before
    // each run.
    const run = Effect.flatMap(depValues(stores), (deps) => load(state, request(deps)));

    const refresh = yield* Event.make().pipe(Event.handler(() => run));
    const readySignals: Array<Deferred.Deferred<void>> = [];
    for (const source of Object.values(stores)) {
      const ready = yield* Deferred.make<void>();
      readySignals.push(ready);
      yield* Registry.run(
        Store.stream(source).pipe(
          Stream.tap(() => Deferred.succeed(ready, undefined)),
          Stream.drop(1),
          Stream.mapEffect(() => run),
        ),
      );
    }
    yield* Effect.forEach(readySignals, Deferred.await, { discard: true });

    // The initial load goes through the refresh channel so `Registry.allSettled`
    // covers construction-time loads.
    yield* Event.emit(refresh);

    return { state, refresh, stores };
  });

/**
 * Builds a paginated query around one page handler. The base loader fetches
 * the first page (`cursor === initialCursor`) and records the next cursor;
 * `loadMore` fetches with that cursor and appends. The cursor never leaks
 * into the state: it is bookkeeping, not data.
 */
export const makeInfinite = <
  Deps extends Record<string, Store.Source<any>>,
  Item,
  Cursor,
  E,
  R,
>(
  options: InfiniteOptions<Deps, Item, Cursor, E, R>,
): Effect.Effect<Paginated<Item, E, Deps>, never, R | Registry> =>
  Effect.gen(function* () {
    const stores = (options.stores ?? {}) as Deps;
    // `None` means exhausted or nothing loaded yet. Updated only on
    // successful loads, so a failed page leaves `loadMore` retryable.
    const cursor = Store.make<Option.Option<Cursor>>(Option.none());

    const query = yield* base<Deps, ReadonlyArray<Item>, E, R | Registry>(stores, (deps) =>
      options.handler(deps, options.initialCursor).pipe(
        Effect.tap((page) => Store.set(cursor, page.next)),
        Effect.map((page) => page.data),
      ),
    );

    const hasMore = Store.combine([cursor], Option.isSome);

    const loadMore = yield* Event.make().pipe(
      Event.handler(() =>
        Effect.gen(function* () {
          const current = yield* Store.get(query.state);
          if (current.waiting) return;
          const loaded = AsyncResult.value(current);
          if (Option.isNone(loaded)) return;
          const next = yield* Store.get(cursor);
          if (Option.isNone(next)) return;
          const deps = yield* depValues(stores);
          yield* Store.update(query.state, (state) => AsyncResult.waiting(state));
          yield* Effect.forkChild(
            options.handler(deps, next.value).pipe(
              Effect.matchCauseEffect({
                onSuccess: (page) =>
                  Store.set(cursor, page.next).pipe(
                    Effect.flatMap(() =>
                      Store.set(
                        query.state,
                        AsyncResult.success([...loaded.value, ...page.data]),
                      ),
                    ),
                  ),
                onFailure: (cause) =>
                  Store.update(query.state, (state) =>
                    AsyncResult.failureWithPrevious(cause, { previous: Option.some(state) }),
                  ),
              }),
            ),
            { startImmediately: true },
          );
        }),
      ),
    );

    return { ...query, loadMore, hasMore };
  });

export function make<A, E, R>(
  request: Effect.Effect<A, E, R>,
): Effect.Effect<Query<A, E>, never, R | Registry>;
export function make<Deps extends Record<string, Store.Source<any>>, A, E, R>(
  options: MakeOptions<Deps, A, E, R>,
): Effect.Effect<Query<A, E, Deps>, never, R | Registry>;
export function make(
  requestOrOptions:
    | Effect.Effect<any, any, any>
    | MakeOptions<Record<string, Store.Source<any>>, any, any, any>,
): Effect.Effect<any, never, any> {
  return Effect.isEffect(requestOrOptions)
    ? base({}, () => requestOrOptions)
    : base(requestOrOptions.stores ?? {}, requestOrOptions.handler);
}

/** Forks one pipeline per source that reloads the query whenever that
 * source emits. */
export const refetchOn =
  (...sources: ReadonlyArray<Event.Source<any>>) =>
  <R extends Query<any, any, any>, E, Req>(
    self: Effect.Effect<R, E, Req>,
  ): Effect.Effect<R, E, Req | Registry> =>
    Effect.tap(self, (query) =>
      Effect.forEach(
        sources,
        (source) =>
          Registry.run(
            Event.stream(source).pipe(Stream.mapEffect(() => Event.emit(query.refresh))),
          ),
        { discard: true },
      ),
    );

/**
 * Persists every settled success into a `KeyValueStore` under `key`, and on
 * construction seeds the state from the stored copy while the initial load is
 * still in flight (stale-while-revalidate). Best-effort: storage and codec
 * failures are logged as warnings and never affect the query itself. A stored
 * entry that fails to decode — or is older than `timeToLive` — is a miss.
 * A load that settles (success or failure) before the restore completes wins:
 * settled network state is fresher information than the stored copy.
 */
export const persist =
  <A, I>(options: PersistOptions<A, I>) =>
  <Q extends Query<A, any, any>, Req>(
    self: Effect.Effect<Q, never, Req>,
  ): Effect.Effect<Q, never, Req | KeyValueStore.KeyValueStore | Registry> =>
    Effect.tap(self, (query) =>
      Effect.gen(function* () {
        const slot = yield* makeSlot(options);

        // Seed only while the initial load has not settled, and keep the
        // waiting flag: the load fired at construction is still in flight.
        const seed = Effect.flatMap(
          slot.load,
          Option.match({
            onNone: () => Effect.void,
            onSome: (value) =>
              Store.update(query.state, (current) =>
                AsyncResult.isInitial(current)
                  ? AsyncResult.waiting(AsyncResult.success(value))
                  : current,
              ),
          }),
        );

        // The seed pipeline starts first so the save subscription below never
        // observes state older than the seeded value; the seeded state itself
        // is marked waiting, so it is not echoed back into the store.
        yield* Registry.run(Stream.fromEffect(seed));
        yield* Registry.run(
          Store.stream(query.state).pipe(
            Stream.filter(
              (result): result is AsyncResult.Success<A, any> =>
                AsyncResult.isSuccess(result) && !result.waiting,
            ),
            Stream.mapEffect((result) => slot.save(result.value)),
          ),
        );
      }),
    );

/** Forks a pipeline that reloads the query on every schedule step. */
export const repeat =
  <Out, SR>(schedule: Schedule.Schedule<Out, unknown, never, SR>) =>
  <R extends Query<any, any, any>, E, Req>(
    self: Effect.Effect<R, E, Req>,
  ): Effect.Effect<R, E, Req | SR | Registry> =>
    Effect.tap(self, (query) =>
      Registry.run(
        Stream.fromSchedule(schedule).pipe(Stream.mapEffect(() => Event.emit(query.refresh))),
      ),
    );

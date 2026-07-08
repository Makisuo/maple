import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { Event, Registry, Store } from "../src/core/index.js";
import * as Query from "../src/core/query.js";

const awaitCondition = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (!predicate()) {
      yield* Effect.yieldNow;
    }
  });

const successValue = <A, E>(result: AsyncResult.AsyncResult<A, E>): A | null =>
  Option.getOrElse(
    Option.map(AsyncResult.value(result), (value): A | null => value),
    () => null,
  );

const persistLayer = Layer.mergeAll(Registry.layer, KeyValueStore.layerMemory);

/** Waits until `Query.persist`'s background save pipeline lands in the KVS. */
const waitForSaved = (key: string) =>
  Effect.gen(function* () {
    const kvs = yield* KeyValueStore.KeyValueStore;
    while ((yield* kvs.get(key)) === undefined) {
      yield* Effect.yieldNow;
    }
  });

/** A few scheduler turns: enough for the construction-time restore pipeline
 * to finish against the in-memory KVS. */
const settlePipelines = Effect.gen(function* () {
  for (let i = 0; i < 25; i++) {
    yield* Effect.yieldNow;
  }
});

/** A request that parks each run on its own deferred, so tests control when
 * every load settles. */
const gatedRequest = <A, E = never>() => {
  const gates: Array<Deferred.Deferred<A, E>> = [];
  const request = Effect.suspend(() => {
    const gate = Deferred.makeUnsafe<A, E>();
    gates.push(gate);
    return Deferred.await(gate);
  });
  const gateAt = (index: number) => {
    const gate = gates[index];
    if (gate === undefined) throw new Error(`Missing gate ${index}`);
    return gate;
  };
  return { gates, request, gateAt };
};

describe("Query", () => {
  it.effect("loads eagerly once at construction", () =>
    Effect.gen(function* () {
      let calls = 0;
      const query = yield* Query.make(
        Effect.sync(() => {
          calls += 1;
          return calls;
        }),
      );

      assert.isTrue(AsyncResult.isInitial(query.state.initial));
      yield* Store.waitFor(query.state, (result) => successValue(result) === 1);
      assert.strictEqual(calls, 1);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("refresh keeps the previous value while waiting", () =>
    Effect.gen(function* () {
      const backend = gatedRequest<number>();
      const query = yield* Query.make(backend.request);

      yield* awaitCondition(() => backend.gates.length === 1);
      yield* Deferred.succeed(backend.gateAt(0), 1);
      yield* Store.waitFor(query.state, (result) => successValue(result) === 1);

      yield* Event.emit(query.refresh);
      yield* awaitCondition(() => backend.gates.length === 2);

      const waiting = yield* Store.get(query.state);
      assert.isTrue(AsyncResult.isWaiting(waiting));
      assert.strictEqual(successValue(waiting), 1);

      yield* Deferred.succeed(backend.gateAt(1), 2);
      yield* Store.waitFor(
        query.state,
        (result) => successValue(result) === 2 && !result.waiting,
      );
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("a dependency change reloads with the fresh dependency value", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const dep = Store.make("a");
      const query = yield* Query.make({
        stores: { dep },
        handler: ({ dep: value }) =>
          Effect.sync(() => {
            seen.push(value);
            return value.toUpperCase();
          }),
      });

      yield* Store.waitFor(query.state, (result) => successValue(result) === "A");
      yield* Registry.allSettled(Store.set(dep, "b"));
      assert.strictEqual(successValue(yield* Store.get(query.state)), "B");
      assert.deepStrictEqual(seen, ["a", "b"]);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("a combined dependency change reloads with the fresh dependency value", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const dep = Store.make("a");
      const combined = Store.combine([dep], (value) => value);
      const query = yield* Query.make({
        stores: { combined },
        handler: ({ combined: value }) =>
          Effect.sync(() => {
            seen.push(value);
            return value.toUpperCase();
          }),
      });

      yield* Store.waitFor(query.state, (result) => successValue(result) === "A");
      yield* Registry.allSettled(Store.set(dep, "b"));
      assert.strictEqual(successValue(yield* Store.get(query.state)), "B");
      assert.deepStrictEqual(seen, ["a", "b"]);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("a nested combined dependency change reloads with the fresh dependency value", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const dep = Store.make("a");
      const combined = Store.combine([dep], (value) => value);
      const nested = Store.combine([combined], (value) => value);
      const query = yield* Query.make({
        stores: { nested },
        handler: ({ nested: value }) =>
          Effect.sync(() => {
            seen.push(value);
            return value.toUpperCase();
          }),
      });

      yield* Store.waitFor(query.state, (result) => successValue(result) === "A");
      yield* Registry.allSettled(Store.set(dep, "b"));
      assert.strictEqual(successValue(yield* Store.get(query.state)), "B");
      assert.deepStrictEqual(seen, ["a", "b"]);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("a failed reload keeps the previous success", () =>
    Effect.gen(function* () {
      let calls = 0;
      const query = yield* Query.make(
        Effect.suspend(() => {
          calls += 1;
          return calls === 1 ? Effect.succeed("one") : Effect.fail("boom");
        }),
      );

      yield* Store.waitFor(query.state, (result) => successValue(result) === "one");
      yield* Registry.allSettled(Event.emit(query.refresh));

      const failed = yield* Store.get(query.state);
      assert.isTrue(AsyncResult.isFailure(failed));
      assert.strictEqual(successValue(failed), "one");
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("refetchOn reloads when any source emits", () =>
    Effect.gen(function* () {
      let calls = 0;
      const saved = Event.make();
      const removed = Event.make();
      const query = yield* Query.make(
        Effect.sync(() => {
          calls += 1;
          return calls;
        }),
      ).pipe(Query.refetchOn(saved, removed));

      yield* Store.waitFor(query.state, (result) => successValue(result) === 1);
      yield* Registry.allSettled(Event.emit(saved));
      assert.strictEqual(successValue(yield* Store.get(query.state)), 2);
      yield* Registry.allSettled(Event.emit(removed));
      assert.strictEqual(successValue(yield* Store.get(query.state)), 3);
      assert.strictEqual(calls, 3);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("repeat reloads on every schedule step", () =>
    Effect.gen(function* () {
      let calls = 0;
      const query = yield* Query.make(
        Effect.sync(() => {
          calls += 1;
          return calls;
        }),
      ).pipe(Query.repeat(Schedule.spaced("30 seconds")));

      yield* Store.waitFor(query.state, (result) => successValue(result) === 1);

      yield* TestClock.adjust("30 seconds");
      yield* Store.waitFor(query.state, (result) => successValue(result) === 2);

      yield* TestClock.adjust("30 seconds");
      yield* Store.waitFor(query.state, (result) => successValue(result) === 3);
      assert.strictEqual(calls, 3);
    }).pipe(Effect.provide(Registry.layer)),
  );

  describe("makeInfinite", () => {
    /** Pages of two items counting up from `start`, exhausted after 6. */
    const fetchPage = (start: number): Query.PageResult<number, number> => ({
      data: [start, start + 1],
      next: start + 2 <= 5 ? Option.some(start + 2) : Option.none(),
    });

    const makePaginated = Query.makeInfinite({
      initialCursor: 1,
      handler: (_deps, cursor) => Effect.sync(() => fetchPage(cursor)),
    });

    it.effect("loadMore appends pages and hasMore flips false when exhausted", () =>
      Effect.gen(function* () {
        const query = yield* makePaginated;

        yield* Store.waitFor(query.state, (result) => successValue(result)?.length === 2);
        assert.isTrue(yield* Store.get(query.hasMore));

        yield* Registry.allSettled(Event.emit(query.loadMore));
        assert.deepStrictEqual(successValue(yield* Store.get(query.state)), [1, 2, 3, 4]);
        assert.isTrue(yield* Store.get(query.hasMore));

        yield* Registry.allSettled(Event.emit(query.loadMore));
        assert.deepStrictEqual(successValue(yield* Store.get(query.state)), [1, 2, 3, 4, 5, 6]);
        assert.isFalse(yield* Store.get(query.hasMore));

        yield* Registry.allSettled(Event.emit(query.loadMore));
        assert.strictEqual(successValue(yield* Store.get(query.state))?.length, 6);
      }).pipe(Effect.provide(Registry.layer)),
    );

    it.effect("refresh resets to the first page", () =>
      Effect.gen(function* () {
        const query = yield* makePaginated;

        yield* Store.waitFor(query.state, (result) => successValue(result)?.length === 2);
        yield* Registry.allSettled(Event.emit(query.loadMore));
        assert.strictEqual(successValue(yield* Store.get(query.state))?.length, 4);

        yield* Registry.allSettled(Event.emit(query.refresh));
        assert.deepStrictEqual(successValue(yield* Store.get(query.state)), [1, 2]);
        assert.isTrue(yield* Store.get(query.hasMore));
      }).pipe(Effect.provide(Registry.layer)),
    );

    it.effect("a dependency change resets to the first page", () =>
      Effect.gen(function* () {
        const start = Store.make(1);
        const query = yield* Query.makeInfinite({
          stores: { start },
          initialCursor: 0, // 0 = "первая страница": реальный старт берётся из deps
          handler: ({ start }, cursor) => Effect.sync(() => fetchPage(cursor === 0 ? start : cursor)),
        });

        yield* Store.waitFor(query.state, (result) => successValue(result)?.length === 2);
        yield* Registry.allSettled(Event.emit(query.loadMore));
        assert.deepStrictEqual(successValue(yield* Store.get(query.state)), [1, 2, 3, 4]);

        yield* Registry.allSettled(Store.set(start, 3));
        assert.deepStrictEqual(successValue(yield* Store.get(query.state)), [3, 4]);
        assert.isTrue(yield* Store.get(query.hasMore));
      }).pipe(Effect.provide(Registry.layer)),
    );

    it.effect("a failed loadMore keeps the loaded value and stays retryable", () =>
      Effect.gen(function* () {
        let fail = false;
        const query = yield* Query.makeInfinite({
          initialCursor: 1,
          handler: (_deps, cursor) =>
            Effect.suspend(() =>
              fail ? Effect.fail("boom" as const) : Effect.succeed(fetchPage(cursor)),
            ),
        });

        yield* Store.waitFor(query.state, (result) => successValue(result)?.length === 2);

        fail = true;
        yield* Registry.allSettled(Event.emit(query.loadMore));
        const failed = yield* Store.get(query.state);
        assert.isTrue(AsyncResult.isFailure(failed));
        assert.deepStrictEqual(successValue(failed), [1, 2]);
        assert.isTrue(yield* Store.get(query.hasMore));

        fail = false;
        yield* Registry.allSettled(Event.emit(query.loadMore));
        assert.deepStrictEqual(successValue(yield* Store.get(query.state)), [1, 2, 3, 4]);
      }).pipe(Effect.provide(Registry.layer)),
    );

    it.effect("persist restores the concatenated pages of a paginated query", () =>
      Effect.gen(function* () {
        const schema = Schema.Array(Schema.Number);
        const source = yield* Query.makeInfinite({
          initialCursor: 1,
          handler: (_deps, cursor) => Effect.succeed(fetchPage(cursor)),
        }).pipe(Query.persist({ key: "pages", schema }));
        yield* Store.waitFor(source.state, (result) => successValue(result)?.length === 2);
        yield* Registry.allSettled(Event.emit(source.loadMore));
        yield* waitForSaved("pages");

        const backend = gatedRequest<Query.PageResult<number, number>>();
        const restored = yield* Query.makeInfinite({
          initialCursor: 1,
          handler: () => backend.request,
        }).pipe(Query.persist({ key: "pages", schema }));
        yield* Store.waitFor(
          restored.state,
          (result) => successValue(result)?.length === 4 && result.waiting,
        );
        assert.deepStrictEqual(successValue(yield* Store.get(restored.state)), [1, 2, 3, 4]);
      }).pipe(Effect.provide(persistLayer)),
    );

    it.effect("loadMore during a load in flight is a no-op", () =>
      Effect.gen(function* () {
        const pageCalls: Array<number> = [];
        const gates: Array<Deferred.Deferred<Query.PageResult<number, number>>> = [];
        const query = yield* Query.makeInfinite({
          initialCursor: 1,
          handler: (_deps, cursor) =>
            cursor === 1
              ? Effect.succeed(fetchPage(1))
              : Effect.suspend(() => {
                  pageCalls.push(cursor);
                  const gate = Deferred.makeUnsafe<Query.PageResult<number, number>>();
                  gates.push(gate);
                  return Deferred.await(gate);
                }),
        });

        yield* Store.waitFor(query.state, (result) => successValue(result)?.length === 2);

        yield* Event.emit(query.loadMore);
        yield* awaitCondition(() => pageCalls.length === 1);
        yield* Event.emit(query.loadMore);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(pageCalls, [3]);

        const gate = gates[0];
        assert.isDefined(gate);
        if (gate !== undefined) yield* Deferred.succeed(gate, fetchPage(3));
        yield* Store.waitFor(
          query.state,
          (result) => successValue(result)?.length === 4 && !result.waiting,
        );
        assert.deepStrictEqual(pageCalls, [3]);
      }).pipe(Effect.provide(Registry.layer)),
    );
  });

  describe("persist", () => {
    const schema = Schema.Array(Schema.String);

    it.effect("saves successes and seeds the next query while its load is in flight", () =>
      Effect.gen(function* () {
        const source = yield* Query.make(
          Effect.succeed<ReadonlyArray<string>>(["a", "b"]),
        ).pipe(Query.persist({ key: "users", schema }));
        yield* Store.waitFor(source.state, (result) => successValue(result)?.length === 2);
        yield* waitForSaved("users");

        const backend = gatedRequest<ReadonlyArray<string>>();
        const restored = yield* Query.make(backend.request).pipe(
          Query.persist({ key: "users", schema }),
        );

        // The stored copy shows immediately, marked waiting for the live load.
        yield* Store.waitFor(
          restored.state,
          (result) => successValue(result)?.join(",") === "a,b" && result.waiting,
        );

        // The live load settles and replaces the stored copy.
        yield* awaitCondition(() => backend.gates.length === 1);
        yield* Deferred.succeed(backend.gateAt(0), ["fresh"]);
        yield* Store.waitFor(
          restored.state,
          (result) => successValue(result)?.join(",") === "fresh" && !result.waiting,
        );
      }).pipe(Effect.provide(persistLayer)),
    );

    it.effect("a load that settles first wins over the stored copy", () =>
      Effect.gen(function* () {
        const kvs = yield* KeyValueStore.KeyValueStore;
        yield* kvs.set("users", JSON.stringify({ savedAt: 0, value: ["stale"] }));

        const query = yield* Query.make(
          Effect.succeed<ReadonlyArray<string>>(["fresh"]),
        ).pipe(Query.persist({ key: "users", schema }));

        yield* Store.waitFor(
          query.state,
          (result) => successValue(result) !== null && !result.waiting,
        );
        yield* settlePipelines;
        assert.deepStrictEqual(successValue(yield* Store.get(query.state)), ["fresh"]);
      }).pipe(Effect.provide(persistLayer)),
    );

    it.effect("ignores entries older than timeToLive", () =>
      Effect.gen(function* () {
        const kvs = yield* KeyValueStore.KeyValueStore;
        yield* kvs.set("users", JSON.stringify({ savedAt: 0, value: ["stale"] }));
        yield* TestClock.adjust("2 hours");

        const backend = gatedRequest<ReadonlyArray<string>>();
        const query = yield* Query.make(backend.request).pipe(
          Query.persist({ key: "users", schema, timeToLive: "1 hour" }),
        );

        yield* awaitCondition(() => backend.gates.length === 1);
        yield* settlePipelines;
        assert.isNull(successValue(yield* Store.get(query.state)));

        yield* Deferred.succeed(backend.gateAt(0), ["fresh"]);
        yield* Store.waitFor(query.state, (result) => successValue(result)?.join(",") === "fresh");
      }).pipe(Effect.provide(persistLayer)),
    );

    it.effect("an entry that fails to decode is a miss, not an error", () =>
      Effect.gen(function* () {
        const kvs = yield* KeyValueStore.KeyValueStore;
        yield* kvs.set("users", "{ not json");

        const backend = gatedRequest<ReadonlyArray<string>>();
        const query = yield* Query.make(backend.request).pipe(
          Query.persist({ key: "users", schema }),
        );

        yield* awaitCondition(() => backend.gates.length === 1);
        yield* settlePipelines;
        assert.isNull(successValue(yield* Store.get(query.state)));

        yield* Deferred.succeed(backend.gateAt(0), ["fresh"]);
        yield* Store.waitFor(query.state, (result) => successValue(result)?.join(",") === "fresh");
      }).pipe(Effect.provide(persistLayer)),
    );

    it.effect("failures are never persisted", () =>
      Effect.gen(function* () {
        const query = yield* Query.make(Effect.fail("boom" as const)).pipe(
          Query.persist({ key: "users", schema: Schema.Array(Schema.String) }),
        );

        yield* Store.waitFor(query.state, (result) => AsyncResult.isFailure(result));
        yield* settlePipelines;
        const kvs = yield* KeyValueStore.KeyValueStore;
        assert.isUndefined(yield* kvs.get("users"));
      }).pipe(Effect.provide(persistLayer)),
    );
  });
});

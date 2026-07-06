import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { Event, Model, Registry, Store } from "../src/core/index.js";

/** Construction/disposal ledgers — the whole point of this suite is observing
 * WHEN instances are built and released. */
let built: Array<string> = [];
let disposed: Array<string> = [];

/** Records construction and registers a disposal finalizer through the plain
 * ambient `Scope` — which IS the instance scope during `make`. */
const track = (label: string) =>
  Effect.gen(function* () {
    built.push(label);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        disposed.push(label);
      }),
    );
  });

/** Keyed, default lifetime: 10-minute idle TTL after the last release. */
class TtlModel extends Model.Service<TtlModel>()(
  "/test/ownership-test/TtlModel",
)<string>()({
  make: (key) =>
    Effect.gen(function* () {
      yield* track(`ttl:${key}`);
      const count = Store.make(0);

      return {
        inputs: {
          setCount: Event.setter(count),
        },
        outputs: {
          count,
        },
        ui: {
          count,
        },
      };
    }),
}) {}

/** Keyed with a shortened idle TTL via the `lifetime` option. */
class ShortTtlModel extends Model.Service<ShortTtlModel>()(
  "/test/ownership-test/ShortTtlModel",
)<string>()({
  lifetime: { idleTimeToLive: "1 minute" },
  make: (key) =>
    Effect.gen(function* () {
      yield* track(`short:${key}`);
      return { inputs: {}, outputs: {}, ui: {} };
    }),
}) {}

/** Keyed but pinned: `lifetime: "keepAlive"` overrides the keyed default. */
class PinnedModel extends Model.Service<PinnedModel>()(
  "/test/ownership-test/PinnedModel",
)<string>()({
  lifetime: "keepAlive",
  make: (key) =>
    Effect.gen(function* () {
      yield* track(`pinned:${key}`);
      return { inputs: {}, outputs: {}, ui: {} };
    }),
}) {}

/** Singleton, default lifetime: keepAlive. */
class SingletonModel extends Model.Service<SingletonModel>()(
  "/test/ownership-test/SingletonModel",
)({
  make: () =>
    Effect.gen(function* () {
      yield* track("singleton");
      return { inputs: {}, outputs: {}, ui: {} };
    }),
}) {}

/** Resolves one TTL'd child and one pinned child in `make`: the leases live
 * in the parent's instance scope and are released when the parent dies. */
class ParentModel extends Model.Service<ParentModel>()(
  "/test/ownership-test/ParentModel",
)<string>()({
  make: (key) =>
    Effect.gen(function* () {
      yield* track(`parent:${key}`);
      const child = yield* Model.get(TtlModel, "of-parent");
      yield* Model.get(PinnedModel, "of-parent");

      return {
        inputs: {},
        outputs: {
          count: child.outputs.count,
        },
        ui: {},
      };
    }),
}) {}

let ownedList: Model.List<typeof TtlModel> | undefined;

class ListHostModel extends Model.Service<ListHostModel>()(
  "/test/ownership-test/ListHostModel",
)({
  make: () =>
    Effect.gen(function* () {
      // Captured so tests can drive the list directly; real parents keep it
      // private and wire events to its operations.
      ownedList = yield* Model.list(TtlModel);
      return { inputs: {}, outputs: {}, ui: {} };
    }),
}) {}

/** Keyed list host: two instances give two INDEPENDENT lists over the same
 * child model — the cross-owner sharing scenarios. */
const sharedLists = new Map<string, Model.List<typeof TtlModel>>();

class SharedListHostModel extends Model.Service<SharedListHostModel>()(
  "/test/ownership-test/SharedListHostModel",
)<string>()({
  make: (key) =>
    Effect.gen(function* () {
      sharedLists.set(key, yield* Model.list(TtlModel));
      return { inputs: {}, outputs: {}, ui: {} };
    }),
}) {}

const TtlLayer = TtlModel.layer.pipe(Layer.provideMerge(Registry.layer));
const ShortTtlLayer = ShortTtlModel.layer.pipe(Layer.provideMerge(Registry.layer));
const PinnedLayer = PinnedModel.layer.pipe(Layer.provideMerge(Registry.layer));
const SingletonLayer = SingletonModel.layer.pipe(Layer.provideMerge(Registry.layer));
const ParentLayer = ParentModel.layer.pipe(
  Layer.provideMerge(TtlModel.layer),
  Layer.provideMerge(PinnedModel.layer),
  Layer.provideMerge(Registry.layer),
);
const ListHostLayer = ListHostModel.layer.pipe(
  Layer.provideMerge(TtlModel.layer),
  Layer.provideMerge(Registry.layer),
);
const SharedListHostLayer = SharedListHostModel.layer.pipe(
  Layer.provideMerge(TtlModel.layer),
  Layer.provideMerge(Registry.layer),
);

const captured = <A>(value: A | undefined): Effect.Effect<A> =>
  value === undefined
    ? Effect.die(new Error("Unitflow test list was not captured."))
    : Effect.succeed(value);

const reset = Effect.sync(() => {
  built = [];
  disposed = [];
});

describe("model ownership", () => {
  it.effect(
    "holders share one lease-counted instance; the LAST release starts the idle clock",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const first = yield* Scope.make();
        const second = yield* Scope.make();

        const a = yield* Scope.provide(Model.get(TtlModel, "a"), first);
        const b = yield* Scope.provide(Model.get(TtlModel, "a"), second);
        assert.deepStrictEqual(built, ["ttl:a"]);
        assert.strictEqual(a, b);

        // Releasing ONE holder keeps the instance — no idle clock runs at all.
        yield* Scope.close(first, Exit.void);
        yield* TestClock.adjust("30 minutes");
        assert.deepStrictEqual(disposed, []);

        // The last release starts the clock; within the TTL nothing happens...
        yield* Scope.close(second, Exit.void);
        yield* TestClock.adjust("9 minutes");
        assert.deepStrictEqual(disposed, []);

        // ...past the TTL the instance is disposed.
        yield* TestClock.adjust("2 minutes");
        assert.deepStrictEqual(disposed, ["ttl:a"]);

        // A later get constructs anew.
        yield* Model.get(TtlModel, "a");
        assert.deepStrictEqual(built, ["ttl:a", "ttl:a"]);
      }).pipe(Effect.provide(TtlLayer)),
  );

  it.effect("a re-get within the TTL reuses the instance — state survives", () =>
    Effect.gen(function* () {
      yield* reset;
      const holder = yield* Scope.make();

      const model = yield* Scope.provide(Model.get(TtlModel, "page"), holder);
      yield* Registry.allSettled(Event.emit(model.inputs.setCount, 5));

      // Released, idle — but within the 10-minute grace.
      yield* Scope.close(holder, Exit.void);
      yield* TestClock.adjust("5 minutes");
      assert.deepStrictEqual(disposed, []);

      const again = yield* Model.get(TtlModel, "page");
      assert.deepStrictEqual(built, ["ttl:page"]);
      assert.strictEqual(yield* Store.get(again.outputs.count), 5);
    }).pipe(Effect.provide(TtlLayer)),
  );

  it.effect("disposing a parent releases its children into their own lifetimes", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* Model.get(ParentModel, "p");
      assert.deepStrictEqual(built, ["parent:p", "ttl:of-parent", "pinned:of-parent"]);

      // The parent dies now; the children were leased in ITS instance scope,
      // so they are released — but not yet disposed.
      yield* Model.dispose(ParentModel, "p");
      assert.deepStrictEqual(disposed, ["parent:p"]);

      // The TTL'd child idles out; the keepAlive child survives.
      yield* TestClock.adjust("11 minutes");
      assert.deepStrictEqual(disposed, ["parent:p", "ttl:of-parent"]);

      yield* TestClock.adjust("2 hours");
      assert.deepStrictEqual(disposed, ["parent:p", "ttl:of-parent"]);
    }).pipe(Effect.provide(ParentLayer)),
  );

  it.effect("a singleton survives its only holder's scope closing", () =>
    Effect.gen(function* () {
      yield* reset;
      const holder = yield* Scope.make();
      yield* Scope.provide(Model.get(SingletonModel), holder);

      yield* Scope.close(holder, Exit.void);
      yield* TestClock.adjust("1 hour");
      assert.deepStrictEqual(disposed, []);

      yield* Model.get(SingletonModel);
      assert.deepStrictEqual(built, ["singleton"]);
    }).pipe(Effect.provide(SingletonLayer)),
  );

  it.effect("the lifetime option shortens the idle TTL", () =>
    Effect.gen(function* () {
      yield* reset;
      const holder = yield* Scope.make();
      yield* Scope.provide(Model.get(ShortTtlModel, "s"), holder);
      yield* Scope.close(holder, Exit.void);

      yield* TestClock.adjust("30 seconds");
      assert.deepStrictEqual(disposed, []);

      yield* TestClock.adjust("40 seconds");
      assert.deepStrictEqual(disposed, ["short:s"]);
    }).pipe(Effect.provide(ShortTtlLayer)),
  );

  it.effect("a keyed keepAlive model never idles out", () =>
    Effect.gen(function* () {
      yield* reset;
      const holder = yield* Scope.make();
      yield* Scope.provide(Model.get(PinnedModel, "k"), holder);
      yield* Scope.close(holder, Exit.void);

      yield* TestClock.adjust("2 hours");
      assert.deepStrictEqual(disposed, []);

      yield* Model.get(PinnedModel, "k");
      assert.deepStrictEqual(built, ["pinned:k"]);
    }).pipe(Effect.provide(PinnedLayer)),
  );

  it.effect("Model.list.remove disposes the child immediately despite its TTL", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* Model.get(ListHostModel);
      const list = yield* captured(ownedList);

      yield* list.push("x");
      assert.deepStrictEqual(built, ["ttl:x"]);

      yield* list.remove("x");
      assert.deepStrictEqual(disposed, ["ttl:x"]);
    }).pipe(Effect.provide(ListHostLayer)),
  );

  it.effect(
    "two lists sharing a child key share the instance; remove only releases ownership",
    () =>
      Effect.gen(function* () {
        yield* reset;
        sharedLists.clear();
        yield* Model.get(SharedListHostModel, "a");
        yield* Model.get(SharedListHostModel, "b");
        const listA = yield* captured(sharedLists.get("a"));
        const listB = yield* captured(sharedLists.get("b"));

        // Both lists push the SAME key: one construction, one shared instance.
        const fromA = yield* listA.push("shared");
        const fromB = yield* listB.push("shared");
        assert.deepStrictEqual(built, ["ttl:shared"]);
        assert.strictEqual(fromA, fromB);
        assert.strictEqual((yield* Store.get(listA.items)).length, 1);
        assert.strictEqual((yield* Store.get(listB.items)).length, 1);

        // A's remove releases only A's ownership: the child is NOT disposed,
        // and B's select still emits its live state.
        yield* listA.remove("shared");
        assert.deepStrictEqual(disposed, []);
        assert.deepStrictEqual(yield* Store.get(listA.items), []);
        yield* Registry.allSettled(Event.emit(fromB.inputs.setCount, 7));
        assert.deepStrictEqual(yield* Store.get(listB.select((item) => item.outputs.count)), [7]);

        // The LAST owner's remove disposes immediately — no TTL, no clock.
        yield* listB.remove("shared");
        assert.deepStrictEqual(disposed, ["ttl:shared"]);
      }).pipe(Effect.provide(SharedListHostLayer)),
  );

  it.effect("removing a child an outside holder leases releases ownership without disposing", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* Model.get(ListHostModel);
      const list = yield* captured(ownedList);

      // The test scope holds a bare lease on the same key the list pushes.
      const outside = yield* Model.get(TtlModel, "x");
      const pushed = yield* list.push("x");
      assert.strictEqual(pushed, outside);
      assert.deepStrictEqual(built, ["ttl:x"]);

      // remove alone must not kill the child: the outside holder keeps it
      // alive (once that holder releases, the normal rules — idle TTL —
      // apply; outside holders are not lists).
      yield* list.remove("x");
      assert.deepStrictEqual(disposed, []);
      yield* Registry.allSettled(Event.emit(outside.inputs.setCount, 3));
      assert.strictEqual(yield* Store.get(outside.outputs.count), 3);
    }).pipe(Effect.provide(ListHostLayer)),
  );

  it.effect("parent dispose disposes sole-owned children immediately but spares shared ones", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* Model.get(ListHostModel);
      const list = yield* captured(ownedList);

      const holder = yield* Scope.make();
      yield* Scope.provide(Model.get(TtlModel, "shared"), holder);
      yield* list.push("shared");
      yield* list.push("sole");
      assert.deepStrictEqual(built, ["ttl:shared", "ttl:sole"]);

      // Disposing the list's parent closes every child sub-scope: the
      // sole-owned child dies NOW (no clock advance), the shared one lives
      // on for its outside holder.
      yield* Model.dispose(ListHostModel);
      assert.deepStrictEqual(disposed, ["ttl:sole"]);

      // The outside holder's release then follows the normal rules: TTL.
      yield* Scope.close(holder, Exit.void);
      yield* TestClock.adjust("11 minutes");
      assert.deepStrictEqual(disposed, ["ttl:sole", "ttl:shared"]);
    }).pipe(Effect.provide(ListHostLayer)),
  );

  it.effect("Model.dispose kills the instance NOW, even with a lease outstanding", () =>
    Effect.gen(function* () {
      yield* reset;
      // The test's own scope holds the lease for the whole test.
      const model = yield* Model.get(TtlModel, "d");
      yield* Registry.allSettled(Event.emit(model.inputs.setCount, 3));

      yield* Model.dispose(TtlModel, "d");
      assert.deepStrictEqual(disposed, ["ttl:d"]);

      // A later get constructs a fresh instance with fresh state.
      const fresh = yield* Model.get(TtlModel, "d");
      assert.deepStrictEqual(built, ["ttl:d", "ttl:d"]);
      assert.strictEqual(yield* Store.get(fresh.outputs.count), 0);
    }).pipe(Effect.provide(TtlLayer)),
  );
});

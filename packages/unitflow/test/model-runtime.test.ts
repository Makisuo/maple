import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Event, Model, UnitflowRuntime, Registry, Store } from "../src/core/index.js";

class CounterModel extends Model.Service<CounterModel>()(
  "/test/runtime-test/CounterModel",
)({
  make: () =>
    Effect.gen(function* () {
      const countStore = Store.make(0);
      const incrementEvent = Event.make<number>();

      yield* Registry.run(
        Event.stream(incrementEvent).pipe(
          Stream.tap((amount) => Store.update(countStore, (count) => count + amount)),
        ),
      );

      return {
        inputs: {
          incrementEvent,
        },
        outputs: {
          countStore,
        },
        ui: {
          countStore,
          incrementEvent,
        },
      };
    }),
}) {}

class BrokenModel extends Model.Service<BrokenModel>()(
  "/test/runtime-test/BrokenModel",
)({
  make: () => Effect.fail("broken"),
}) {}

let leasedBuilt = 0;
let leasedDisposed = 0;

class LeasedModel extends Model.Service<LeasedModel>()(
  "/test/runtime-test/LeasedModel",
)<string>()({
  make: (key) =>
    Effect.gen(function* () {
      leasedBuilt += 1;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          leasedDisposed += 1;
        }),
      );
      const labelStore = Store.make(`leased:${key}`);

      return {
        inputs: {},
        outputs: {},
        ui: {
          labelStore,
        },
      };
    }),
}) {}

let ephemeralBuilt = 0;

/** Zero idle TTL: the instance dies as soon as its last lease releases —
 * the maximal window for the stale-snapshot hazard this suite pins. */
class EphemeralModel extends Model.Service<EphemeralModel>()(
  "/test/runtime-test/EphemeralModel",
)<string>()({
  lifetime: { idleTimeToLive: 0 },
  make: () =>
    Effect.sync(() => {
      ephemeralBuilt += 1;
      const labelStore = Store.make(`build:${ephemeralBuilt}`);
      return { inputs: {}, outputs: {}, ui: { labelStore } };
    }),
}) {}

/** Polls a synchronous runtime-side predicate on real time — the model
 * runtime runs on its own live clock, so the test's TestClock cannot drive
 * it and push-based waits would take a lease and keep the instance alive. */
const eventually = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const check = (): void => {
      if (predicate()) {
        resume(Effect.void);
        return;
      }
      setTimeout(check, 1);
    };
    check();
  });

const awaitSettled = <M extends Model.AnyService>(
  runtime: UnitflowRuntime.UnitflowRuntime<any, any>,
  model: M,
  key: Model.KeyOf<M>,
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const settled = () => runtime.getModel(model, key)._tag !== "Building";
    const unsubscribe = runtime.subscribeModel(model, key, () => {
      if (settled()) {
        unsubscribe();
        resume(Effect.void);
      }
    });
    if (settled()) {
      unsubscribe();
      resume(Effect.void);
    }
  });

const awaitStoreValue = <A>(
  runtime: UnitflowRuntime.UnitflowRuntime<any, any>,
  store: Store.Source<A>,
  expected: A,
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const unsubscribe = runtime.subscribeStore(store, () => {
      if (runtime.getStore(store) === expected) {
        unsubscribe();
        resume(Effect.void);
      }
    });
    if (runtime.getStore(store) === expected) {
      unsubscribe();
      resume(Effect.void);
    }
  });

describe("Unitflow runtime binding", () => {
  it.effect("resolves models and streams store updates into subscriptions", () =>
    Effect.gen(function* () {
      const runtime = UnitflowRuntime.make(CounterModel.layer);

      yield* awaitSettled(runtime, CounterModel, undefined);
      const result = runtime.getModel(CounterModel, undefined);
      assert.strictEqual(result._tag, "Ready");
      if (result._tag !== "Ready") return;

      const countStore = result.model.ui.countStore;
      assert.strictEqual(runtime.getStore(countStore), 0);

      const sawThree = awaitStoreValue(runtime, countStore, 3);
      runtime.emit(result.model.ui.incrementEvent, 3);
      yield* sawThree;

      assert.strictEqual(runtime.getStore(countStore), 3);
      yield* runtime.runtime.disposeEffect;
    }),
  );

  it.effect("returns the same snapshot reference until the store changes", () =>
    Effect.gen(function* () {
      const runtime = UnitflowRuntime.make(CounterModel.layer);

      yield* awaitSettled(runtime, CounterModel, undefined);
      const first = runtime.getModel(CounterModel, undefined);
      const second = runtime.getModel(CounterModel, undefined);
      assert.strictEqual(first, second);

      yield* runtime.runtime.disposeEffect;
    }),
  );

  it.effect("reports failed model construction", () =>
    Effect.gen(function* () {
      const runtime = UnitflowRuntime.make(BrokenModel.layer);

      yield* awaitSettled(runtime, BrokenModel, undefined);
      assert.strictEqual(runtime.getModel(BrokenModel, undefined)._tag, "Failed");

      yield* runtime.runtime.disposeEffect;
    }),
  );

  it.effect("a subscription leases the instance; remount within the TTL reuses it", () =>
    Effect.gen(function* () {
      leasedBuilt = 0;
      leasedDisposed = 0;
      const runtime = UnitflowRuntime.make(LeasedModel.layer);
      const listener = () => undefined;

      // Mount: the subscription opens a binding scope and leases the instance.
      const unmount = runtime.subscribeModel(LeasedModel, "a", listener);
      yield* awaitSettled(runtime, LeasedModel, "a");
      const first = runtime.getModel(LeasedModel, "a");
      assert.strictEqual(first._tag, "Ready");
      assert.strictEqual(leasedBuilt, 1);

      // Unmount releases the lease — the idle TTL keeps the instance alive.
      unmount();
      assert.strictEqual(leasedDisposed, 0);

      // A quick remount reuses the same instance and the same snapshot.
      const remount = runtime.subscribeModel(LeasedModel, "a", listener);
      yield* awaitSettled(runtime, LeasedModel, "a");
      assert.strictEqual(runtime.getModel(LeasedModel, "a"), first);
      assert.strictEqual(leasedBuilt, 1);
      remount();

      // Disposing the runtime closes the registry and the instance with it.
      yield* runtime.runtime.disposeEffect;
      assert.strictEqual(leasedDisposed, 1);
    }),
  );

  it.effect("a remount after the instance died never renders stale disposed ports", () =>
    Effect.gen(function* () {
      ephemeralBuilt = 0;
      const runtime = UnitflowRuntime.make(EphemeralModel.layer);
      const listener = () => undefined;

      const unmount = runtime.subscribeModel(EphemeralModel, "a", listener);
      yield* eventually(() => runtime.getModel(EphemeralModel, "a")._tag === "Ready");
      const first = runtime.getModel(EphemeralModel, "a");
      assert.strictEqual(first._tag, "Ready");
      if (first._tag !== "Ready") return;
      assert.strictEqual(runtime.getStore(first.model.ui.labelStore), "build:1");

      // Unmount: zero TTL disposes at once — the death watch must reset the
      // cached snapshot, so nothing can ever read the disposed ports again.
      unmount();
      yield* eventually(() => runtime.getModel(EphemeralModel, "a")._tag === "Building");

      // Remount: the first snapshot a view can read is Building, never the
      // stale Ready — and the fresh construction yields NEW ports.
      const remount = runtime.subscribeModel(EphemeralModel, "a", listener);
      assert.notStrictEqual(runtime.getModel(EphemeralModel, "a"), first);
      yield* eventually(() => runtime.getModel(EphemeralModel, "a")._tag === "Ready");
      const second = runtime.getModel(EphemeralModel, "a");
      assert.strictEqual(second._tag, "Ready");
      if (second._tag !== "Ready") return;
      assert.notStrictEqual(second.model, first.model);
      assert.strictEqual(runtime.getStore(second.model.ui.labelStore), "build:2");
      remount();

      yield* runtime.runtime.disposeEffect;
    }),
  );
});

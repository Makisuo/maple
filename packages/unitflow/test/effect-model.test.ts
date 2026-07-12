import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Event, InstanceScope, Model, Registry, Store } from "../src/core/index.js";

class CounterModel extends Model.Service<CounterModel>()(
  "/test/test/CounterModel",
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
        },
      };
    }),
}) {}

class AuditedCounterModel extends Model.Service<AuditedCounterModel>()(
  "/test/test/AuditedCounterModel",
)({
  make: () =>
    Effect.gen(function* () {
      const countStore = Store.make(0);
      const incrementEvent = Event.make<number>();
      const incrementRecorded = Event.make<number>();
      const totalStore = Store.make(0);

      yield* Registry.run(
        Event.stream(incrementEvent).pipe(
          Stream.tap((amount) => Store.update(countStore, (count) => count + amount)),
          Stream.tap((amount) => Store.update(totalStore, (total) => total + amount)),
          Stream.tap((amount) => Event.emit(incrementRecorded, amount)),
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
        },
        // An EXTRA section: a read-only observation surface for other models.
        analytics: {
          incrementRecorded,
          totalStore,
        },
      };
    }),
}) {}

interface RenderKey {
  readonly id: string;
}

class RenderModel extends Model.Service<RenderModel>()(
  "/test/test/RenderModel",
)<RenderKey>()({
  make: (key) =>
    Effect.gen(function* () {
      const labelStore = Store.make(`render:${key.id}`);
      const renameEvent = Event.make<string>();

      yield* Registry.run(
        Event.stream(renameEvent).pipe(Stream.tap((label) => Store.set(labelStore, label))),
      );

      return {
        inputs: {
          renameEvent,
        },
        outputs: {
          labelStore,
        },
        ui: {
          labelStore,
        },
      };
    }),
}) {}

class Prefix extends Context.Service<Prefix, { readonly value: string }>()(
  "/test/test/Prefix",
) {}

class PrefixedModel extends Model.Service<PrefixedModel>()(
  "/test/test/PrefixedModel",
)({
  make: () =>
    Effect.gen(function* () {
      const prefix = yield* Prefix;
      const labelStore = Store.make(prefix.value);

      return {
        inputs: {},
        outputs: {
          labelStore,
        },
        ui: {
          labelStore,
        },
      };
    }),
}) {}

class CounterPanelModel extends Model.Service<CounterPanelModel>()(
  "/test/test/CounterPanelModel",
)({
  make: () =>
    Effect.gen(function* () {
      const counterModel = yield* Model.get(CounterModel);

      return {
        inputs: {},
        outputs: {
          countStore: counterModel.outputs.countStore,
        },
        ui: {
          counterModel,
        },
      };
    }),
}) {}

let slowMakeCount = 0;

class SlowModel extends Model.Service<SlowModel>()("/test/test/SlowModel")({
  make: () =>
    Effect.gen(function* () {
      slowMakeCount += 1;
      yield* Effect.yieldNow;
      const labelStore = Store.make("slow");

      return {
        inputs: {},
        outputs: {},
        ui: {
          labelStore,
        },
      };
    }),
}) {}

let flakyFailuresLeft = 0;

class FlakyModel extends Model.Service<FlakyModel>()("/test/test/FlakyModel")({
  make: () =>
    Effect.gen(function* () {
      if (flakyFailuresLeft > 0) {
        flakyFailuresLeft -= 1;
        return yield* Effect.fail("construction failed");
      }
      const labelStore = Store.make("ok");

      return {
        inputs: {},
        outputs: {},
        ui: {
          labelStore,
        },
      };
    }),
}) {}

class TwoPipelinesModel extends Model.Service<TwoPipelinesModel>()(
  "/test/test/TwoPipelinesModel",
)({
  make: () =>
    Effect.gen(function* () {
      const countStore = Store.make(0);
      const incrementEvent = Event.make<number>();
      const explodeEvent = Event.make();

      yield* Registry.run(
        Event.stream(explodeEvent).pipe(Stream.mapEffect(() => Effect.die("pipeline bug"))),
      );
      yield* Registry.run(
        Event.stream(incrementEvent).pipe(
          Stream.tap((amount) => Store.update(countStore, (count) => count + amount)),
        ),
      );

      return {
        inputs: {
          incrementEvent,
          explodeEvent,
        },
        outputs: {
          countStore,
        },
        ui: {
          countStore,
        },
      };
    }),
}) {}

class SnapshotModel extends Model.Service<SnapshotModel>()(
  "/test/test/SnapshotModel",
)({
  make: () =>
    Effect.gen(function* () {
      const countStore = Store.make(0);
      const snapshotStore = Store.make(-1);
      const setCountEvent = Event.make<number>();
      const snapshotEvent = Event.make();

      yield* Registry.run(
        Event.stream(setCountEvent).pipe(Stream.tap((count) => Store.set(countStore, count))),
      );
      // The handler reads one store and writes another — the read-modify-write
      // orchestration pattern.
      yield* Registry.run(
        Event.stream(snapshotEvent).pipe(
          Stream.mapEffect(() =>
            Store.get(countStore).pipe(Effect.flatMap((count) => Store.set(snapshotStore, count))),
          ),
        ),
      );

      return {
        inputs: {
          setCountEvent,
          snapshotEvent,
        },
        outputs: {},
        ui: {
          countStore,
          snapshotStore,
        },
      };
    }),
}) {}

class FormModel extends Model.Service<FormModel>()("/test/test/FormModel")({
  make: () =>
    Effect.sync(() => {
      const nameStore = Store.make("");

      return {
        inputs: {},
        outputs: {},
        ui: {
          nameStore,
          onNameChange: Event.setter(nameStore),
        },
      };
    }),
}) {}

class CombinedOnlyModel extends Model.Service<CombinedOnlyModel>()(
  "/test/test/CombinedOnlyModel",
)({
  make: () =>
    Effect.sync(() => {
      const countStore = Store.make(0);
      // The private source is never touched in `make` — materialization of the
      // exposed combined port must claim it for the instance scope.
      const doubledStore = Store.combine([countStore], (count) => count * 2);

      return {
        inputs: {},
        outputs: {},
        ui: {
          doubledStore,
        },
      };
    }),
}) {}

interface ItemKey {
  readonly id: string;
}

let disposedItems: Array<string> = [];

class ItemModel extends Model.Service<ItemModel>()(
  "/test/test/ItemModel",
)<ItemKey>()({
  make: (key) =>
    Effect.gen(function* () {
      const scope = yield* InstanceScope;
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          disposedItems.push(key.id);
        }),
      );
      const count = Store.make(0);
      const label = Store.make(`item:${key.id}`);

      return {
        inputs: {
          setCount: Event.setter(count),
        },
        outputs: {
          count,
          label,
        },
        ui: {
          count,
        },
      };
    }),
}) {}

let itemFailuresLeft = 0;

class FlakyItemModel extends Model.Service<FlakyItemModel>()(
  "/test/test/FlakyItemModel",
)<ItemKey>()({
  make: () =>
    Effect.gen(function* () {
      if (itemFailuresLeft > 0) {
        itemFailuresLeft -= 1;
        return yield* Effect.fail("item construction failed");
      }
      const count = Store.make(0);

      return {
        inputs: {},
        outputs: {
          count,
        },
        ui: {},
      };
    }),
}) {}

let itemList: Model.List<typeof ItemModel> | undefined;

class ItemListModel extends Model.Service<ItemListModel>()(
  "/test/test/ItemListModel",
)({
  make: () =>
    Effect.gen(function* () {
      // Captured so tests can drive the list directly; real parents keep it
      // private and wire events to its operations.
      itemList = yield* Model.list(ItemModel);

      return { inputs: {}, outputs: {}, ui: {} };
    }),
}) {}

let flakyList: Model.List<typeof FlakyItemModel> | undefined;

class FlakyListModel extends Model.Service<FlakyListModel>()(
  "/test/test/FlakyListModel",
)({
  make: () =>
    Effect.gen(function* () {
      flakyList = yield* Model.list(FlakyItemModel);

      return { inputs: {}, outputs: {}, ui: {} };
    }),
}) {}

let totalsList: Model.List<typeof ItemModel> | undefined;

class TotalsModel extends Model.Service<TotalsModel>()(
  "/test/test/TotalsModel",
)({
  make: () =>
    Effect.gen(function* () {
      const items = yield* Model.list(ItemModel);
      totalsList = items;
      const total = Store.make(-1);

      yield* Registry.run(
        Store.stream(items.select((item) => item.outputs.count)).pipe(
          Stream.mapEffect((counts) =>
            Store.set(
              total,
              counts.reduce((sum, value) => sum + value, 0),
            ),
          ),
        ),
      );

      return {
        inputs: {},
        outputs: {
          total,
        },
        ui: {},
      };
    }),
}) {}

const captured = <A>(value: A | undefined): Effect.Effect<A> =>
  value === undefined
    ? Effect.die(new Error("Unitflow test list was not captured."))
    : Effect.succeed(value);

const CounterLayer = CounterModel.layer.pipe(Layer.provideMerge(Registry.layer));
const CounterPanelLayer = CounterPanelModel.layer.pipe(
  Layer.provideMerge(CounterModel.layer),
  Layer.provideMerge(Registry.layer),
);
const RenderLayer = RenderModel.layer.pipe(Layer.provideMerge(Registry.layer));
const fakeLabelStore = Store.make("fake");

class HeadlessModel extends Model.Service<HeadlessModel>()(
  "/test/effect-model/HeadlessModel",
)({
  make: () =>
    Effect.gen(function* () {
      const total = Store.make(0);
      const add = yield* Event.make<number>().pipe(
        Event.handler((amount) => Store.update(total, (value) => value + amount)),
      );

      // Headless: другие модели резолвят её как сервис, View-поверхности нет.
      return {
        inputs: { add },
        outputs: { total },
      };
    }),
}) {}

describe("Unitflow", () => {
  it.effect("a headless model (no ui section) constructs and serves ports", () =>
    Effect.gen(function* () {
      const headless = yield* Model.get(HeadlessModel);

      yield* Registry.allSettled(Event.emit(headless.inputs.add, 5));
      assert.strictEqual(yield* Store.get(headless.outputs.total), 5);
    }).pipe(Effect.provide(HeadlessModel.layer.pipe(Layer.provideMerge(Registry.layer)))),
  );

  it.effect("runs model streams inside the registry scope", () =>
    Effect.gen(function* () {
      const counter = yield* Model.get(CounterModel);
      const valuesFiber = yield* Store.stream(counter.ui.countStore).pipe(
        Stream.filter((count) => count === 3),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Event.emit(counter.inputs.incrementEvent, 3);

      const values = yield* Fiber.join(valuesFiber);
      assert.deepStrictEqual(values, [3]);
    }).pipe(Effect.provide(CounterLayer)),
  );

  it.effect("does not replay events emitted before a subscriber attaches", () =>
    Effect.gen(function* () {
      const numberEvent = Event.make<number>();

      yield* Event.emit(numberEvent, 1);

      const valuesFiber = yield* Event.stream(numberEvent).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Event.emit(numberEvent, 2);

      const values = yield* Fiber.join(valuesFiber);
      assert.deepStrictEqual(values, [2]);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("isolates store state by registry layer", () =>
    Effect.gen(function* () {
      const first = yield* Effect.gen(function* () {
        const counter = yield* Model.get(CounterModel);
        const valuesFiber = yield* Store.stream(counter.ui.countStore).pipe(
          Stream.filter((count) => count === 2),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* Event.emit(counter.inputs.incrementEvent, 2);
        return yield* Fiber.join(valuesFiber);
      }).pipe(Effect.provide(CounterLayer));

      const second = yield* Effect.gen(function* () {
        const counter = yield* Model.get(CounterModel);
        return yield* Store.get(counter.ui.countStore);
      }).pipe(Effect.provide(CounterLayer));

      assert.deepStrictEqual(first, [2]);
      assert.strictEqual(second, 0);
    }),
  );

  it.effect("keeps keyed model instances independent", () =>
    Effect.gen(function* () {
      const first = yield* Model.get(RenderModel, { id: "first" });
      const second = yield* Model.get(RenderModel, { id: "second" });
      const firstLabelFiber = yield* Store.stream(first.ui.labelStore).pipe(
        Stream.filter((label) => label === "renamed:first"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Event.emit(first.inputs.renameEvent, "renamed:first");

      const firstLabel = yield* Fiber.join(firstLabelFiber);
      const secondLabel = yield* Store.get(second.ui.labelStore);

      assert.deepStrictEqual(firstLabel, ["renamed:first"]);
      assert.strictEqual(secondLabel, "render:second");
    }).pipe(Effect.provide(RenderLayer)),
  );

  it.effect("wires model dependencies through Effect services", () =>
    Effect.gen(function* () {
      const panel = yield* Model.get(CounterPanelModel);
      const countFiber = yield* Store.stream(panel.outputs.countStore).pipe(
        Stream.filter((count) => count === 4),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Event.emit(panel.ui.counterModel.inputs.incrementEvent, 4);
      const count = yield* Fiber.join(countFiber);

      assert.deepStrictEqual(count, [4]);
    }).pipe(Effect.provide(CounterPanelLayer)),
  );

  it.effect("uses Effect services as dependencies", () =>
    Effect.gen(function* () {
      const model = yield* Model.get(PrefixedModel);
      const label = yield* Store.get(model.ui.labelStore);
      assert.strictEqual(label, "from-service");
    }).pipe(
      Effect.provide(
        PrefixedModel.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Registry.layer,
              Layer.succeed(Prefix, Prefix.of({ value: "from-service" })),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("dispose stops pipelines and clears registry state", () =>
    Effect.gen(function* () {
      const registry = yield* Registry;
      const counter = yield* Model.get(CounterModel);

      yield* Model.dispose(CounterModel);

      assert.strictEqual([...(yield* RcMap.keys(registry.instances))].length, 0);
      assert.strictEqual(registry.stores.size, 0);
      assert.strictEqual(registry.events.size, 0);

      // The old instance's pipeline is gone: emitting on its event no longer
      // reaches its store.
      yield* Event.emit(counter.inputs.incrementEvent, 5);
      const stale = yield* Store.get(counter.ui.countStore);
      assert.strictEqual(stale, 0);

      // A later get constructs a fresh, working instance.
      const fresh = yield* Model.get(CounterModel);
      const valuesFiber = yield* Store.stream(fresh.ui.countStore).pipe(
        Stream.filter((count) => count === 2),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Event.emit(fresh.inputs.incrementEvent, 2);
      assert.deepStrictEqual(yield* Fiber.join(valuesFiber), [2]);
    }).pipe(Effect.provide(CounterLayer)),
  );

  it.effect("concurrent gets construct a single shared instance", () =>
    Effect.gen(function* () {
      slowMakeCount = 0;
      const [first, second] = yield* Effect.all([Model.get(SlowModel), Model.get(SlowModel)], {
        concurrency: "unbounded",
      });

      assert.strictEqual(slowMakeCount, 1);
      assert.strictEqual(first.ui.labelStore, second.ui.labelStore);
    }).pipe(Effect.provide(SlowModel.layer.pipe(Layer.provideMerge(Registry.layer)))),
  );

  it.effect("does not cache failed constructions", () =>
    Effect.gen(function* () {
      flakyFailuresLeft = 1;
      const registry = yield* Registry;

      const first = yield* Effect.exit(Model.get(FlakyModel));
      assert.isTrue(Exit.isFailure(first));
      assert.strictEqual([...(yield* RcMap.keys(registry.instances))].length, 0);

      const second = yield* Model.get(FlakyModel);
      assert.strictEqual(yield* Store.get(second.ui.labelStore), "ok");
    }).pipe(Effect.provide(FlakyModel.layer.pipe(Layer.provideMerge(Registry.layer)))),
  );

  it.effect("a dying pipeline does not take down the model's other pipelines", () =>
    Effect.gen(function* () {
      const model = yield* Model.get(TwoPipelinesModel);
      const valuesFiber = yield* Store.stream(model.ui.countStore).pipe(
        Stream.filter((count) => count === 7),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Event.emit(model.inputs.explodeEvent);
      yield* Event.emit(model.inputs.incrementEvent, 7);

      assert.deepStrictEqual(yield* Fiber.join(valuesFiber), [7]);
    }).pipe(Effect.provide(TwoPipelinesModel.layer.pipe(Layer.provideMerge(Registry.layer)))),
  );

  it("requires pipelines to handle their errors (type-level)", () => {
    const failing = Stream.fail(new Error("unhandled"));
    // @ts-expect-error Registry.run only accepts streams whose error channel is never
    const pipeline = Registry.run(failing);
    assert.isDefined(pipeline);
  });

  it.effect("pipelines read stores while handling events", () =>
    Effect.gen(function* () {
      const model = yield* Model.get(SnapshotModel);

      const countFiber = yield* Store.stream(model.ui.countStore).pipe(
        Stream.filter((count) => count === 5),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Event.emit(model.inputs.setCountEvent, 5);
      yield* Fiber.join(countFiber);

      const snapshotFiber = yield* Store.stream(model.ui.snapshotStore).pipe(
        Stream.filter((snapshot) => snapshot === 5),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Event.emit(model.inputs.snapshotEvent);

      assert.deepStrictEqual(yield* Fiber.join(snapshotFiber), [5]);
    }).pipe(Effect.provide(SnapshotModel.layer.pipe(Layer.provideMerge(Registry.layer)))),
  );

  it.effect("computes combined stores from their sources", () =>
    Effect.gen(function* () {
      const countStore = Store.make(1);
      const factorStore = Store.make(10);
      const productStore = Store.combine(
        [countStore, factorStore],
        (count, factor) => count * factor,
      );
      const labelStore = Store.combine([productStore], (product) => `total: ${product}`);

      assert.strictEqual(yield* Store.get(productStore), 10);
      assert.strictEqual(yield* Store.get(labelStore), "total: 10");

      yield* Store.set(countStore, 3);
      assert.strictEqual(yield* Store.get(productStore), 30);
      assert.strictEqual(yield* Store.get(labelStore), "total: 30");
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("streams combined stores and suppresses equal recomputations", () =>
    Effect.gen(function* () {
      const countStore = Store.make(0);
      const parityStore = Store.combine([countStore], (count) => count % 2 === 0);

      const seen: Array<boolean> = [];
      const sawFirst = yield* Deferred.make<void>();
      const sawSecond = yield* Deferred.make<void>();
      yield* Store.stream(parityStore).pipe(
        Stream.runForEach((value) =>
          Effect.suspend(() => {
            seen.push(value);
            if (seen.length === 1) return Deferred.succeed(sawFirst, undefined);
            if (seen.length === 2) return Deferred.succeed(sawSecond, undefined);
            return Effect.void;
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );

      // The combined stream subscribes asynchronously — mutate only after the
      // initial value came through.
      yield* Deferred.await(sawFirst);
      // 0 -> 2 keeps parity `true`: without dedup this would re-emit `true`.
      yield* Store.set(countStore, 2);
      yield* Store.set(countStore, 3);
      yield* Deferred.await(sawSecond);

      assert.deepStrictEqual(seen, [true, false]);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("Store.map projects a source through a pipe", () =>
    Effect.gen(function* () {
      const countStore = Store.make(2);
      const decupledStore = countStore.pipe(Store.map((count) => count * 10));

      assert.strictEqual(yield* Store.get(decupledStore), 20);

      yield* Store.set(countStore, 3);
      assert.strictEqual(yield* Store.get(decupledStore), 30);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("Store.map streams dedup equal projections", () =>
    Effect.gen(function* () {
      const countStore = Store.make(0);
      const parityStore = countStore.pipe(Store.map((count) => count % 2 === 0));

      const seen: Array<boolean> = [];
      const sawFirst = yield* Deferred.make<void>();
      const sawSecond = yield* Deferred.make<void>();
      yield* Store.stream(parityStore).pipe(
        Stream.runForEach((value) =>
          Effect.suspend(() => {
            seen.push(value);
            if (seen.length === 1) return Deferred.succeed(sawFirst, undefined);
            if (seen.length === 2) return Deferred.succeed(sawSecond, undefined);
            return Effect.void;
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Deferred.await(sawFirst);
      // 0 -> 2 keeps parity `true`: without dedup this would re-emit `true`.
      yield* Store.set(countStore, 2);
      yield* Store.set(countStore, 3);
      yield* Deferred.await(sawSecond);

      assert.deepStrictEqual(seen, [true, false]);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("Store.map composes in a pipe chain after combine", () =>
    Effect.gen(function* () {
      const countStore = Store.make(2);
      const factorStore = Store.make(10);
      const labelStore = Store.combine(
        [countStore, factorStore],
        (count, factor) => count * factor,
      ).pipe(
        Store.map((product) => `total: ${product}`),
        Store.map((label) => label.toUpperCase()),
      );

      assert.strictEqual(yield* Store.get(labelStore), "TOTAL: 20");

      yield* Store.set(factorStore, 100);
      assert.strictEqual(yield* Store.get(labelStore), "TOTAL: 200");
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("dispose releases private sources exposed only through a combined store", () =>
    Effect.gen(function* () {
      const registry = yield* Registry;
      yield* Model.get(CombinedOnlyModel);
      assert.isAbove(registry.stores.size, 0);

      yield* Model.dispose(CombinedOnlyModel);

      assert.strictEqual(registry.stores.size, 0);
      assert.strictEqual([...(yield* RcMap.keys(registry.instances))].length, 0);
    }).pipe(Effect.provide(CombinedOnlyModel.layer.pipe(Layer.provideMerge(Registry.layer)))),
  );

  it.effect("merges combined events from all sources", () =>
    Effect.gen(function* () {
      const savedEvent = Event.make<string>();
      const failedEvent = Event.make<string>();
      const settledEvent = Event.combine([savedEvent, failedEvent]);

      // The merged stream subscribes every source before the first value
      // flows, so emits fired right after the fork cannot be missed.
      const valuesFiber = yield* Event.stream(settledEvent).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Event.emit(savedEvent, "saved");
      yield* Event.emit(failedEvent, "failed");

      const values = yield* Fiber.join(valuesFiber);
      assert.deepStrictEqual([...values].sort(), ["failed", "saved"]);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it("narrows ports to capabilities (type-level)", () => {
    const check = (ports: Model.PortsOf<typeof CounterModel>) => {
      // @ts-expect-error outputs are read-only sources — `set` needs a Sink
      const invalidSet = Store.set(ports.outputs.countStore, 1);
      // @ts-expect-error inputs are write-only sinks — `stream` needs a Source
      const invalidStream = Event.stream(ports.inputs.incrementEvent);
      // @ts-expect-error ui state is read-only — `set` needs a Sink
      const invalidUiSet = Store.set(ports.ui.countStore, 1);
      const validRead = Store.get(ports.outputs.countStore);
      const validEmit = Event.emit(ports.inputs.incrementEvent, 1);
      const combinedStore = Store.combine([ports.outputs.countStore], (count) => count * 2);
      // @ts-expect-error combined stores are read-only sources — `set` needs a Sink
      const invalidCombinedSet = Store.set(combinedStore, 1);
      const combinedEvent = Event.combine([Event.make<number>()]);
      // @ts-expect-error combined events are read-only sources — `emit` needs a Sink
      const invalidCombinedEmit = Event.emit(combinedEvent, 1);
      return {
        invalidSet,
        invalidStream,
        invalidUiSet,
        validRead,
        validEmit,
        invalidCombinedSet,
        invalidCombinedEmit,
      };
    };
    assert.isFunction(check);
  });

  it.effect("emits void events without an explicit payload", () =>
    Effect.gen(function* () {
      const trigger = Event.make();
      const valueFiber = yield* Event.waitFor(trigger).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Event.emit(trigger);

      assert.strictEqual(yield* Fiber.join(valueFiber), undefined);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it("allows omitting the payload only for void events (type-level)", () => {
    const voidEvent = Event.make();
    const numberEvent = Event.make<number>();

    const validVoidEmit = Event.emit(voidEvent);
    const validExplicitVoidEmit = Event.emit(voidEvent, undefined);
    const validNumberEmit = Event.emit(numberEvent, 1);
    // @ts-expect-error non-void events still require a payload
    const invalidMissingNumber = Event.emit(numberEvent);
    // @ts-expect-error void events do not accept non-undefined payloads
    const invalidVoidPayload = Event.emit(voidEvent, 1);

    return {
      validVoidEmit,
      validExplicitVoidEmit,
      validNumberEmit,
      invalidMissingNumber,
      invalidVoidPayload,
    };
  });

  it.effect("resets a store to its initial value", () =>
    Effect.gen(function* () {
      const countStore = Store.make(7);

      yield* Store.set(countStore, 42);
      assert.strictEqual(yield* Store.get(countStore), 42);

      yield* Store.reset(countStore);
      assert.strictEqual(yield* Store.get(countStore), 7);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("setter events write into their store and stream its changes", () =>
    Effect.gen(function* () {
      const registry = yield* Registry;
      const form = yield* Model.get(FormModel);

      const valuesFiber = yield* Store.stream(form.ui.nameStore).pipe(
        Stream.filter((name) => name === "Ada"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      // The ui port is an Event.Sink — the View fires it like any event.
      yield* Event.emit(form.ui.onNameChange, "Ada");

      assert.strictEqual(yield* Store.get(form.ui.nameStore), "Ada");
      assert.deepStrictEqual(yield* Fiber.join(valuesFiber), ["Ada"]);

      // The setter's backing store belongs to the instance.
      yield* Model.dispose(FormModel);
      assert.strictEqual(registry.stores.size, 0);
    }).pipe(Effect.provide(FormModel.layer.pipe(Layer.provideMerge(Registry.layer)))),
  );

  it("constrains shape sections to their capabilities (type-level)", () => {
    const store = Store.make(0);
    const event = Event.make<number>();
    const combinedStore = Store.combine([store], (count) => count * 2);
    const storeSink: Store.Sink<number> = store;

    const valid: Model.Shape = {
      inputs: { event, store },
      outputs: { store, combinedStore },
      ui: { store, event, combinedStore },
    };

    // @ts-expect-error inputs accept only sink-capable ports — a combined store is read-only
    const sourceAsInput: Model.Shape = { inputs: { combinedStore }, outputs: {}, ui: {} };
    // @ts-expect-error outputs accept only source-capable ports — a bare sink cannot be read
    const sinkAsOutput: Model.Shape = { inputs: {}, outputs: { storeSink }, ui: {} };
    // @ts-expect-error ui accepts only source-capable ports or nested units
    const sinkAsUi: Model.Shape = { inputs: {}, outputs: {}, ui: { storeSink } };
    // @ts-expect-error plain data is not a port
    const dataAsOutput: Model.Shape = { inputs: {}, outputs: { count: 1 }, ui: {} };

    assert.isDefined(valid);
    assert.isDefined(sourceAsInput);
    assert.isDefined(sinkAsOutput);
    assert.isDefined(sinkAsUi);
    assert.isDefined(dataAsOutput);
  });

  it.effect("exposes extra sections to resolvers as observation surfaces", () =>
    Effect.gen(function* () {
      const registry = yield* Registry;
      const counter = yield* Model.get(AuditedCounterModel);

      const recordedFiber = yield* Event.stream(counter.analytics.incrementRecorded).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Registry.allSettled(
        Event.emit(counter.inputs.incrementEvent, 2),
        Event.emit(counter.inputs.incrementEvent, 3),
      );

      assert.deepStrictEqual(yield* Fiber.join(recordedFiber), [2, 3]);
      assert.strictEqual(yield* Store.get(counter.analytics.totalStore), 5);

      // Extra-section ports belong to the instance like any other section's.
      yield* Model.dispose(AuditedCounterModel);
      assert.strictEqual(registry.stores.size, 0);
    }).pipe(Effect.provide(AuditedCounterModel.layer.pipe(Layer.provideMerge(Registry.layer)))),
  );

  it("narrows extra sections to read-only sources (type-level)", () => {
    const check = (ports: Model.PortsOf<typeof AuditedCounterModel>) => {
      const validStream = Event.stream(ports.analytics.incrementRecorded);
      const validGet = Store.get(ports.analytics.totalStore);
      // @ts-expect-error extra sections are read-only sources — `emit` needs a Sink
      const invalidEmit = Event.emit(ports.analytics.incrementRecorded, 1);
      // @ts-expect-error extra sections are read-only sources — `set` needs a Sink
      const invalidSet = Store.set(ports.analytics.totalStore, 1);
      // @ts-expect-error extra sections are read-only sources — `update` needs the full Store
      const invalidUpdate = Store.update(ports.analytics.totalStore, (total) => total + 1);
      return { validStream, validGet, invalidEmit, invalidSet, invalidUpdate };
    };
    assert.isFunction(check);
  });

  it("constrains extra sections to source-capable ports (type-level)", () => {
    const store = Store.make(0);
    const storeSink: Store.Sink<number> = store;

    class SinkExtraModel extends Model.Service<SinkExtraModel>()(
      "/test/test/SinkExtraModel",
    )({
      // @ts-expect-error extra sections accept only source-capable ports — a bare sink cannot be read
      make: () =>
        Effect.sync(() => ({ inputs: {}, outputs: {}, ui: {}, analytics: { storeSink } })),
    }) {}

    class DataExtraModel extends Model.Service<DataExtraModel>()(
      "/test/test/DataExtraModel",
    )({
      // @ts-expect-error plain data is not a port, in extra sections included
      make: () => Effect.sync(() => ({ inputs: {}, outputs: {}, ui: {}, analytics: { count: 1 } })),
    }) {}

    assert.isDefined(SinkExtraModel);
    assert.isDefined(DataExtraModel);
  });

  it("keeps inputs/outputs required; ui optional for headless models (type-level)", () => {
    class MissingOutputsModel extends Model.Service<MissingOutputsModel>()(
      "/test/test/MissingOutputsModel",
    )({
      // @ts-expect-error `outputs` is required even when empty
      make: () => Effect.sync(() => ({ inputs: {}, ui: {} })),
    }) {}

    // A headless model (no `ui`) is a valid shape — View.make rejects it via Viewable instead.
    class HeadlessModel extends Model.Service<HeadlessModel>()(
      "/test/test/HeadlessModel",
    )({
      make: () => Effect.sync(() => ({ inputs: {}, outputs: {} })),
    }) {}

    assert.isDefined(MissingOutputsModel);
    assert.isDefined(HeadlessModel);
  });

  it("descriptors are pipeable", () => {
    const countStore = Store.make(0);
    const numberEvent = Event.make<number>();
    assert.strictEqual(
      countStore.pipe((store) => store.id),
      countStore.id,
    );
    assert.strictEqual(
      numberEvent.pipe((event) => event.id),
      numberEvent.id,
    );
    assert.isFunction(Event.setter(countStore).pipe);
    assert.isFunction(Event.combine([numberEvent]).pipe);
    assert.isFunction(Store.combine([countStore], (count) => count * 2).pipe);
  });

  it.effect("Event.handler runs on each emit, sequentially and in order", () =>
    Effect.gen(function* () {
      const seen: Array<number> = [];
      const numberEvent = yield* Event.make<number>().pipe(
        Event.handler((value) =>
          Effect.gen(function* () {
            // Yield before recording so out-of-order handling would show up.
            yield* Effect.yieldNow;
            seen.push(value);
          }),
        ),
      );

      yield* Registry.allSettled(
        Event.emit(numberEvent, 1),
        Event.emit(numberEvent, 2),
        Event.emit(numberEvent, 3),
      );

      assert.deepStrictEqual(seen, [1, 2, 3]);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("Event.handler returns the same descriptor and settles with allSettled", () =>
    Effect.gen(function* () {
      const countStore = Store.make(0);
      const incrementEvent = Event.make<number>();
      const returned = yield* incrementEvent.pipe(
        Event.handler((amount) => Store.update(countStore, (count) => count + amount)),
      );

      assert.strictEqual(returned, incrementEvent);

      // The handler pipeline consumes through the tracked stream, so
      // `allSettled` waits for the write it performs.
      yield* Registry.allSettled(Event.emit(returned, 5));
      assert.strictEqual(yield* Store.get(countStore), 5);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("multiple Event.handler applications all run per emit", () =>
    Effect.gen(function* () {
      const firstStore = Store.make(0);
      const secondStore = Store.make(0);
      const numberEvent = yield* Event.make<number>().pipe(
        Event.handler((value) => Store.set(firstStore, value)),
      );
      yield* numberEvent.pipe(Event.handler((value) => Store.set(secondStore, value * 2)));

      yield* Registry.allSettled(Event.emit(numberEvent, 21));

      assert.strictEqual(yield* Store.get(firstStore), 21);
      assert.strictEqual(yield* Store.get(secondStore), 42);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("Event.handler can attach to a source-only combined event", () =>
    Effect.gen(function* () {
      const savedEvent = Event.make<number>();
      const failedEvent = Event.make<number>();
      const settledEvent = Event.combine([savedEvent, failedEvent]);
      const seen: Array<number> = [];

      const returned = yield* settledEvent.pipe(
        Event.handler((value) =>
          Effect.sync(() => {
            seen.push(value);
          }),
        ),
      );

      assert.strictEqual(returned, settledEvent);

      yield* Registry.allSettled(Event.emit(savedEvent, 1), Event.emit(failedEvent, 2));

      assert.deepStrictEqual(seen, [1, 2]);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it("Event.handler is source-only and error-free (type-level)", () => {
    const check = (ports: Model.PortsOf<typeof CounterModel>) => {
      const sinkHandler = Event.handler((_value: number) => Effect.void)(
        // @ts-expect-error Event.handler takes a Source — a Sink port is not accepted
        ports.inputs.incrementEvent,
      );
      const combinedEvent = Event.combine([Event.make<number>()]);
      const sourceHandler = Event.handler((_value: number) => Effect.void)(combinedEvent);
      // @ts-expect-error handlers must keep the error channel empty — handle failures inside
      const failingHandler = Event.make<number>().pipe(Event.handler(() => Effect.fail("boom")));
      return { sinkHandler, sourceHandler, failingHandler };
    };
    assert.isFunction(check);
  });

  it.effect("allows model overrides through Effect layers", () =>
    Effect.gen(function* () {
      const model = yield* Model.get(PrefixedModel);
      const label = yield* Store.get(model.ui.labelStore);

      assert.strictEqual(label, "fake");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Registry.layer,
          Model.layerValue(PrefixedModel, {
            inputs: {},
            outputs: {
              labelStore: fakeLabelStore,
            },
            ui: {
              labelStore: fakeLabelStore,
            },
          }),
        ),
      ),
    ),
  );
});

const ItemListLayer = ItemListModel.layer.pipe(
  Layer.provideMerge(ItemModel.layer),
  Layer.provideMerge(Registry.layer),
);
const FlakyListLayer = FlakyListModel.layer.pipe(
  Layer.provideMerge(FlakyItemModel.layer),
  Layer.provideMerge(Registry.layer),
);
const TotalsLayer = TotalsModel.layer.pipe(
  Layer.provideMerge(ItemModel.layer),
  Layer.provideMerge(Registry.layer),
);

const getItemList = Effect.gen(function* () {
  yield* Model.get(ItemListModel);
  return yield* captured(itemList);
});

describe("Model.list", () => {
  it.effect("keeps push and insert order and looks children up by key", () =>
    Effect.gen(function* () {
      const list = yield* getItemList;

      assert.isTrue(Option.isNone(yield* list.get({ id: "a" })));

      const a = yield* list.push({ id: "a" });
      yield* list.push({ id: "b" });
      yield* list.insert(1, { id: "c" });

      assert.deepStrictEqual(yield* Store.get(list.select((item) => item.outputs.label)), [
        "item:a",
        "item:c",
        "item:b",
      ]);
      const items = yield* Store.get(list.items);
      assert.strictEqual(items.length, 3);
      assert.deepStrictEqual(
        items.map((item) => item.key),
        [{ id: "a" }, { id: "c" }, { id: "b" }],
      );

      const found = yield* list.get({ id: "a" });
      assert.isTrue(Option.isSome(found));
      if (Option.isSome(found)) {
        assert.strictEqual(found.value, a);
      }
    }).pipe(Effect.provide(ItemListLayer)),
  );

  it.effect("pushing an existing key returns its ports without moving it", () =>
    Effect.gen(function* () {
      const list = yield* getItemList;

      const a = yield* list.push({ id: "a" });
      yield* list.push({ id: "b" });

      const again = yield* list.push({ id: "a" });
      assert.strictEqual(again, a);
      const inserted = yield* list.insert(0, { id: "b" });
      assert.strictEqual((yield* Store.get(list.items)).length, 2);
      assert.isDefined(inserted);
      assert.deepStrictEqual(yield* Store.get(list.select((item) => item.outputs.label)), [
        "item:a",
        "item:b",
      ]);
    }).pipe(Effect.provide(ItemListLayer)),
  );

  it.effect("remove and clear drop children from items and dispose them", () =>
    Effect.gen(function* () {
      disposedItems = [];
      const list = yield* getItemList;

      yield* list.push({ id: "a" });
      yield* list.push({ id: "b" });

      yield* list.remove({ id: "a" });
      assert.deepStrictEqual(disposedItems, ["a"]);
      assert.deepStrictEqual(yield* Store.get(list.select((item) => item.outputs.label)), [
        "item:b",
      ]);

      // Removing an absent key is a no-op.
      yield* list.remove({ id: "a" });
      assert.deepStrictEqual(disposedItems, ["a"]);

      yield* list.push({ id: "c" });
      yield* list.clear;
      assert.deepStrictEqual(disposedItems, ["a", "b", "c"]);
      assert.deepStrictEqual(yield* Store.get(list.items), []);
    }).pipe(Effect.provide(ItemListLayer)),
  );

  it.effect("disposing the parent disposes every remaining child", () =>
    Effect.gen(function* () {
      disposedItems = [];
      const registry = yield* Registry;
      const list = yield* getItemList;

      yield* list.push({ id: "a" });
      yield* list.push({ id: "b" });

      yield* Model.dispose(ItemListModel);

      assert.deepStrictEqual([...disposedItems].sort(), ["a", "b"]);
      assert.strictEqual([...(yield* RcMap.keys(registry.instances))].length, 0);
      assert.strictEqual(registry.stores.size, 0);
    }).pipe(Effect.provide(ItemListLayer)),
  );

  it.effect("select re-emits on composition and inner changes, never for removed children", () =>
    Effect.gen(function* () {
      const list = yield* getItemList;
      const counts = list.select((item) => item.outputs.count);

      // The empty list resolves to [].
      assert.deepStrictEqual(yield* Store.get(counts), []);

      const emissions: Array<ReadonlyArray<number>> = [];
      const sawInitial = yield* Deferred.make<void>();
      yield* Store.stream(counts).pipe(
        Stream.runForEach((values) =>
          Effect.suspend(() => {
            emissions.push(values);
            return emissions.length === 1 ? Deferred.succeed(sawInitial, undefined) : Effect.void;
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      // The collector's first emission is the empty composition — mutate only
      // after it landed so the recorded sequence starts deterministically.
      yield* Deferred.await(sawInitial);

      const waitFor = (predicate: (values: ReadonlyArray<number>) => boolean) =>
        Store.stream(counts).pipe(
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );

      // Composition changes re-emit.
      const sawBoth = yield* waitFor((values) => values.length === 2);
      const a = yield* list.push({ id: "a" });
      const b = yield* list.push({ id: "b" });
      yield* Fiber.join(sawBoth);

      // Inner store changes re-emit.
      const sawUpdate = yield* waitFor((values) => values.length === 2 && values[0] === 5);
      yield* Event.emit(a.inputs.setCount, 5);
      yield* Fiber.join(sawUpdate);

      const sawRemoval = yield* waitFor((values) => values.length === 1);
      yield* list.remove({ id: "b" });
      yield* Fiber.join(sawRemoval);

      // A removed child's store update must NOT re-emit.
      yield* Event.emit(b.inputs.setCount, 99);

      const sawLast = yield* waitFor((values) => values.length === 1 && values[0] === 7);
      yield* Event.emit(a.inputs.setCount, 7);
      yield* Fiber.join(sawLast);
      yield* Registry.allSettled();

      assert.deepStrictEqual(emissions[0], []);
      assert.isFalse(emissions.some((values) => values.includes(99)));
      assert.deepStrictEqual(emissions.at(-1), [7]);
    }).pipe(Effect.provide(ItemListLayer)),
  );

  it.effect("select supports Store.combine inside pick", () =>
    Effect.gen(function* () {
      const list = yield* getItemList;
      const summaries = list.select((item) =>
        Store.combine(
          [item.outputs.label, item.outputs.count],
          (label, count) => `${label}=${count}`,
        ),
      );

      const a = yield* list.push({ id: "a" });
      yield* list.push({ id: "b" });
      assert.deepStrictEqual(yield* Store.get(summaries), ["item:a=0", "item:b=0"]);

      const sawUpdate = yield* Store.stream(summaries).pipe(
        Stream.filter((values) => values[0] === "item:a=4"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Event.emit(a.inputs.setCount, 4);

      assert.deepStrictEqual(yield* Fiber.join(sawUpdate), [["item:a=4", "item:b=0"]]);
    }).pipe(Effect.provide(ItemListLayer)),
  );

  it.effect("Registry.allSettled settles through a select pipeline", () =>
    Effect.gen(function* () {
      const totals = yield* Model.get(TotalsModel);
      const list = yield* captured(totalsList);

      // Replayed inner values are not counted by the settle accounting, so
      // first prove the select subscription is live: a write must have made
      // it through the pipeline.
      const ready = yield* Store.stream(totals.outputs.total).pipe(
        Stream.filter((total) => total === 3),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      const a = yield* list.push({ id: "a" });
      yield* Event.emit(a.inputs.setCount, 3);
      yield* Fiber.join(ready);

      yield* Registry.allSettled(Event.emit(a.inputs.setCount, 5));
      assert.strictEqual(yield* Store.get(totals.outputs.total), 5);
    }).pipe(Effect.provide(TotalsLayer)),
  );

  it.effect("a failed child construction leaves the list unchanged", () =>
    Effect.gen(function* () {
      yield* Model.get(FlakyListModel);
      const list = yield* captured(flakyList);
      itemFailuresLeft = 1;

      const failed = yield* Effect.exit(list.push({ id: "a" }));
      assert.isTrue(Exit.isFailure(failed));
      assert.deepStrictEqual(yield* Store.get(list.items), []);
      assert.isTrue(Option.isNone(yield* list.get({ id: "a" })));

      // The failure is not cached: the same key can be pushed again.
      const ports = yield* list.push({ id: "a" });
      assert.isDefined(ports);
      assert.strictEqual((yield* Store.get(list.items)).length, 1);
    }).pipe(Effect.provide(FlakyListLayer)),
  );
});

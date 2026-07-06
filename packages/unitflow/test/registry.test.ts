import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Event, Model, Registry, Store } from "../src/core/index.js";

class CascadeModel extends Model.Service<CascadeModel>()(
  "/test/registry-test/CascadeModel",
)({
  make: () =>
    Effect.gen(function* () {
      const first = Event.make<number>();
      const second = Event.make<number>();
      const third = Event.make<number>();
      const result = Store.make(0);

      yield* Registry.run(
        Event.stream(first).pipe(Stream.mapEffect((value) => Event.emit(second, value + 1))),
      );
      yield* Registry.run(
        Event.stream(second).pipe(Stream.mapEffect((value) => Event.emit(third, value * 10))),
      );
      yield* Registry.run(
        Event.stream(third).pipe(Stream.mapEffect((value) => Store.set(result, value))),
      );

      return {
        inputs: { first },
        outputs: { result },
        ui: { result },
      };
    }),
}) {}

describe("Registry.allSettled", () => {
  it.effect("settles a trigger through a single pipeline without forks", () =>
    Effect.gen(function* () {
      const count = Store.make(0);
      const increment = Event.make<number>();
      yield* Registry.run(
        Event.stream(increment).pipe(
          Stream.mapEffect((amount) => Store.update(count, (current) => current + amount)),
        ),
      );

      yield* Registry.allSettled(Event.emit(increment, 3));

      assert.strictEqual(yield* Store.get(count), 3);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("settles a three-pipeline cascade to its tail", () =>
    Effect.gen(function* () {
      const model = yield* Model.get(CascadeModel);

      yield* Registry.allSettled(Event.emit(model.inputs.first, 4));

      assert.strictEqual(yield* Store.get(model.outputs.result), 50);
    }).pipe(Effect.provide(CascadeModel.layer.pipe(Layer.provideMerge(Registry.layer)))),
  );

  it.effect("runs standalone-primitive triggers sequentially, then settles", () =>
    Effect.gen(function* () {
      const count = Store.make(0);
      const doubled = Store.combine([count], (value) => value * 2);
      const label = Store.make("");
      const increment = Event.make<number>();
      yield* Registry.run(
        Event.stream(increment).pipe(
          Stream.mapEffect((amount) => Store.update(count, (current) => current + amount)),
        ),
      );

      yield* Registry.allSettled(Event.emit(increment, 3), Store.set(label, "x"));

      assert.strictEqual(yield* Store.get(doubled), 6);
      assert.strictEqual(yield* Store.get(label), "x");
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("keeps waiting while a handler is parked on a gate", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const trigger = Event.make();
      const done = Store.make(false);
      yield* Registry.run(
        Event.stream(trigger).pipe(
          Stream.mapEffect(() =>
            Deferred.await(gate).pipe(Effect.flatMap(() => Store.set(done, true))),
          ),
        ),
      );

      yield* Event.emit(trigger);
      const settled = yield* Deferred.make<void>();
      yield* Effect.forkChild(
        Registry.allSettled().pipe(Effect.flatMap(() => Deferred.succeed(settled, undefined))),
        { startImmediately: true },
      );

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.isFalse(yield* Deferred.isDone(settled));

      yield* Deferred.succeed(gate, undefined);
      yield* Deferred.await(settled);
      assert.isTrue(yield* Store.get(done));
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("resolves immediately on an empty registry", () =>
    Effect.gen(function* () {
      yield* Registry.allSettled();
      assert.isTrue(true);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("isolates registries: another registry's backlog does not block", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const trigger = Event.make();
      yield* Registry.run(Event.stream(trigger).pipe(Stream.mapEffect(() => Deferred.await(gate))));
      yield* Event.emit(trigger);

      const outerSettled = yield* Deferred.make<void>();
      yield* Effect.forkChild(
        Registry.allSettled().pipe(Effect.flatMap(() => Deferred.succeed(outerSettled, undefined))),
        { startImmediately: true },
      );

      // A fresh registry (`Layer.fresh` beats the memoized outer one) sees
      // none of the outer backlog and settles at once.
      yield* Registry.allSettled().pipe(Effect.provide(Layer.fresh(Registry.layer)));

      yield* Effect.yieldNow;
      assert.isFalse(yield* Deferred.isDone(outerSettled));

      yield* Deferred.succeed(gate, undefined);
      yield* Deferred.await(outerSettled);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("treats store replay as already settled and keeps counting sound", () =>
    Effect.gen(function* () {
      const source = Store.make(0);
      const seen: Array<number> = [];

      yield* Store.set(source, 1);
      yield* Store.set(source, 2);
      yield* Store.set(source, 3);

      // The pipeline attaches AFTER the writes: it replays the current value,
      // which was never counted — settling must neither hang nor go negative.
      yield* Registry.run(
        Store.stream(source).pipe(Stream.mapEffect((value) => Effect.sync(() => seen.push(value)))),
      );
      yield* Registry.allSettled();

      yield* Registry.allSettled(Store.set(source, 4));
      assert.strictEqual(seen.at(-1), 4);

      // A second settle on the now-idle registry resolves immediately.
      yield* Registry.allSettled();
      assert.strictEqual(yield* Store.get(source), 4);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("started mid-cascade, still waits for the cascade's tail", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const head = Event.make<number>();
      const tail = Event.make<number>();
      const result = Store.make(0);

      yield* Registry.run(
        Event.stream(head).pipe(
          Stream.mapEffect((value) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.flatMap(() => Deferred.await(gate)),
              Effect.flatMap(() => Event.emit(tail, value + 1)),
            ),
          ),
        ),
      );
      yield* Registry.run(
        Event.stream(tail).pipe(Stream.mapEffect((value) => Store.set(result, value * 10))),
      );

      yield* Event.emit(head, 1);
      yield* Deferred.await(entered);

      // The head handler is running: allSettled starts mid-cascade.
      const settled = yield* Deferred.make<void>();
      yield* Effect.forkChild(
        Registry.allSettled().pipe(Effect.flatMap(() => Deferred.succeed(settled, undefined))),
        { startImmediately: true },
      );
      yield* Effect.yieldNow;
      assert.isFalse(yield* Deferred.isDone(settled));

      yield* Deferred.succeed(gate, undefined);
      yield* Deferred.await(settled);
      assert.strictEqual(yield* Store.get(result), 20);
    }).pipe(Effect.provide(Registry.layer)),
  );
});

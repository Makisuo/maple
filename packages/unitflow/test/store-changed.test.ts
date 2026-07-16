import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { Event, Registry, Store } from "../src/core/index.js";

describe("Store.changed", () => {
  it.effect("emits subsequent store values and skips the current replay", () =>
    Effect.gen(function* () {
      const count = Store.make(0);
      const countChanged = yield* Store.changed(count);
      const seen: Array<number> = [];

      yield* countChanged.pipe(
        Event.handler((value) =>
          Effect.sync(() => {
            seen.push(value);
          }),
        ),
      );
      yield* Registry.allSettled();
      assert.deepStrictEqual(seen, []);

      yield* Registry.allSettled(Store.set(count, 1), Store.set(count, 2));

      assert.deepStrictEqual(seen, [1, 2]);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("returns a pipeable event", () =>
    Effect.gen(function* () {
      const count = Store.make(0);
      const doubled = Store.make(0);
      const countChanged = yield* Store.changed(count);

      yield* countChanged.pipe(
        Event.handler((value) => Store.set(doubled, value * 2)),
      );

      yield* Registry.allSettled(Store.set(count, 21));

      assert.strictEqual(yield* Store.get(doubled), 42);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("can pipe directly into Event.handler", () =>
    Effect.gen(function* () {
      const count = Store.make(0);
      const tripled = Store.make(0);

      yield* count.pipe(
        Store.changed,
        Event.handler((value) => Store.set(tripled, value * 3)),
      );

      yield* Registry.allSettled(Store.set(count, 7));

      assert.strictEqual(yield* Store.get(tripled), 21);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("can be consumed with Event.waitFor", () =>
    Effect.gen(function* () {
      const count = Store.make(0);
      const countChanged = yield* Store.changed(count);
      const matched = yield* Deferred.make<void>();
      const nextEven = yield* Event.waitFor(countChanged, (value) => value % 2 === 0).pipe(
        Effect.tap(() => Deferred.succeed(matched, undefined)),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Registry.allSettled(Store.set(count, 1));
      assert.isFalse(yield* Deferred.isDone(matched));

      yield* Registry.allSettled(Store.set(count, 2));

      assert.strictEqual(yield* Fiber.join(nextEven), 2);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("works for derived stores", () =>
    Effect.gen(function* () {
      const count = Store.make(0);
      const parity = Store.combine([count], (value) => value % 2);
      const parityChanged = yield* Store.changed(parity);
      const seen: Array<number> = [];

      yield* parityChanged.pipe(
        Event.handler((value) =>
          Effect.sync(() => {
            seen.push(value);
          }),
        ),
      );

      yield* Registry.allSettled(Store.set(count, 1));
      yield* Registry.allSettled(Store.set(count, 3));
      yield* Registry.allSettled(Store.set(count, 4));

      assert.deepStrictEqual(seen, [1, 0]);
    }).pipe(Effect.provide(Registry.layer)),
  );
});

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Registry, Store } from "../src/core/index.js";

describe("Store.reset", () => {
  it.effect("resets a single store to its initial value", () =>
    Effect.gen(function* () {
      const count = Store.make(0);
      yield* Store.set(count, 5);

      yield* Registry.allSettled(Store.reset(count));
      assert.strictEqual(yield* Store.get(count), 0);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("resets several stores of different types in one call", () =>
    Effect.gen(function* () {
      const count = Store.make(0);
      const name = Store.make("initial");
      const flags = Store.make<ReadonlyArray<boolean>>([]);
      yield* Store.set(count, 5);
      yield* Store.set(name, "changed");
      yield* Store.set(flags, [true]);

      yield* Registry.allSettled(Store.reset(count, name, flags));
      assert.strictEqual(yield* Store.get(count), 0);
      assert.strictEqual(yield* Store.get(name), "initial");
      assert.deepStrictEqual(yield* Store.get(flags), []);
    }).pipe(Effect.provide(Registry.layer)),
  );
});

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Model, Registry, Store } from "../src/core/index.js";

/** Incremented by `LazyModel.make` — the whole point of this suite is
 * observing when (and how many times) construction actually runs. */
let buildCount = 0;

class LazyModel extends Model.Service<LazyModel>()(
  "/test/laziness-test/LazyModel",
)({
  make: () =>
    Effect.sync(() => {
      buildCount += 1;
      const value = Store.make(0);
      return { inputs: {}, outputs: { value }, ui: { value } };
    }),
}) {}

const testLayer = LazyModel.layer.pipe(Layer.provideMerge(Registry.layer));

describe("model construction laziness", () => {
  it.effect("providing the layer does not run make — only the first Model.get does", () =>
    Effect.gen(function* () {
      buildCount = 0;

      // The layer is built by `Effect.provide` before this line runs; the
      // registry is live. Nothing resolved the model yet:
      yield* Registry.allSettled();
      assert.strictEqual(buildCount, 0);

      yield* Model.get(LazyModel);
      assert.strictEqual(buildCount, 1);

      // Memoized: further resolutions reuse the instance.
      yield* Model.get(LazyModel);
      assert.strictEqual(buildCount, 1);
    }).pipe(Effect.provide(testLayer)),
  );
});

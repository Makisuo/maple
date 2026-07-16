import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import { Registry, Store } from "../src/core/index.js";
import * as Query from "../src/core/query.js";

const layer = Layer.mergeAll(Registry.layer, KeyValueStore.layerMemory);

/** Waits until the background save pipeline lands in the KVS. */
const waitForSaved = (key: string) =>
  Effect.gen(function* () {
    const kvs = yield* KeyValueStore.KeyValueStore;
    while ((yield* kvs.get(key)) === undefined) {
      yield* Effect.yieldNow;
    }
  });

describe("Store.persist", () => {
  it.effect("saves changes and hydrates the next store at construction", () =>
    Effect.gen(function* () {
      const source = yield* Store.make("all").pipe(
        Store.persist({ key: "filter", schema: Schema.String }),
      );
      yield* Registry.allSettled(Store.set(source, "rust"));
      yield* waitForSaved("filter");

      // Гидрация inline: сразу после yield* стор уже восстановлен.
      const restored = yield* Store.make("all").pipe(
        Store.persist({ key: "filter", schema: Schema.String }),
      );
      assert.strictEqual(yield* Store.get(restored), "rust");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a hydrated store feeds a dependent query on its first load", () =>
    Effect.gen(function* () {
      const kvs = yield* KeyValueStore.KeyValueStore;
      yield* kvs.set("filter", JSON.stringify({ savedAt: 0, value: "rust" }));

      const seen: Array<string> = [];
      const filter = yield* Store.make("all").pipe(
        Store.persist({ key: "filter", schema: Schema.String }),
      );
      const query = yield* Query.make({
        stores: { filter },
        handler: ({ filter }) =>
          Effect.sync(() => {
            seen.push(filter);
            return filter.toUpperCase();
          }),
      });

      yield* Store.waitFor(query.state, (result) => !result.waiting);
      assert.deepStrictEqual(seen, ["rust"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ignores entries older than timeToLive", () =>
    Effect.gen(function* () {
      const kvs = yield* KeyValueStore.KeyValueStore;
      yield* kvs.set("filter", JSON.stringify({ savedAt: 0, value: "stale" }));
      yield* TestClock.adjust("2 hours");

      const store = yield* Store.make("all").pipe(
        Store.persist({ key: "filter", schema: Schema.String, timeToLive: "1 hour" }),
      );
      assert.strictEqual(yield* Store.get(store), "all");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an entry that fails to decode is a miss, and the store keeps working", () =>
    Effect.gen(function* () {
      const kvs = yield* KeyValueStore.KeyValueStore;
      yield* kvs.set("filter", "{ not json");

      const store = yield* Store.make("all").pipe(
        Store.persist({ key: "filter", schema: Schema.String }),
      );
      assert.strictEqual(yield* Store.get(store), "all");

      yield* Registry.allSettled(Store.set(store, "go"));
      yield* waitForSaved("filter");
      const saved = yield* kvs.get("filter");
      assert.isDefined(saved);
      assert.include(saved ?? "", "go");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("the restored value is not echoed back into the KVS", () =>
    Effect.gen(function* () {
      const kvs = yield* KeyValueStore.KeyValueStore;
      yield* kvs.set("filter", JSON.stringify({ savedAt: 123, value: "rust" }));

      yield* Store.make("all").pipe(
        Store.persist({ key: "filter", schema: Schema.String }),
      );
      // Даём пайплайнам прокрутиться: запись не должна перезаписаться.
      for (let i = 0; i < 25; i++) yield* Effect.yieldNow;
      assert.include((yield* kvs.get("filter")) ?? "", "123");
    }).pipe(Effect.provide(layer)),
  );
});

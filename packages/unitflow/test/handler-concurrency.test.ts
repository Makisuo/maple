import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { Event, Registry, Store } from "../src/core/index.js";

describe("Event.handler concurrency option", () => {
  it.effect("subscribes at fork: an emit later in the same synchronous chain is handled", () =>
    // Regression: piping `Event.stream` through
    // `Stream.mapEffect(..., { concurrency })` subscribes a scheduler hop
    // late — a fully synchronous chain (construction → emit, the shape the
    // allSettled test convention produces) published before the
    // subscription existed and the emission was lost forever.
    // The handler option keeps the pull loop sequential (subscription
    // registers at fork) and forks only the handling.
    Effect.gen(function* () {
      const handled: Array<number> = [];
      const event = yield* Event.make<number>().pipe(
        Event.handler(
          (n) =>
            Effect.sync(() => {
              handled.push(n);
            }),
          { concurrency: "unbounded" },
        ),
      );

      // No real suspension between the wiring above and this emit.
      yield* Registry.allSettled(Event.emit(event, 1));
      assert.deepStrictEqual(handled, [1]);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("a parked handler does not block the next emission", () =>
    Effect.gen(function* () {
      const release = Deferred.makeUnsafe<void>();
      const hits = Store.make<ReadonlyArray<string>>([]);
      const event = yield* Event.make<string>().pipe(
        Event.handler(
          (tag) =>
            (tag === "blocked" ? Deferred.await(release) : Effect.void).pipe(
              Effect.flatMap(() => Store.update(hits, (current) => [...current, tag])),
            ),
          { concurrency: "unbounded" },
        ),
      );

      yield* Event.emit(event, "blocked");
      yield* Registry.allSettled(Event.emit(event, "fast"));
      assert.deepStrictEqual(yield* Store.get(hits), ["fast"]);

      yield* Deferred.succeed(release, undefined);
      yield* Store.waitFor(hits, (current) => current.length === 2);
      assert.deepStrictEqual(yield* Store.get(hits), ["fast", "blocked"]);
    }).pipe(Effect.provide(Registry.layer)),
  );
});

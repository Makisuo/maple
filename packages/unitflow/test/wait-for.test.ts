import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { Event, InstanceScope, Registry, Store } from "../src/core/index.js";

/** Parks until the channel has a registered (tracked) subscription — the
 * deterministic "the waiter is attached" sync point for the tests below. */
const untilSubscribed = (id: string) =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    while (!registry.settle.subscriptions.has(id)) {
      yield* Effect.yieldNow;
    }
  });

type LoadState = Data.TaggedEnum<{
  readonly Idle: {};
  readonly Ready: { readonly value: number };
}>;

const LoadState = Data.taggedEnum<LoadState>();

const brokenPredicate = "broken predicate";

describe("Store.waitFor", () => {
  it.effect("resolves immediately when the current value already matches", () =>
    Effect.gen(function* () {
      const count = Store.make(3);

      assert.strictEqual(yield* Store.waitFor(count, (value) => value >= 3), 3);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("waits for a future matching value", () =>
    Effect.gen(function* () {
      const count = Store.make(0);
      const fiber = yield* Effect.forkChild(
        Store.waitFor(count, (value) => value === 2),
        {
          startImmediately: true,
        },
      );
      yield* untilSubscribed(count.id);

      yield* Store.set(count, 1);
      yield* Store.set(count, 2);

      assert.strictEqual(yield* Fiber.join(fiber), 2);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("skipCurrent waits for the NEXT match past a matching current value", () =>
    Effect.gen(function* () {
      const count = Store.make(1);
      const fiber = yield* Effect.forkChild(
        Store.waitFor(count, (value) => value % 2 === 1, { skipCurrent: true }),
        { startImmediately: true },
      );
      yield* untilSubscribed(count.id);

      yield* Store.set(count, 2);
      yield* Store.set(count, 3);

      assert.strictEqual(yield* Fiber.join(fiber), 3);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("a refinement narrows the resolved value", () =>
    Effect.gen(function* () {
      const state = Store.make<LoadState>(LoadState.Idle());
      const fiber = yield* Effect.forkChild(Store.waitFor(state, LoadState.$is("Ready")), {
        startImmediately: true,
      });
      yield* untilSubscribed(state.id);

      yield* Store.set(state, LoadState.Ready({ value: 7 }));

      const ready = yield* Fiber.join(fiber);
      // Compile-level: `ready` is the narrowed Ready member.
      assert.strictEqual(ready.value, 7);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("a failing effectful predicate fails the wait and releases the subscription", () =>
    Effect.gen(function* () {
      const registry = yield* Registry;
      const count = Store.make(0);

      const error = yield* Effect.flip(Store.waitFor(count, () => Effect.fail(brokenPredicate)));

      assert.strictEqual(error, brokenPredicate);
      assert.isFalse(registry.settle.subscriptions.has(count.id));
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("switches an in-flight effectful evaluation to the latest value", () =>
    Effect.gen(function* () {
      const count = Store.make(1);
      const gate = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const completed: Array<number> = [];

      const fiber = yield* Effect.forkChild(
        Store.waitFor(count, (value) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.flatMap(() => Deferred.await(gate)),
            Effect.map(() => {
              completed.push(value);
              return value === 2;
            }),
          ),
        ),
        { startImmediately: true },
      );

      // The current value (1) is being evaluated, parked on the gate.
      yield* Deferred.await(entered);
      // A new value lands mid-evaluation: the running check is interrupted.
      yield* Registry.allSettled(Store.set(count, 2));
      yield* Deferred.succeed(gate, undefined);

      assert.strictEqual(yield* Fiber.join(fiber), 2);
      // The stale evaluation never completed: switch-to-latest.
      assert.deepStrictEqual(completed, [2]);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("fails with Cause.TimeoutError when the timeout elapses", () =>
    Effect.gen(function* () {
      const registry = yield* Registry;
      const count = Store.make(0);
      const fiber = yield* Effect.forkChild(
        Effect.flip(Store.waitFor(count, (value) => value > 0, { timeout: "3 seconds" })),
        { startImmediately: true },
      );
      yield* untilSubscribed(count.id);

      yield* TestClock.adjust("3 seconds");

      assert.isTrue(Cause.isTimeoutError(yield* Fiber.join(fiber)));
      assert.isFalse(registry.settle.subscriptions.has(count.id));
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("interrupts the waiter when the store's stream ends before a match", () =>
    Effect.gen(function* () {
      const count = Store.make(0);
      const owner = yield* Scope.make();
      // Materialize the backing ref inside a closable owner scope, so closing
      // it shuts the store down mid-wait.
      yield* Store.get(count).pipe(Effect.provideService(InstanceScope, owner));

      const fiber = yield* Effect.forkChild(
        Store.waitFor(count, (value) => value === 99),
        {
          startImmediately: true,
        },
      );
      yield* untilSubscribed(count.id);

      yield* Scope.close(owner, Exit.void);

      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(fiber)));
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("a parked waitFor does not wedge Registry.allSettled", () =>
    Effect.gen(function* () {
      const count = Store.make(0);
      const fiber = yield* Effect.forkChild(
        Store.waitFor(count, (value) => value === 99),
        {
          startImmediately: true,
        },
      );
      yield* untilSubscribed(count.id);

      // The rejected value is confirmed as handled once evaluated: allSettled
      // resolves while the waiter stays parked, like any idle subscription.
      yield* Registry.allSettled(Store.set(count, 1));
      assert.isUndefined(fiber.pollUnsafe());

      yield* Store.set(count, 99);
      assert.strictEqual(yield* Fiber.join(fiber), 99);
    }).pipe(Effect.provide(Registry.layer)),
  );
});

describe("Event.waitFor", () => {
  it.effect("resolves with the first emission without a predicate", () =>
    Effect.gen(function* () {
      const ping = Event.make<number>();
      const fiber = yield* Effect.forkChild(Event.waitFor(ping), { startImmediately: true });
      yield* untilSubscribed(ping.id);

      yield* Event.emit(ping, 7);

      assert.strictEqual(yield* Fiber.join(fiber), 7);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("resolves with the first matching emission", () =>
    Effect.gen(function* () {
      const ping = Event.make<number>();
      const fiber = yield* Effect.forkChild(
        Event.waitFor(ping, (payload) => payload % 2 === 0),
        {
          startImmediately: true,
        },
      );
      yield* untilSubscribed(ping.id);

      yield* Event.emit(ping, 1);
      yield* Event.emit(ping, 2);

      assert.strictEqual(yield* Fiber.join(fiber), 2);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("a failing effectful predicate fails the wait and releases the subscription", () =>
    Effect.gen(function* () {
      const registry = yield* Registry;
      const ping = Event.make<number>();
      const fiber = yield* Effect.forkChild(
        Effect.flip(Event.waitFor(ping, () => Effect.fail(brokenPredicate))),
        { startImmediately: true },
      );
      yield* untilSubscribed(ping.id);

      yield* Event.emit(ping, 1);

      assert.strictEqual(yield* Fiber.join(fiber), brokenPredicate);
      assert.isFalse(registry.settle.subscriptions.has(ping.id));
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("fails with Cause.TimeoutError when the timeout elapses", () =>
    Effect.gen(function* () {
      const ping = Event.make<number>();
      const fiber = yield* Effect.forkChild(
        Effect.flip(Event.waitFor(ping, { timeout: "1 second" })),
        { startImmediately: true },
      );
      yield* untilSubscribed(ping.id);

      yield* TestClock.adjust("1 second");

      assert.isTrue(Cause.isTimeoutError(yield* Fiber.join(fiber)));
    }).pipe(Effect.provide(Registry.layer)),
  );
});

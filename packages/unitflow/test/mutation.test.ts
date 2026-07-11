import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { Event, Model, Registry, Store } from "../src/core/index.js";
import * as Mutation from "../src/core/mutation.js";
import * as Query from "../src/core/query.js";

type BoundUi<Ui> = {
  readonly [K in keyof Ui]: Ui[K] extends Store.Source<infer A>
    ? A
    : Ui[K] extends Event.Sink<infer A>
      ? (...args: Event.EmitArgs<A>) => void
      : Ui[K];
};

const awaitCondition = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (!predicate()) {
      yield* Effect.yieldNow;
    }
  });

class SaveError extends Data.TaggedError("SaveError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

describe("Mutation", () => {
  it.effect("call returns the handler's result", () =>
    Effect.gen(function* () {
      const mutation = yield* Mutation.make((input: number) => Effect.succeed(input * 2));
      const result = yield* Mutation.call(mutation.run, 21);
      assert.strictEqual(result, 42);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("call surfaces the handler's typed failure instead of hanging", () =>
    Effect.gen(function* () {
      const mutation = yield* Mutation.make((input: string) =>
        Effect.fail(new SaveError({ message: `cannot save ${input}` })),
      );
      const failure = yield* Effect.flip(Mutation.call(mutation.run, "draft"));
      assert.isTrue(failure instanceof SaveError);
      if (failure instanceof SaveError) {
        assert.strictEqual(failure.message, "cannot save draft");
      }

      const state = yield* Store.get(mutation.state);
      assert.isTrue(AsyncResult.isFailure(state));
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("two concurrent calls are serialized and each receive their own result", () =>
    Effect.gen(function* () {
      let active = 0;
      let maxActive = 0;
      const mutation = yield* Mutation.make(
        Effect.fnUntraced(function* (input: number) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          yield* Effect.yieldNow;
          active -= 1;
          return input * 10;
        }),
      );

      const firstFiber = yield* Effect.forkChild(Mutation.call(mutation.run, 1), {
        startImmediately: true,
      });
      const secondFiber = yield* Effect.forkChild(Mutation.call(mutation.run, 2), {
        startImmediately: true,
      });

      assert.strictEqual(yield* Fiber.join(firstFiber), 10);
      assert.strictEqual(yield* Fiber.join(secondFiber), 20);
      assert.strictEqual(maxActive, 1);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("call runs with the owner's services, not the caller's", () =>
    Effect.gen(function* () {
      class Prefix extends Context.Service<Prefix, { readonly value: string }>()(
        "/test/mutation/Prefix",
      ) {}

      const mutation = yield* Mutation.make(
        Effect.fnUntraced(function* (input: string) {
          const prefix = yield* Prefix;
          return `${prefix.value}:${input}`;
        }),
      ).pipe(Effect.provideService(Prefix, { value: "owner" }));

      const result = yield* Mutation.call(mutation.run, "x");
      assert.strictEqual(result, "owner:x");
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("Event.emit fire-and-forget still runs the handler, state, and done", () =>
    Effect.gen(function* () {
      const mutation = yield* Mutation.make((input: number) => Effect.succeed(input + 1));

      const doneFiber = yield* Event.waitFor(mutation.done).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Registry.allSettled(Event.emit(mutation.run, 5));

      assert.strictEqual(yield* Fiber.join(doneFiber), 6);
      const state = yield* Store.get(mutation.state);
      assert.isTrue(AsyncResult.isSuccess(state));
      assert.deepStrictEqual(AsyncResult.value(state), Option.some(6));
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("invalidates emits every target's refresh after a successful run", () =>
    Effect.gen(function* () {
      let listCalls = 0;
      const list = yield* Query.make(
        Effect.sync(() => {
          listCalls += 1;
          return listCalls;
        }),
      );
      const standalone = Event.make();
      let standaloneRefreshes = 0;
      const refreshFiber = yield* Event.stream(standalone).pipe(
        Stream.runForEach(() =>
          Effect.sync(() => {
            standaloneRefreshes += 1;
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );

      const mutation = yield* Mutation.make((input: number) => Effect.succeed(input)).pipe(
        Mutation.invalidates(list, { refresh: standalone }),
      );

      yield* Store.waitFor(list.state, (result) => AsyncResult.isSuccess(result));
      yield* Mutation.call(mutation.run, 7);
      yield* Registry.allSettled();
      assert.strictEqual(listCalls, 2);
      assert.strictEqual(standaloneRefreshes, 1);

      const failing = yield* Mutation.make(() =>
        Effect.fail(new SaveError({ message: "no" })),
      ).pipe(Mutation.invalidates(list));
      yield* Effect.flip(Mutation.call(failing.run, undefined));
      yield* Registry.allSettled();
      assert.strictEqual(listCalls, 2);

      yield* Fiber.interrupt(refreshFiber);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("state is waiting while the handler runs", () =>
    Effect.gen(function* () {
      const gate = Deferred.makeUnsafe<number>();
      let started = false;
      const mutation = yield* Mutation.make((_: void) =>
        Effect.suspend(() => {
          started = true;
          return Deferred.await(gate);
        }),
      );

      assert.isFalse(AsyncResult.isWaiting(yield* Store.get(mutation.state)));

      const callFiber = yield* Effect.forkChild(Mutation.call(mutation.run, undefined), {
        startImmediately: true,
      });
      yield* awaitCondition(() => started);
      assert.isTrue(AsyncResult.isWaiting(yield* Store.get(mutation.state)));

      yield* Deferred.succeed(gate, 9);
      assert.strictEqual(yield* Fiber.join(callFiber), 9);
      assert.isFalse(AsyncResult.isWaiting(yield* Store.get(mutation.state)));
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("call fails with TimeoutError when the run misses the timeout", () =>
    Effect.gen(function* () {
      const gate = Deferred.makeUnsafe<number>();
      const mutation = yield* Mutation.make((_: void) => Deferred.await(gate));

      const callFiber = yield* Effect.forkChild(
        Effect.flip(Mutation.call(mutation.run, undefined, { timeout: "5 seconds" })),
        { startImmediately: true },
      );
      yield* TestClock.adjust("5 seconds");
      const failure = yield* Fiber.join(callFiber);
      assert.isTrue(Cause.isTimeoutError(failure));
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("works through a model's narrowed ports", () =>
    Effect.gen(function* () {
      class SaverModel extends Model.Service<SaverModel>()("/test/mutation/SaverModel")({
        make: () =>
          Effect.gen(function* () {
            const save = yield* Mutation.make((input: { readonly name: string }) =>
              Effect.succeed({ id: 1, name: input.name }),
            );
            return {
              inputs: { save: save.run },
              outputs: { saved: save.done },
              ui: { save: save.run, saveState: save.state },
            };
          }),
      }) {}

      yield* Effect.gen(function* () {
        const ports = yield* Model.get(SaverModel);

        const project = yield* Mutation.call(ports.inputs.save, { name: "Loft" });
        assert.deepStrictEqual(project, { id: 1, name: "Loft" });

        const savedFiber = yield* Event.waitFor(ports.outputs.saved).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Registry.allSettled(Event.emit(ports.inputs.save, { name: "Studio" }));
        assert.deepStrictEqual(yield* Fiber.join(savedFiber), { id: 1, name: "Studio" });
      }).pipe(Effect.provide(SaverModel.layer));
    }).pipe(Effect.provide(Registry.layer)),
  );

  it("keeps the sink's mutation type through NarrowInput and BoundUi (type-level)", () => {
    type SaveSink = Mutation.Sink<{ readonly name: string }, { readonly id: number }, SaveError>;
    type Shape = {
      readonly inputs: { readonly save: SaveSink };
      readonly outputs: Record<never, never>;
      readonly ui: { readonly save: SaveSink };
    };

    type NarrowedInput = Model.Ports<Shape>["inputs"]["save"];
    const toSink = (port: NarrowedInput): SaveSink => port;
    const fromSink = (sink: SaveSink): NarrowedInput => sink;

    const callThroughPorts = (ports: Model.Ports<Shape>) =>
      Mutation.call(ports.inputs.save, { name: "Loft" });
    type CallSuccess = Effect.Success<ReturnType<typeof callThroughPorts>>;
    const successWitness = (value: CallSuccess): { readonly id: number } => value;

    type Bound = BoundUi<Shape["ui"]>;
    const bound: Bound = { save: (_value: { readonly name: string }) => undefined };
    // @ts-expect-error the bound callback takes the mutation's input type
    const wrong: Bound = { save: (_value: number) => undefined };

    const streamCheck = (sink: SaveSink) => {
      // @ts-expect-error a mutation sink is write-only: `stream` needs a Source
      const invalid = Event.stream(sink);
      return invalid;
    };

    assert.isFunction(toSink);
    assert.isFunction(fromSink);
    assert.isFunction(successWitness);
    assert.isDefined(bound);
    assert.isDefined(wrong);
    assert.isFunction(streamCheck);
  });
});

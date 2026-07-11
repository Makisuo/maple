import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Event, Model, Registry, Store } from "../src/core/index.js";
import { Command, Reducer, Story } from "../src/reducer/index.js";

// A tiny counter reducer with one command: "reset" requests an async clear
// that (in the integration test) completes synchronously with `ResetCompleted`.
interface CounterState {
  readonly count: number;
  readonly resetting: boolean;
}

type CounterMsg =
  | { readonly _tag: "Increment" }
  | { readonly _tag: "ResetRequested" }
  | { readonly _tag: "ResetCompleted" };

const Increment: CounterMsg = { _tag: "Increment" };
const ResetRequested: CounterMsg = { _tag: "ResetRequested" };
const ResetCompleted: CounterMsg = { _tag: "ResetCompleted" };

const resetCommand = Command.make<CounterMsg>("Reset", Effect.succeed(ResetCompleted));

const update: Reducer.Update<CounterState, CounterMsg> = (state, msg) => {
  switch (msg._tag) {
    case "Increment":
      return [{ ...state, count: state.count + 1 }, Command.none];
    case "ResetRequested":
      return [{ ...state, resetting: true }, [resetCommand]];
    case "ResetCompleted":
      return [{ count: 0, resetting: false }, Command.none];
  }
};

const initial: CounterState = { count: 0, resetting: false };

describe("Reducer / Story", () => {
  it("Story drives update as pure data — state, commands, resolve", () => {
    const story = Story.make(update, initial);

    story.dispatch(Increment);
    story.dispatch(Increment);
    assert.strictEqual(story.state.count, 2);
    assert.deepStrictEqual(
      story.commands.map((command) => command.name),
      [],
    );

    story.dispatch(ResetRequested);
    assert.isTrue(story.state.resetting);
    assert.deepStrictEqual(
      story.commands.map((command) => command.name),
      ["Reset"],
    );

    // Simulate the command completing.
    story.resolve("Reset", ResetCompleted);
    assert.strictEqual(story.state.count, 0);
    assert.isFalse(story.state.resetting);
  });

  it("Story.resolve throws for a command the reducer never produced", () => {
    const story = Story.make(update, initial);
    story.dispatch(Increment);
    assert.throws(() => story.resolve("Reset", ResetCompleted), /no pending command named "Reset"/);
  });

  it("Command.define builds a named command per payload", () => {
    const load = Command.define("Load", (_id: number) => Effect.succeed<CounterMsg>(ResetCompleted));
    const command = load(7);
    assert.strictEqual(command.name, "Load");
    assert.isTrue(Command.isCommand(command));
  });

  it.effect("dispatch runs update, writes the state store, and cascades commands", () =>
    Effect.gen(function* () {
      const reducer = yield* Reducer.make({ initial, update, name: "counter" });

      yield* Registry.allSettled(
        Event.emit(reducer.dispatch, Increment),
        Event.emit(reducer.dispatch, Increment),
      );
      assert.strictEqual((yield* Store.get(reducer.state)).count, 2);

      // ResetRequested flips `resetting`, forks the Reset command, whose
      // synchronous ResetCompleted cascade lands within the same settle window.
      yield* Registry.allSettled(Event.emit(reducer.dispatch, ResetRequested));
      const final = yield* Store.get(reducer.state);
      assert.strictEqual(final.count, 0);
      assert.isFalse(final.resetting);
    }).pipe(Effect.provide(Registry.layer)),
  );

  it.effect("works through a model's narrowed ports", () =>
    Effect.gen(function* () {
      class CounterModel extends Model.Service<CounterModel>()("/test/reducer/CounterModel")({
        make: () =>
          Effect.gen(function* () {
            const counter = yield* Reducer.make({ initial, update, name: "counter" });
            return {
              inputs: { dispatch: counter.dispatch },
              outputs: { state: counter.state },
              ui: { state: counter.state, dispatch: counter.dispatch },
            };
          }),
      }) {}

      yield* Effect.gen(function* () {
        const ports = yield* Model.get(CounterModel);
        yield* Registry.allSettled(Event.emit(ports.inputs.dispatch, Increment));
        assert.strictEqual((yield* Store.get(ports.outputs.state)).count, 1);
      }).pipe(Effect.provide(CounterModel.layer));
    }).pipe(Effect.provide(Registry.layer)),
  );
});

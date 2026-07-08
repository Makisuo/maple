import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Event from "../core/event.js";
import { ownerScope, Registry } from "../core/registry.js";
import * as Store from "../core/store.js";
import type { Command } from "./command.js";

/** What one `update` step returns: the next state and the commands to run. */
export type Transition<State, Msg, R = never> = readonly [State, ReadonlyArray<Command<Msg, R>>];

/** The pure transition function — the whole of a reducer model's behavior. */
export type Update<State, Msg, R = never> = (state: State, msg: Msg) => Transition<State, Msg, R>;

/**
 * A reducer unit: the full `state` store and `dispatch` event a model
 * republishes through its ports. `state` in `outputs`/`ui` narrows to a
 * read-only source; `dispatch` in `inputs`/`ui` narrows to a write-only sink.
 */
export interface Reducer<State, Msg> {
  readonly state: Store.Store<State>;
  readonly dispatch: Event.Event<Msg>;
}

export interface MakeOptions<State, Msg, R> {
  readonly initial: State;
  readonly update: Update<State, Msg, R>;
  /** Names the `state` store and `dispatch` event for the devtools / logs. */
  readonly name?: string;
}

/**
 * Builds a reducer unit inside a model's `make`: every `dispatch` runs the
 * pure `update`, writes the next state into `state`, and forks each returned
 * command into the model instance's scope — a command's result message is fed
 * straight back through `dispatch`, so asynchronous transitions stay inside
 * the state machine. Dispatches are serialized (unitflow's direct handler
 * drain), so `update` always sees the latest state; a synchronous command
 * cascades within the same settle window (so `Registry.allSettled` awaits it),
 * while a suspending command runs concurrently and re-enters on completion.
 *
 * This is The Elm Architecture scoped to ONE model — an opt-in discipline for
 * units with complex interactive state, not a replacement for the derivation
 * models `Store.combine` already serves well.
 */
export const make = <State, Msg, R = never>(
  options: MakeOptions<State, Msg, R>,
): Effect.Effect<Reducer<State, Msg>, never, R | Registry> =>
  Effect.gen(function* () {
    const state = Store.make(
      options.initial,
      options.name === undefined ? undefined : { name: options.name },
    );
    const dispatch = Event.make<Msg>(
      options.name === undefined ? undefined : { name: `${options.name}.dispatch` },
    );

    // Commands are forked into the owner scope (the model instance's scope
    // inside a `make`, the registry scope otherwise) so a long-running command
    // never blocks the next dispatch. `startImmediately` runs a synchronous
    // command to completion in place, so its follow-up `dispatch` is counted
    // in the current settle window — the same reason unitflow's own concurrent
    // handlers fork this way.
    const scope = yield* ownerScope;
    const runCommand = (command: Command<Msg, R>): Effect.Effect<void, never, R | Registry> =>
      Effect.asVoid(
        Effect.forkIn(
          Effect.flatMap(command.execute, (message) => Event.emit(dispatch, message)).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logError("Unitflow reducer command terminated unexpectedly", cause),
            ),
          ),
          scope,
          { startImmediately: true },
        ),
      );

    yield* dispatch.pipe(
      Event.handler((message: Msg) =>
        Effect.gen(function* () {
          const current = yield* Store.get(state);
          const [next, commands] = options.update(current, message);
          yield* Store.set(state, next);
          yield* Effect.forEach(commands, runCommand, { discard: true });
        }),
      ),
    );

    return { state, dispatch };
  });

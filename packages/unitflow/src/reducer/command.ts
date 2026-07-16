import type * as Effect from "effect/Effect";

const TypeId = Symbol.for("@maple/unitflow/reducer/Command");

/**
 * A declarative one-shot side effect returned from a reducer's `update`: an
 * Effect that resolves to the follow-up message fed back through `dispatch`.
 * The reducer runtime runs it (forked into the model instance's scope) and
 * re-dispatches its result, so every asynchronous transition still flows
 * through the pure `update`. This is foldkit's `Command`, expressed with
 * unitflow's Event/Store primitives — the reducer never leaves the state
 * machine to do async work.
 *
 * `execute` may not fail (`E = never`): in this discipline a model's failures
 * are messages. Turn a fallible effect into both-outcomes-as-messages with
 * `Effect.match`/`Effect.catch*` before wrapping it as a command.
 */
export interface Command<out Msg, out R = never> {
  readonly [TypeId]: typeof TypeId;
  /** A label for the Story harness and devtools timeline — not an identity key. */
  readonly name: string;
  readonly execute: Effect.Effect<Msg, never, R>;
}

export const isCommand = (value: unknown): value is Command<unknown, unknown> =>
  typeof value === "object" && value !== null && TypeId in value;

/** Wrap an effect that already produces the follow-up message. */
export const make = <Msg, R = never>(
  name: string,
  execute: Effect.Effect<Msg, never, R>,
): Command<Msg, R> => ({ [TypeId]: TypeId, name, execute });

/**
 * A reusable command constructor from a payload — foldkit's
 * `Command.define('Name', payload => effectProducingMsg)`. The returned
 * function builds a named command for each payload.
 */
export const define =
  <P, Msg, R = never>(name: string, run: (payload: P) => Effect.Effect<Msg, never, R>) =>
  (payload: P): Command<Msg, R> =>
    make(name, run(payload));

/** The empty command list — the common `update` return for a pure transition. */
export const none: ReadonlyArray<Command<never>> = [];

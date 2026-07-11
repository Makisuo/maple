import type { Command } from "./command.js";
import type { Update } from "./reducer.js";

/**
 * A pure, synchronous driver for a reducer's `update` — the unitflow analogue
 * of foldkit's Story tests. Feeds messages through `update`, exposing the
 * resulting state and the commands the last step produced; `resolve` simulates
 * a command completing by dispatching its follow-up message. No registry, no
 * React, no timers: `update` is pure, so the whole state machine is testable
 * as plain data.
 */
export interface Story<State, Msg> {
  /** The current state, after every message dispatched so far. */
  readonly state: State;
  /** The commands the most recent `dispatch` returned (empty before the first). */
  readonly commands: ReadonlyArray<Command<Msg, unknown>>;
  /** Run one message through `update`, advancing `state` and `commands`. */
  readonly dispatch: (msg: Msg) => void;
  /**
   * Simulate the named command completing: assert one is pending, then
   * dispatch its follow-up message. Throws if the last dispatch produced no
   * command of that name — resolving a command the reducer never asked for is
   * a bug in the test, not a silent no-op.
   */
  readonly resolve: (name: string, followup: Msg) => void;
}

export const make = <State, Msg, R = never>(
  update: Update<State, Msg, R>,
  initial: State,
): Story<State, Msg> => {
  let state = initial;
  let commands: ReadonlyArray<Command<Msg, R>> = [];

  const dispatch = (msg: Msg): void => {
    const [next, produced] = update(state, msg);
    state = next;
    commands = produced;
  };

  const resolve = (name: string, followup: Msg): void => {
    if (!commands.some((command) => command.name === name)) {
      const produced = commands.length === 0 ? "none" : commands.map((command) => command.name).join(", ");
      throw new Error(`Story.resolve: no pending command named "${name}" (last dispatch produced: ${produced}).`);
    }
    dispatch(followup);
  };

  return {
    get state() {
      return state;
    },
    get commands() {
      return commands;
    },
    dispatch,
    resolve,
  };
};

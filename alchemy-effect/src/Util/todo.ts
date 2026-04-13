import * as Effect from "effect/Effect";

export const todo = (message?: string) =>
  Effect.die(message ?? `Not implemented`);

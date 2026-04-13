import * as Effect from "effect/Effect";
import * as Data from "effect/Data";

export class UnexpectedValueError extends Data.TaggedError(
  "UnexpectedValueError",
)<{
  message: string;
  value: never;
}> {}

export const assertNeverOrDie = (value: never): Effect.Effect<never> => {
  return Effect.die(
    new UnexpectedValueError({
      message: `Unexpected value: ${value}`,
      value,
    }),
  );
};

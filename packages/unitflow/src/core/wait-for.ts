import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

/**
 * INTERNAL. The shared first-match machinery behind `Store.waitFor` and
 * `Event.waitFor`. Not exported from the package index — models reach it only
 * through the `Store`/`Event` namespaces.
 */

/** A `waitFor` predicate: a plain boolean predicate (or refinement), or an
 * effectful check. */
export type WaitPredicate<A> = (value: A) => boolean | Effect.Effect<boolean, any, any>;

/** Lifts a predicate verdict into an effect, deferring the synchronous call
 * so a throwing predicate becomes a defect instead of breaking the caller. */
export const evaluate = <A>(
  predicate: WaitPredicate<A>,
  value: A,
): Effect.Effect<boolean, any, any> =>
  Effect.suspend(() => {
    const verdict = predicate(value);
    return Effect.isEffect(verdict) ? verdict : Effect.succeed(verdict);
  });

/** Resolves with the stream's first element. The stream ending first means
 * the awaited value can never arrive (its channel shut down), so the waiter
 * is interrupted. `timeout` fails with `Cause.TimeoutError` — exactly what
 * `Effect.timeout` raises. Either way `runHead` closes the stream's scope,
 * releasing its tracked subscription on every exit path. */
export const awaitFirst = <A>(
  matches: Stream.Stream<A, any, any>,
  timeout: Duration.Input | undefined,
): Effect.Effect<A, any, any> => {
  const first = Stream.runHead(matches).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.interrupt,
        onSome: (value) => Effect.succeed(value),
      }),
    ),
  );
  return timeout === undefined ? first : Effect.timeout(first, timeout);
};

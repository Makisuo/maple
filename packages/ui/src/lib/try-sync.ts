import { Effect, Option } from "effect"

/**
 * A throwing synchronous call as a total `Option`.
 *
 * The DOM is full of calls that throw rather than return a failure — `JSON.parse`
 * on a truncated body, `localStorage` in private mode, `execCommand` in a
 * sandboxed frame, a `getContext("2d")` a hardened browser refuses. `Effect.try`
 * moves the throw into the error channel and `Effect.option` discards it, so the
 * caller branches on a value the type system can see instead of on control flow
 * it cannot.
 *
 * Costs ~0.5µs per call against ~0.05µs for a bare `try`/`catch`. That is fine
 * everywhere it is used here; a genuinely hot loop should hoist the decision out
 * rather than reach back for a `catch` block.
 */
export const trySync = <A>(thunk: () => A): Option.Option<A> =>
	Effect.runSync(Effect.option(Effect.try(thunk)))

/**
 * The async twin, for a promise that rejects rather than a call that throws.
 * Resolves to `None` on rejection.
 */
export const tryPromise = <A>(thunk: () => Promise<A>): Promise<Option.Option<A>> =>
	Effect.runPromise(Effect.option(Effect.tryPromise(thunk)))

// A throwing host call, as a value.
//
// The SDK runs inside someone else's app, so it touches host APIs that throw
// rather than return a failure: `Intl` in a locale-stripped build, `BigInt` on a
// wire value that isn't numeric, `decodeURIComponent` on a literal `%`, a
// `node:fs` read the sandbox refuses. Every one of those is best-effort — the
// SDK degrades an attribute rather than breaking the host — and `Effect.try` is
// what makes that an `Option` the caller has to answer for instead of a `catch`
// block that quietly covers the next three statements too.
import { Effect, Option } from "effect"

/** Run a throwing synchronous call, `None` if it threw. */
export const trySync = <A>(thunk: () => A): Option.Option<A> =>
	Effect.runSync(Effect.option(Effect.try(thunk)))

/** Run a throwing synchronous call, `undefined` if it threw. */
export const trySyncOrUndefined = <A>(thunk: () => A): A | undefined => Option.getOrUndefined(trySync(thunk))

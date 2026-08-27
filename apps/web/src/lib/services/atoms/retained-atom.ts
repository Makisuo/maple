import { Atom, Result } from "@/lib/effect-atom"

import { nextRetentionNamespace, retainResult, retainedResult } from "@/lib/services/atoms/result-retention"

export { nextRetentionNamespace }

/**
 * Give an atom stale-while-revalidate behaviour across rebuilds.
 *
 * An atom's idle TTL is a *gcTime*: once the last subscriber unmounts and the
 * TTL lapses, the atom is disposed. The next mount therefore starts at
 * `Initial` and the page paints a skeleton over data that was correct moments
 * ago. Effect-atom already covers the easier case — refreshing a *live* atom
 * yields `waitingFrom(previous)`, so the old value stays on screen — but it has
 * nothing to offer once the atom itself is gone, or when the key changed.
 *
 * This closes that gap: successes are recorded against a logical identity, and
 * a rebuilt atom serves the last recorded value (flagged `waiting`) until the
 * real fetch lands.
 *
 * Wrap the atom rather than the effect inside it, so this works for anything
 * producing a `Result` — the warehouse query families, dashboard widget fetches
 * and the plain HTTP query atoms all share one implementation.
 *
 * @param identity Stable across time windows but unique per query. Build it
 * with `nextRetentionNamespace()` plus `identityFromKey`, or from a
 * group/endpoint pair. Two different queries sharing an identity will serve
 * each other's rows — see the note in `result-retention.ts`.
 */
/**
 * One wrapper per (atom, identity), so callers may build it in a render body.
 *
 * `retainedQuery`/`retainedQueryV2` call this on every render. Without the
 * memo each call produced a fresh atom — a fresh registry node — and while the
 * primary was `Initial` with a retained entry present, every render served a
 * brand-new `waiting(success)` object. `useRetainedResult` compares successes
 * by identity and writes state during render, so that churn looped until React
 * threw "Too many re-renders" (minified #301) and took the page down.
 *
 * Keyed by the underlying atom (weakly, so wrappers die with it) then by
 * identity, which carries the org scope.
 */
const wrappers = new WeakMap<Atom.Atom<unknown>, Map<string, Atom.Atom<unknown>>>()

export function withRetention<A, E>(
	self: Atom.Atom<Result.Result<A, E>>,
	identity: string,
): Atom.Atom<Result.Result<A, E>> {
	let byIdentity = wrappers.get(self)
	if (byIdentity === undefined) {
		byIdentity = new Map()
		wrappers.set(self, byIdentity)
	}
	const existing = byIdentity.get(identity)
	if (existing !== undefined) {
		return existing as Atom.Atom<Result.Result<A, E>>
	}
	const wrapper = buildRetention(self, identity)
	byIdentity.set(identity, wrapper)
	return wrapper
}

function buildRetention<A, E>(
	self: Atom.Atom<Result.Result<A, E>>,
	identity: string,
): Atom.Atom<Result.Result<A, E>> {
	// Recording on read rather than inside the effect keeps this generic. It is
	// idempotent because the entry is stamped with the Result's own timestamp
	// (fixed when the value was produced) instead of `Date.now()` — re-reading a
	// value must not keep resetting its age, or nothing would ever expire.
	//
	// `waiting` successes are skipped: those carry the *previous* value during a
	// refresh, so recording them would write stale data back over itself.
	const recorded = Atom.map(self, (result) => {
		if (Result.isSuccess(result) && !result.waiting) {
			retainResult(identity, result.value, result.timestamp)
		}
		return result
	})

	return Atom.withFallback(
		recorded,
		Atom.make(() => {
			const retained = retainedResult(identity)
			return retained
				? Result.success<A, never>(retained.value as A, { timestamp: retained.timestamp })
				: Result.initial<A, never>()
		}),
	)
}

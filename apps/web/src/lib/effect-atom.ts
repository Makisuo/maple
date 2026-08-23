import {
	RegistryContext,
	scheduleTask,
	useAtom,
	useAtomInitialValues,
	useAtomMount,
	useAtomRefresh,
	useAtomRef,
	useAtomRefProp,
	useAtomRefPropValue,
	useAtomSet,
	useAtomSubscribe,
	useAtomSuspense,
	useAtomValue as useAtomValueRaw,
} from "@effect/atom-react"
import { Cause, Option } from "effect"
import * as React from "react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom_ from "effect/unstable/reactivity/Atom"
import { getActiveOrgId, subscribeActiveOrgId } from "@/lib/services/common/auth-headers"

export {
	RegistryContext,
	scheduleTask,
	useAtom,
	useAtomInitialValues,
	useAtomMount,
	useAtomRefresh,
	useAtomRef,
	useAtomRefProp,
	useAtomRefPropValue,
	useAtomSet,
	useAtomSubscribe,
	useAtomSuspense,
}
export * as Atom from "effect/unstable/reactivity/Atom"
export * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi"
export * as Registry from "effect/unstable/reactivity/AtomRegistry"
export * as ScopedAtom from "@effect/atom-react/ScopedAtom"

interface RetainedSuccess {
	readonly orgId: string | null
	readonly result: AsyncResult.Success<unknown, unknown>
}

/**
 * Keep the last success on screen while a *differently keyed* atom loads.
 *
 * Effect-atom already covers a refresh of a live atom — that yields a waiting
 * result carrying the previous value. It has nothing to offer when the atom
 * itself changes, which is what every filter rail does: ticking a checkbox
 * rewrites the search params, the components build a new atom key, and the
 * fresh atom starts at `Initial`. Every `Result.builder(...).onInitial(...)`
 * on the page then paints its skeleton, so a one-checkbox filter reads as a
 * full page reload.
 *
 * `withRetention` (see `retained-atom.ts`) closes the same gap at the atom
 * layer, but only across *time windows* — its identity deliberately keeps the
 * filters, because a persisted cache that served one filter's rows under
 * another's key would be wrong for every later reader.
 *
 * This is the render-local half: the previous value is held by the hook call
 * itself, so it can only ever be shown to the component that just watched it
 * arrive. It is returned flagged `waiting`, which is the signal list pages
 * already dim on — data stays put, the page marks itself busy, and the rows
 * swap when the query lands.
 *
 * The org is part of the retained entry rather than assumed stable: an org
 * switch also rebuilds every atom key, and showing the previous org's rows —
 * even dimmed, even briefly — is the exact leak `ORG_KEY_SEPARATOR` exists to
 * prevent.
 *
 * The tradeoff is deliberate: a detail page whose key comes from a route param
 * shows the previous entity's numbers for the length of one query. That is the
 * same call the service-detail panels already made one at a time; it is worth
 * it because the alternative — every list, chart and facet count in the app
 * unmounting into a skeleton on a checkbox — is what this removes. Surfaces
 * that must not show a stale value read `result.waiting` and say so.
 */
function useRetainedResult<A>(value: A): A {
	const orgId = React.useSyncExternalStore(subscribeActiveOrgId, getActiveOrgId, getActiveOrgId)
	const [retained, setRetained] = React.useState<RetainedSuccess | null>(null)

	let next = retained
	if (next !== null && next.orgId !== orgId) {
		next = null
	}
	if (AsyncResult.isAsyncResult(value) && AsyncResult.isSuccess(value)) {
		// Compared by identity so a steady success does not queue a state write
		// on every render.
		if (next === null || next.result !== value) {
			next = { orgId, result: value }
		}
	}
	if (next !== retained) {
		setRetained(next)
	}

	return React.useMemo(() => {
		if (next === null || !AsyncResult.isAsyncResult(value) || !AsyncResult.isInitial(value)) {
			return value
		}
		return AsyncResult.success(next.result.value, {
			waiting: true,
			timestamp: next.result.timestamp,
		}) as A
	}, [next, value])
}

/**
 * `useAtomValue`, plus keep-previous-data for `AsyncResult` atoms.
 *
 * Wrapped here rather than in a hook every call site has to remember, because
 * the skeleton flash it removes is not a property of any one page — it happens
 * anywhere an atom key is derived from search params. Non-`AsyncResult` atoms
 * pass through untouched.
 */
export interface UseAtomValue {
	<A>(atom: Atom_.Atom<A>): A
	<A, B>(atom: Atom_.Atom<A>, f: (_: A) => B): B
}

export const useAtomValue: UseAtomValue = (<A, B>(atom: Atom_.Atom<A>, f?: (_: A) => B) =>
	// `f` is forwarded rather than branched on: upstream already does the
	// `if (f)` itself, so this stays a single unconditional hook call.
	useRetainedResult(useAtomValueRaw(atom, f as (_: A) => B))) as never

type ResultValue<T> = T extends AsyncResult.AsyncResult<infer A, any> ? A : never
type ResultError<T> = T extends AsyncResult.AsyncResult<any, infer E> ? E : never

class ResultBuilder<A, E, B> {
	constructor(
		private readonly result: AsyncResult.AsyncResult<A, E>,
		private readonly mapped: Option.Option<B>,
	) {}

	onSuccess<C>(f: (value: A, result: AsyncResult.Success<A, E>) => C): ResultBuilder<A, E, B | C> {
		if (Option.isSome(this.mapped)) {
			return new ResultBuilder(this.result, this.mapped)
		}

		if (AsyncResult.isSuccess(this.result)) {
			return new ResultBuilder(this.result, Option.some(f(this.result.value, this.result)))
		}

		return new ResultBuilder(this.result, Option.none())
	}

	onInitial<C>(f: () => C): ResultBuilder<A, E, B | C> {
		if (Option.isSome(this.mapped)) {
			return new ResultBuilder(this.result, this.mapped)
		}

		if (AsyncResult.isInitial(this.result)) {
			return new ResultBuilder(this.result, Option.some(f()))
		}

		return new ResultBuilder(this.result, Option.none())
	}

	onError<C>(f: (error: E) => C): ResultBuilder<A, E, B | C> {
		if (Option.isSome(this.mapped)) {
			return new ResultBuilder(this.result, this.mapped)
		}

		if (AsyncResult.isFailure(this.result)) {
			const squashed = Cause.squash(this.result.cause)
			return new ResultBuilder(this.result, Option.some(f(squashed as E)))
		}

		return new ResultBuilder(this.result, Option.none())
	}

	orElse<C>(fallback: () => C): B | C {
		return Option.getOrElse(this.mapped, fallback)
	}

	render(): B | null {
		return Option.getOrNull(this.mapped)
	}
}

export namespace Result {
	export type Result<A, E = never> = AsyncResult.AsyncResult<A, E>
	export type Success<A, E = never> = AsyncResult.Success<A, E>
	export type Failure<A, E = never> = AsyncResult.Failure<A, E>

	export const isInitial = AsyncResult.isInitial
	export const isSuccess = AsyncResult.isSuccess
	export const isFailure = AsyncResult.isFailure
	export const initial = AsyncResult.initial
	export const success = AsyncResult.success
	export const fail = AsyncResult.fail

	export const builder = <A, E>(result: Result<A, E>) =>
		new ResultBuilder<A, E, never>(result, Option.none())

	export const all = <const Results extends ReadonlyArray<Result<any, any>>>(
		results: Results,
	): Result<{ [K in keyof Results]: ResultValue<Results[K]> }, ResultError<Results[number]>> => {
		const waiting = results.some((result) => result.waiting)

		for (const result of results) {
			if (AsyncResult.isFailure(result)) {
				return waiting ? AsyncResult.waiting(result) : result
			}

			if (AsyncResult.isInitial(result)) {
				return AsyncResult.initial(waiting)
			}
		}

		const values = results.map((result) => (result as AsyncResult.Success<any, any>).value) as {
			[K in keyof Results]: ResultValue<Results[K]>
		}
		const timestamp = results.reduce(
			(latest, result) => (AsyncResult.isSuccess(result) ? Math.max(latest, result.timestamp) : latest),
			0,
		)

		return AsyncResult.success(values, {
			waiting,
			timestamp,
		})
	}
}

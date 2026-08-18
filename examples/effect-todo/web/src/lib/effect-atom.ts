/**
 * Tiny re-export barrel over effect-atom, trimmed from apps/web's version.
 * The `Result.builder` helper makes rendering an async atom's
 * initial/success/error states a one-liner.
 */
import { RegistryContext, scheduleTask, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Cause, Option } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"

export { RegistryContext, scheduleTask, useAtomRefresh, useAtomSet, useAtomValue }
export * as Atom from "effect/unstable/reactivity/Atom"
export * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi"
export * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"

class ResultBuilder<A, E, B> {
	constructor(
		private readonly result: AsyncResult.AsyncResult<A, E>,
		private readonly mapped: Option.Option<B>,
	) {}

	onSuccess<C>(f: (value: A) => C): ResultBuilder<A, E, B | C> {
		if (Option.isSome(this.mapped)) {
			return new ResultBuilder(this.result, this.mapped)
		}
		if (AsyncResult.isSuccess(this.result)) {
			return new ResultBuilder(this.result, Option.some(f(this.result.value)))
		}
		return new ResultBuilder(this.result, Option.none())
	}

	onError<C>(f: (error: E) => C): ResultBuilder<A, E, B | C> {
		if (Option.isSome(this.mapped)) {
			return new ResultBuilder(this.result, this.mapped)
		}
		if (AsyncResult.isFailure(this.result)) {
			return new ResultBuilder(this.result, Option.some(f(Cause.squash(this.result.cause) as E)))
		}
		return new ResultBuilder(this.result, Option.none())
	}

	orElse<C>(fallback: () => C): B | C {
		return Option.getOrElse(this.mapped, fallback)
	}
}

export namespace Result {
	export type Result<A, E = never> = AsyncResult.AsyncResult<A, E>
	export const isInitial = AsyncResult.isInitial
	export const isSuccess = AsyncResult.isSuccess
	export const isFailure = AsyncResult.isFailure
	export const builder = <A, E>(result: Result<A, E>) =>
		new ResultBuilder<A, E, never>(result, Option.none())
}

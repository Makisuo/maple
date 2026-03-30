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
  useAtomValue,
} from "@effect/atom-react"
import { Cause, Option } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"

export { RegistryContext, scheduleTask, useAtom, useAtomInitialValues, useAtomMount, useAtomRefresh, useAtomRef, useAtomRefProp, useAtomRefPropValue, useAtomSet, useAtomSubscribe, useAtomSuspense, useAtomValue }
export * as Atom from "effect/unstable/reactivity/Atom"
export * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi"
export * as Registry from "effect/unstable/reactivity/AtomRegistry"
export * as ScopedAtom from "@effect/atom-react/ScopedAtom"

type ResultValue<T> = T extends AsyncResult.AsyncResult<infer A, any> ? A : never
type ResultError<T> = T extends AsyncResult.AsyncResult<any, infer E> ? E : never

class ResultBuilder<A, E, B> {
  constructor(
    private readonly result: AsyncResult.AsyncResult<A, E>,
    private readonly mapped: Option.Option<B>,
  ) {}

  onSuccess<C>(f: (value: A, result: AsyncResult.Success<A, E>) => C): ResultBuilder<A, E, C> {
    if (Option.isSome(this.mapped)) {
      return new ResultBuilder(this.result, this.mapped as unknown as Option.Option<C>)
    }

    if (AsyncResult.isSuccess(this.result)) {
      return new ResultBuilder(this.result, Option.some(f(this.result.value, this.result)))
    }

    return new ResultBuilder(this.result, Option.none())
  }

  onInitial<C>(f: () => C): ResultBuilder<A, E, B | C> {
    if (Option.isSome(this.mapped)) {
      return new ResultBuilder(this.result, this.mapped as unknown as Option.Option<B | C>)
    }

    if (AsyncResult.isInitial(this.result)) {
      return new ResultBuilder(this.result, Option.some(f()))
    }

    return new ResultBuilder(this.result, Option.none())
  }

  onError<C>(f: (error: E extends Error ? E : Error) => C): ResultBuilder<A, E, B | C> {
    if (Option.isSome(this.mapped)) {
      return new ResultBuilder(this.result, this.mapped as unknown as Option.Option<B | C>)
    }

    if (AsyncResult.isFailure(this.result)) {
      const squashed = Cause.squash(this.result.cause)
      const err = squashed instanceof Error ? squashed : new Error(String(squashed))
      return new ResultBuilder(
        this.result,
        Option.some(f(err as E extends Error ? E : Error)),
      )
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
  ): Result<
    { [K in keyof Results]: ResultValue<Results[K]> },
    ResultError<Results[number]>
  > => {
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
      (latest, result) =>
        AsyncResult.isSuccess(result) ? Math.max(latest, result.timestamp) : latest,
      0,
    )

    return AsyncResult.success(values, {
      waiting,
      timestamp,
    })
  }
}

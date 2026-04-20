/**
 * A transactional deferred value — a write-once cell that can be read within transactions.
 * Readers retry until a value is set; once set, the value is immutable.
 *
 * @since 4.0.0
 */

import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import type { Inspectable } from "./Inspectable.ts"
import { NodeInspectSymbol, toJson } from "./Inspectable.ts"
import type { Option } from "./Option.ts"
import * as O from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import type { Result } from "./Result.ts"
import * as Res from "./Result.ts"
import * as TxRef from "./TxRef.ts"

const TypeId = "~effect/transactions/TxDeferred"

/**
 * A transactional deferred — a write-once cell readable within transactions.
 *
 * Readers block (retry the transaction) until a value is committed.
 * Writers succeed only on the first call; subsequent writes return `false`.
 *
 * @example
 * ```ts
 * import { Effect, TxDeferred } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* TxDeferred.make<number>()
 *
 *   // Complete the deferred
 *   const first = yield* TxDeferred.succeed(deferred, 42)
 *   console.log(first) // true
 *
 *   // Second write is a no-op
 *   const second = yield* TxDeferred.succeed(deferred, 99)
 *   console.log(second) // false
 *
 *   // Read the value
 *   const value = yield* TxDeferred.await(deferred)
 *   console.log(value) // 42
 * })
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export interface TxDeferred<in out A, in out E = never> extends Inspectable, Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly ref: TxRef.TxRef<Option<Result<A, E>>>
}

const TxDeferredProto: Omit<TxDeferred<unknown, unknown>, typeof TypeId | "ref"> = {
  [NodeInspectSymbol](this: TxDeferred<unknown, unknown>) {
    return toJson(this)
  },
  toJSON(this: TxDeferred<unknown, unknown>) {
    return {
      _id: "TxDeferred"
    }
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

const makeTxDeferred = <A, E>(ref: TxRef.TxRef<Option<Result<A, E>>>): TxDeferred<A, E> => {
  const self = Object.create(TxDeferredProto)
  self[TypeId] = TypeId
  self.ref = ref
  return self
}

/**
 * Creates a new empty `TxDeferred`.
 *
 * @example
 * ```ts
 * import { Effect, Option, TxDeferred } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* TxDeferred.make<string, Error>()
 *   const state = yield* TxDeferred.poll(deferred)
 *   console.log(Option.isNone(state)) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const make = <A, E = never>(): Effect.Effect<TxDeferred<A, E>> =>
  Effect.map(TxRef.make<Option<Result<A, E>>>(O.none()), makeTxDeferred)

/**
 * Reads the deferred value. Retries the transaction if the deferred has not
 * been completed yet.
 *
 * @example
 * ```ts
 * import { Effect, TxDeferred } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* TxDeferred.make<number>()
 *   yield* TxDeferred.succeed(deferred, 42)
 *   const value = yield* TxDeferred.await(deferred)
 *   console.log(value) // 42
 * })
 * ```
 *
 * @since 4.0.0
 * @category getters
 */
const await_ = <A, E>(self: TxDeferred<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function*() {
    const option = yield* TxRef.get(self.ref)
    if (O.isNone(option)) {
      return yield* Effect.txRetry
    }
    return Res.isSuccess(option.value)
      ? option.value.success
      : yield* Effect.fail(option.value.failure)
  }).pipe(Effect.tx)

export {
  /**
   * Reads the deferred value. Retries the transaction if the deferred has not
   * been completed yet.
   *
   * @since 4.0.0
   * @category getters
   */
  await_ as await
}

/**
 * Reads the current state of the deferred without retrying. Returns `None` if
 * not yet completed.
 *
 * @example
 * ```ts
 * import { Effect, Option, Result, TxDeferred } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* TxDeferred.make<number>()
 *   const before = yield* TxDeferred.poll(deferred)
 *   console.log(Option.isNone(before)) // true
 *
 *   yield* TxDeferred.succeed(deferred, 42)
 *   const after = yield* TxDeferred.poll(deferred)
 *   console.log(after) // Some(Success(42))
 * })
 * ```
 *
 * @since 4.0.0
 * @category getters
 */
export const poll = <A, E>(self: TxDeferred<A, E>): Effect.Effect<Option<Result<A, E>>> => TxRef.get(self.ref)

/**
 * Completes the deferred with a `Result`. Returns `true` if this was the first
 * completion, `false` if already completed.
 *
 * @example
 * ```ts
 * import { Effect, Result, TxDeferred } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* TxDeferred.make<number, string>()
 *   const first = yield* TxDeferred.done(deferred, Result.succeed(42))
 *   console.log(first) // true
 *   const second = yield* TxDeferred.done(deferred, Result.succeed(99))
 *   console.log(second) // false
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const done: {
  <A, E>(result: Result<A, E>): (self: TxDeferred<A, E>) => Effect.Effect<boolean>
  <A, E>(self: TxDeferred<A, E>, result: Result<A, E>): Effect.Effect<boolean>
} = dual(
  2,
  <A, E>(self: TxDeferred<A, E>, result: Result<A, E>): Effect.Effect<boolean> =>
    TxRef.modify(self.ref, (current) => {
      if (O.isSome(current)) {
        return [false, current]
      }
      return [true, O.some(result)]
    })
)

/**
 * Completes the deferred with a success value. Returns `true` if this was the
 * first completion, `false` if already completed.
 *
 * @example
 * ```ts
 * import { Effect, TxDeferred } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* TxDeferred.make<number>()
 *   const first = yield* TxDeferred.succeed(deferred, 42)
 *   console.log(first) // true
 *   const second = yield* TxDeferred.succeed(deferred, 99)
 *   console.log(second) // false
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const succeed: {
  <A>(value: A): <E>(self: TxDeferred<A, E>) => Effect.Effect<boolean>
  <A, E>(self: TxDeferred<A, E>, value: A): Effect.Effect<boolean>
} = dual(
  2,
  <A, E>(self: TxDeferred<A, E>, value: A): Effect.Effect<boolean> => done(self, Res.succeed(value))
)

/**
 * Completes the deferred with a failure. Returns `true` if this was the first
 * completion, `false` if already completed.
 *
 * @example
 * ```ts
 * import { Effect, TxDeferred } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* TxDeferred.make<number, string>()
 *   const first = yield* TxDeferred.fail(deferred, "boom")
 *   console.log(first) // true
 *   const second = yield* TxDeferred.fail(deferred, "boom2")
 *   console.log(second) // false
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const fail: {
  <E>(error: E): <A>(self: TxDeferred<A, E>) => Effect.Effect<boolean>
  <A, E>(self: TxDeferred<A, E>, error: E): Effect.Effect<boolean>
} = dual(
  2,
  <A, E>(self: TxDeferred<A, E>, error: E): Effect.Effect<boolean> => done(self, Res.fail(error))
)

/**
 * Determines if the provided value is a `TxDeferred`.
 *
 * @example
 * ```ts
 * import { Effect, TxDeferred } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const deferred = yield* TxDeferred.make<number>()
 *   console.log(TxDeferred.isTxDeferred(deferred)) // true
 *   console.log(TxDeferred.isTxDeferred("not a deferred")) // false
 * })
 * ```
 *
 * @since 4.0.0
 * @category guards
 */
export const isTxDeferred = (u: unknown): u is TxDeferred<unknown, unknown> => hasProperty(u, TypeId)

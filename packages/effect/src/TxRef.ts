/**
 * TxRef is a transactional value, it can be read and modified within the body of a transaction.
 *
 * Accessed values are tracked by the transaction in order to detect conflicts and in order to
 * track changes, a transaction will retry whenever a conflict is detected or whenever the
 * transaction explicitely calls to `Effect.retryTransaction` and any of the accessed TxRef values
 * change.
 *
 * @since 4.0.0
 */
import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import { pipeArguments } from "./Pipeable.ts"
import type { Pipeable } from "./Pipeable.ts"
import type { NoInfer } from "./Types.ts"

const TypeId = "~effect/transactions/TxRef"

/**
 * TxRef is a transactional value, it can be read and modified within the body of a transaction.
 *
 * Accessed values are tracked by the transaction in order to detect conflicts and in order to
 * track changes, a transaction will retry whenever a conflict is detected or whenever the
 * transaction explicitely calls to `Effect.retryTransaction` and any of the accessed TxRef values
 * change.
 *
 * @since 4.0.0
 * @category Models
 * @example
 * ```ts
 * import { Effect, TxRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a transactional reference
 *   const ref: TxRef.TxRef<number> = yield* TxRef.make(0)
 *
 *   // Use within a transaction
 *   yield* Effect.transaction(Effect.gen(function*() {
 *     const current = yield* TxRef.get(ref)
 *     yield* TxRef.set(ref, current + 1)
 *   }))
 *
 *   const final = yield* Effect.transaction(TxRef.get(ref))
 *   console.log(final) // 1
 * })
 * ```
 */
export interface TxRef<in out A> extends Pipeable {
  readonly [TypeId]: typeof TypeId

  version: number
  pending: Map<unknown, () => void>
  value: A
}

/**
 * Creates a new `TxRef` with the specified initial value.
 *
 * @since 4.0.0
 * @category Constructors
 * @example
 * ```ts
 * import { Effect, TxRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a transactional reference with initial value
 *   const counter = yield* Effect.transaction(TxRef.make(0))
 *   const name = yield* Effect.transaction(TxRef.make("Alice"))
 *
 *   // Use in transactions
 *   yield* Effect.transaction(Effect.gen(function*() {
 *     yield* TxRef.set(counter, 42)
 *     yield* TxRef.set(name, "Bob")
 *   }))
 *
 *   console.log(yield* Effect.transaction(TxRef.get(counter))) // 42
 *   console.log(yield* Effect.transaction(TxRef.get(name))) // "Bob"
 * })
 * ```
 */
export const make = <A>(initial: A) =>
  Effect.withTxState((state) =>
    Effect.sync(() => {
      const ref = makeUnsafe(initial)
      state.journal.set(ref, { version: ref.version, value: ref.value })
      return ref
    })
  )

/**
 * Creates a new `TxRef` with the specified initial value.
 *
 * @since 4.0.0
 * @category Constructors
 * @example
 * ```ts
 * import { TxRef } from "effect"
 *
 * // Create a TxRef synchronously (unsafe - use make instead in Effect contexts)
 * const counter = TxRef.makeUnsafe(0)
 * const config = TxRef.makeUnsafe({ timeout: 5000, retries: 3 })
 *
 * // These are now ready to use in transactions
 * console.log(counter.value) // 0
 * console.log(config.value) // { timeout: 5000, retries: 3 }
 * ```
 */
export const makeUnsafe = <A>(initial: A): TxRef<A> => ({
  [TypeId]: TypeId,
  pending: new Map(),
  pipe() {
    return pipeArguments(this, arguments)
  },
  version: 0,
  value: initial
})

/**
 * Modifies the value of the `TxRef` using the provided function.
 *
 * @since 4.0.0
 * @category Combinators
 * @example
 * ```ts
 * import { Effect, TxRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* TxRef.make(0)
 *
 *   // Modify and return both old and new value
 *   const result = yield* Effect.transaction(
 *     TxRef.modify(counter, (current) => [current * 2, current + 1])
 *   )
 *
 *   console.log(result) // 0 (the return value: current * 2)
 *   console.log(yield* Effect.transaction(TxRef.get(counter))) // 1 (the new value: current + 1)
 * })
 * ```
 */
export const modify: {
  <A, R>(
    f: (current: NoInfer<A>) => [returnValue: R, newValue: A]
  ): (self: TxRef<A>) => Effect.Effect<R, never, Effect.Transaction>
  <A, R>(self: TxRef<A>, f: (current: A) => [returnValue: R, newValue: A]): Effect.Effect<R, never, Effect.Transaction>
} = dual(
  2,
  <A, R>(
    self: TxRef<A>,
    f: (current: A) => [returnValue: R, newValue: A]
  ): Effect.Effect<R, never, Effect.Transaction> =>
    Effect.withTxState((state) =>
      Effect.sync(() => {
        if (!state.journal.has(self)) {
          state.journal.set(self, { version: self.version, value: self.value })
        }
        const current = state.journal.get(self)!
        const [returnValue, next] = f(current.value)
        current.value = next
        return returnValue
      })
    )
)

/**
 * Updates the value of the `TxRef` using the provided function.
 *
 * @since 4.0.0
 * @category Combinators
 * @example
 * ```ts
 * import { Effect, TxRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* TxRef.make(10)
 *
 *   // Update the value using a function
 *   yield* Effect.transaction(
 *     TxRef.update(counter, (current) => current * 2)
 *   )
 *
 *   console.log(yield* Effect.transaction(TxRef.get(counter))) // 20
 * })
 * ```
 */
export const update: {
  <A>(f: (current: NoInfer<A>) => A): (self: TxRef<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A>(self: TxRef<A>, f: (current: A) => A): Effect.Effect<void, never, Effect.Transaction>
} = dual(
  2,
  <A>(self: TxRef<A>, f: (current: A) => A): Effect.Effect<void, never, Effect.Transaction> =>
    modify(self, (current) => [void 0, f(current)])
)

/**
 * Reads the current value of the `TxRef`.
 *
 * @since 4.0.0
 * @category Combinators
 * @example
 * ```ts
 * import { Effect, TxRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* TxRef.make(42)
 *
 *   // Read the value within a transaction
 *   const value = yield* Effect.transaction(
 *     TxRef.get(counter)
 *   )
 *
 *   console.log(value) // 42
 * })
 * ```
 */
export const get = <A>(self: TxRef<A>): Effect.Effect<A, never, Effect.Transaction> =>
  modify(self, (current) => [current, current])

/**
 * Sets the value of the `TxRef`.
 *
 * @since 4.0.0
 * @category Combinators
 * @example
 * ```ts
 * import { Effect, TxRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* TxRef.make(0)
 *
 *   // Set a new value within a transaction
 *   yield* Effect.transaction(
 *     TxRef.set(counter, 100)
 *   )
 *
 *   console.log(yield* Effect.transaction(TxRef.get(counter))) // 100
 * })
 * ```
 */
export const set: {
  <A>(value: A): (self: TxRef<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A>(self: TxRef<A>, value: A): Effect.Effect<void, never, Effect.Transaction>
} = dual(2, <A>(self: TxRef<A>, value: A): Effect.Effect<void, never, Effect.Transaction> => update(self, () => value))

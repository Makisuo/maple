/**
 * TxChunk is a transactional chunk data structure that provides Software Transactional Memory (STM)
 * semantics for chunk operations. It uses a `TxRef<Chunk<A>>` internally to ensure all operations
 * are performed atomically within transactions.
 *
 * Accessed values are tracked by the transaction in order to detect conflicts and to track changes.
 * A transaction will retry whenever a conflict is detected or whenever the transaction explicitly
 * calls `Effect.retryTransaction` and any of the accessed TxChunk values change.
 *
 * @since 4.0.0
 */
import * as Chunk from "./Chunk.ts"
import * as Effect from "./Effect.ts"
import { format } from "./Formatter.ts"
import { dual } from "./Function.ts"
import type { Inspectable } from "./Inspectable.ts"
import { NodeInspectSymbol, toJson } from "./Inspectable.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import * as TxRef from "./TxRef.ts"
import type { NoInfer } from "./Types.ts"

const TypeId = "~effect/transactions/TxChunk"

/**
 * TxChunk is a transactional chunk data structure that provides Software Transactional Memory (STM)
 * semantics for chunk operations.
 *
 * Accessed values are tracked by the transaction in order to detect conflicts and to track changes.
 * A transaction will retry whenever a conflict is detected or whenever the transaction explicitly
 * calls `Effect.retryTransaction` and any of the accessed TxChunk values change.
 *
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a transactional chunk
 *   const txChunk: TxChunk.TxChunk<number> = yield* TxChunk.fromIterable([
 *     1,
 *     2,
 *     3
 *   ])
 *
 *   // Single operations - no explicit transaction needed
 *   yield* TxChunk.append(txChunk, 4)
 *   const result = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(result)) // [1, 2, 3, 4]
 *
 *   // Multi-step atomic operation - use explicit transaction
 *   yield* Effect.transaction(
 *     Effect.gen(function*() {
 *       yield* TxChunk.prepend(txChunk, 0)
 *       yield* TxChunk.append(txChunk, 5)
 *     })
 *   )
 *
 *   const finalResult = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(finalResult)) // [0, 1, 2, 3, 4, 5]
 * })
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export interface TxChunk<in out A> extends Inspectable, Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly ref: TxRef.TxRef<Chunk.Chunk<A>>
}

const TxChunkProto = {
  [NodeInspectSymbol](this: TxChunk<unknown>) {
    return this.toJSON()
  },
  toString(this: TxChunk<unknown>) {
    return `TxChunk(${format(toJson((this).ref))})`
  },
  toJSON(this: TxChunk<unknown>) {
    return {
      _id: "TxChunk",
      ref: toJson((this).ref)
    }
  },
  pipe(this: TxChunk<unknown>) {
    return pipeArguments(this, arguments)
  }
}

/**
 * Creates a new `TxChunk` with the specified initial chunk.
 *
 * **Return behavior**: This function returns a new TxChunk reference containing
 * the provided initial chunk. No existing TxChunk instances are modified.
 *
 * @since 4.0.0
 * @category Constructors
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a TxChunk with initial values
 *   const initialChunk = Chunk.fromIterable([1, 2, 3])
 *   const txChunk = yield* TxChunk.make(initialChunk)
 *
 *   // Read the value - automatically transactional
 *   const result = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(result)) // [1, 2, 3]
 * })
 * ```
 */
export const make = <A>(initial: Chunk.Chunk<A>): Effect.Effect<TxChunk<A>, never, Effect.Transaction> =>
  Effect.map(TxRef.make(initial), (ref) => makeUnsafe(ref))

/**
 * Creates a new empty `TxChunk`.
 *
 * **Return behavior**: This function returns a new TxChunk reference that is
 * initially empty. No existing TxChunk instances are modified.
 *
 * @since 4.0.0
 * @category Constructors
 * @example
 * ```ts
 * import { Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create an empty TxChunk
 *   const txChunk = yield* TxChunk.empty<number>()
 *
 *   // Check if it's empty - automatically transactional
 *   const isEmpty = yield* TxChunk.isEmpty(txChunk)
 *   console.log(isEmpty) // true
 *
 *   // Add elements - automatically transactional
 *   yield* TxChunk.append(txChunk, 42)
 *
 *   const isStillEmpty = yield* TxChunk.isEmpty(txChunk)
 *   console.log(isStillEmpty) // false
 * })
 * ```
 */
export const empty = <A = never>(): Effect.Effect<TxChunk<A>, never, Effect.Transaction> =>
  Effect.map(TxRef.make(Chunk.empty<A>()), (ref) => makeUnsafe(ref))

/**
 * Creates a new `TxChunk` from an iterable.
 *
 * **Return behavior**: This function returns a new TxChunk reference containing
 * elements from the provided iterable. No existing TxChunk instances are modified.
 *
 * @since 4.0.0
 * @category Constructors
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create TxChunk from array
 *   const txChunk = yield* TxChunk.fromIterable([1, 2, 3, 4, 5])
 *
 *   // Read the contents - automatically transactional
 *   const chunk = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(chunk)) // [1, 2, 3, 4, 5]
 *
 *   // Multi-step atomic modification - use explicit transaction
 *   yield* Effect.transaction(
 *     Effect.gen(function*() {
 *       yield* TxChunk.append(txChunk, 6)
 *       yield* TxChunk.prepend(txChunk, 0)
 *     })
 *   )
 *
 *   const updated = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(updated)) // [0, 1, 2, 3, 4, 5, 6]
 * })
 * ```
 */
export const fromIterable = <A>(iterable: Iterable<A>): Effect.Effect<TxChunk<A>, never, Effect.Transaction> =>
  Effect.map(TxRef.make(Chunk.fromIterable(iterable)), (ref) => makeUnsafe(ref))

/**
 * Creates a new `TxChunk` with the specified TxRef.
 *
 * **Return behavior**: This function returns a new TxChunk reference wrapping
 * the provided TxRef. No existing TxChunk instances are modified.
 *
 * @example
 * ```ts
 * import { Chunk, TxChunk, TxRef } from "effect"
 *
 * // Create a TxChunk from an existing TxRef (advanced usage)
 * const ref = TxRef.makeUnsafe(Chunk.fromIterable([1, 2, 3]))
 * const txChunk = TxChunk.makeUnsafe(ref)
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const makeUnsafe = <A>(ref: TxRef.TxRef<Chunk.Chunk<A>>): TxChunk<A> => {
  const txChunk = Object.create(TxChunkProto)
  txChunk[TypeId] = TypeId
  txChunk.ref = ref
  return txChunk
}

/**
 * Modifies the value of the `TxChunk` using the provided function.
 *
 * **Mutation behavior**: This function mutates the original TxChunk by updating
 * its internal state. It does not return a new TxChunk reference.
 *
 * @since 4.0.0
 * @category Combinators
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk = yield* TxChunk.fromIterable([1, 2, 3])
 *
 *   // Modify and return both old size and new chunk
 *   const oldSize = yield* TxChunk.modify(txChunk, (chunk) => [
 *     Chunk.size(chunk), // return value (old size)
 *     Chunk.append(chunk, 4) // new value
 *   ])
 *
 *   console.log(oldSize) // 3
 *
 *   const newChunk = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(newChunk)) // [1, 2, 3, 4]
 * })
 * ```
 */
export const modify: {
  <A, R>(f: (current: Chunk.Chunk<NoInfer<A>>) => [returnValue: R, newValue: Chunk.Chunk<A>]): (
    self: TxChunk<A>
  ) => Effect.Effect<R, never, Effect.Transaction>
  <A, R>(
    self: TxChunk<A>,
    f: (current: Chunk.Chunk<A>) => [returnValue: R, newValue: Chunk.Chunk<A>]
  ): Effect.Effect<R, never, Effect.Transaction>
} = dual(
  2,
  <A, R>(
    self: TxChunk<A>,
    f: (current: Chunk.Chunk<A>) => [returnValue: R, newValue: Chunk.Chunk<A>]
  ): Effect.Effect<R, never, Effect.Transaction> => TxRef.modify(self.ref, f)
)

/**
 * Updates the value of the `TxChunk` using the provided function.
 *
 * **Mutation behavior**: This function mutates the original TxChunk by updating
 * its internal state. It does not return a new TxChunk reference.
 *
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk = yield* TxChunk.fromIterable([1, 2, 3])
 *
 *   // Update the chunk by reversing it
 *   // Update the chunk by reversing it - automatically transactional
 *   yield* TxChunk.update(txChunk, (chunk) => Chunk.reverse(chunk))
 *
 *   const result = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(result)) // [3, 2, 1]
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const update: {
  <A>(
    f: (current: Chunk.Chunk<NoInfer<A>>) => Chunk.Chunk<A>
  ): (self: TxChunk<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A>(self: TxChunk<A>, f: (current: Chunk.Chunk<A>) => Chunk.Chunk<A>): Effect.Effect<void, never, Effect.Transaction>
} = dual(
  2,
  <A>(
    self: TxChunk<A>,
    f: (current: Chunk.Chunk<A>) => Chunk.Chunk<A>
  ): Effect.Effect<void, never, Effect.Transaction> => TxRef.update(self.ref, f)
)

/**
 * Reads the current chunk from the `TxChunk`.
 *
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk = yield* TxChunk.fromIterable([1, 2, 3])
 *
 *   // Read the current value within a transaction
 *   const chunk = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(chunk)) // [1, 2, 3]
 *
 *   // The value is tracked for conflict detection
 *   const size = Chunk.size(chunk)
 *   console.log(size) // 3
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const get = <A>(self: TxChunk<A>): Effect.Effect<Chunk.Chunk<A>, never, Effect.Transaction> =>
  TxRef.get(self.ref)

/**
 * Sets the value of the `TxChunk`.
 *
 * **Mutation behavior**: This function mutates the original TxChunk by replacing
 * its internal state with the provided chunk. It does not return a new TxChunk reference.
 *
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk = yield* TxChunk.fromIterable([1, 2, 3])
 *
 *   // Replace the entire chunk content
 *   const newChunk = Chunk.fromIterable([10, 20, 30, 40])
 *   yield* TxChunk.set(txChunk, newChunk)
 *
 *   const result = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(result)) // [10, 20, 30, 40]
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const set: {
  <A>(chunk: Chunk.Chunk<A>): (self: TxChunk<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A>(self: TxChunk<A>, chunk: Chunk.Chunk<A>): Effect.Effect<void, never, Effect.Transaction>
} = dual(
  2,
  <A>(self: TxChunk<A>, chunk: Chunk.Chunk<A>): Effect.Effect<void, never, Effect.Transaction> =>
    TxRef.set(self.ref, chunk)
)

/**
 * Appends an element to the end of the `TxChunk`.
 *
 * **Mutation behavior**: This function mutates the original TxChunk by adding
 * the element to the end. It does not return a new TxChunk reference.
 *
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk = yield* TxChunk.fromIterable([1, 2, 3])
 *
 *   // Add element to the end atomically
 *   yield* TxChunk.append(txChunk, 4)
 *
 *   const result = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(result)) // [1, 2, 3, 4]
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const append: {
  <A>(element: A): (self: TxChunk<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A>(self: TxChunk<A>, element: A): Effect.Effect<void, never, Effect.Transaction>
} = dual(
  2,
  <A>(self: TxChunk<A>, element: A): Effect.Effect<void, never, Effect.Transaction> =>
    update(self, (current) => Chunk.append(current, element))
)

/**
 * Prepends an element to the beginning of the `TxChunk`.
 *
 * **Mutation behavior**: This function mutates the original TxChunk by adding
 * the element to the beginning. It does not return a new TxChunk reference.
 *
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk = yield* TxChunk.fromIterable([2, 3, 4])
 *
 *   // Add element to the beginning atomically
 *   yield* TxChunk.prepend(txChunk, 1)
 *
 *   const result = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(result)) // [1, 2, 3, 4]
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const prepend: {
  <A>(element: A): (self: TxChunk<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A>(self: TxChunk<A>, element: A): Effect.Effect<void, never, Effect.Transaction>
} = dual(
  2,
  <A>(self: TxChunk<A>, element: A): Effect.Effect<void, never, Effect.Transaction> =>
    update(self, (current) => Chunk.prepend(current, element))
)

/**
 * Gets the size of the `TxChunk`.
 *
 * @example
 * ```ts
 * import { Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk = yield* TxChunk.fromIterable([1, 2, 3, 4, 5])
 *
 *   // Get the current size - automatically transactional
 *   const currentSize = yield* TxChunk.size(txChunk)
 *   console.log(currentSize) // 5
 *
 *   // Size is tracked for conflict detection
 *   yield* TxChunk.append(txChunk, 6)
 *   const newSize = yield* TxChunk.size(txChunk)
 *   console.log(newSize) // 6
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const size = <A>(self: TxChunk<A>): Effect.Effect<number, never, Effect.Transaction> =>
  modify(self, (current) => [Chunk.size(current), current])

/**
 * Checks if the `TxChunk` is empty.
 *
 * @example
 * ```ts
 * import { Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const emptyChunk = yield* TxChunk.empty<number>()
 *   const nonEmptyChunk = yield* TxChunk.fromIterable([1, 2, 3])
 *
 *   // Check if chunks are empty - automatically transactional
 *   const isEmpty1 = yield* TxChunk.isEmpty(emptyChunk)
 *   const isEmpty2 = yield* TxChunk.isEmpty(nonEmptyChunk)
 *
 *   console.log(isEmpty1) // true
 *   console.log(isEmpty2) // false
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const isEmpty = <A>(self: TxChunk<A>): Effect.Effect<boolean, never, Effect.Transaction> =>
  modify(self, (current) => [Chunk.isEmpty(current), current])

/**
 * Checks if the `TxChunk` is non-empty.
 *
 * @example
 * ```ts
 * import { Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const emptyChunk = yield* TxChunk.empty<number>()
 *   const nonEmptyChunk = yield* TxChunk.fromIterable([1, 2, 3])
 *
 *   // Check if chunks are non-empty - automatically transactional
 *   const isNonEmpty1 = yield* TxChunk.isNonEmpty(emptyChunk)
 *   const isNonEmpty2 = yield* TxChunk.isNonEmpty(nonEmptyChunk)
 *
 *   console.log(isNonEmpty1) // false
 *   console.log(isNonEmpty2) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const isNonEmpty = <A>(self: TxChunk<A>): Effect.Effect<boolean, never, Effect.Transaction> =>
  modify(self, (current) => [Chunk.isNonEmpty(current), current])

/**
 * Takes the first `n` elements from the `TxChunk`.
 *
 * **Mutation behavior**: This function mutates the original TxChunk by keeping
 * only the first n elements. It does not return a new TxChunk reference.
 *
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk = yield* TxChunk.fromIterable([1, 2, 3, 4, 5])
 *
 *   // Take only the first 3 elements - automatically transactional
 *   yield* TxChunk.take(txChunk, 3)
 *
 *   const result = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(result)) // [1, 2, 3]
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const take: {
  (n: number): <A>(self: TxChunk<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A>(self: TxChunk<A>, n: number): Effect.Effect<void, never, Effect.Transaction>
} = dual(
  2,
  <A>(self: TxChunk<A>, n: number): Effect.Effect<void, never, Effect.Transaction> =>
    update(self, (current) => Chunk.take(current, n))
)

/**
 * Drops the first `n` elements from the `TxChunk`.
 *
 * **Mutation behavior**: This function mutates the original TxChunk by removing
 * the first n elements. It does not return a new TxChunk reference.
 *
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk = yield* TxChunk.fromIterable([1, 2, 3, 4, 5])
 *
 *   // Drop the first 2 elements - automatically transactional
 *   yield* TxChunk.drop(txChunk, 2)
 *
 *   const result = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(result)) // [3, 4, 5]
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const drop: {
  (n: number): <A>(self: TxChunk<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A>(self: TxChunk<A>, n: number): Effect.Effect<void, never, Effect.Transaction>
} = dual(
  2,
  <A>(self: TxChunk<A>, n: number): Effect.Effect<void, never, Effect.Transaction> =>
    update(self, (current) => Chunk.drop(current, n))
)

/**
 * Takes a slice of the `TxChunk` from `start` to `end` (exclusive).
 *
 * **Mutation behavior**: This function mutates the original TxChunk by keeping
 * only the elements in the specified range. It does not return a new TxChunk reference.
 *
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk = yield* TxChunk.fromIterable([1, 2, 3, 4, 5, 6, 7])
 *
 *   // Take elements from index 2 to 5 (exclusive) - automatically transactional
 *   yield* TxChunk.slice(txChunk, 2, 5)
 *
 *   const result = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(result)) // [3, 4, 5]
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const slice: {
  (start: number, end: number): <A>(self: TxChunk<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A>(self: TxChunk<A>, start: number, end: number): Effect.Effect<void, never, Effect.Transaction>
} = dual(
  3,
  <A>(self: TxChunk<A>, start: number, end: number): Effect.Effect<void, never, Effect.Transaction> =>
    update(self, (current) => Chunk.take(Chunk.drop(current, start), end - start))
)

/**
 * Maps each element of the `TxChunk` using the provided function.
 * Note: This only works when the mapped type B is assignable to A.
 *
 * **Mutation behavior**: This function mutates the original TxChunk by transforming
 * each element in place. It does not return a new TxChunk reference.
 *
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk = yield* TxChunk.fromIterable([1, 2, 3, 4])
 *
 *   // Transform each element (must maintain same type)
 *   // Transform each element (must maintain same type) - automatically transactional
 *   yield* TxChunk.map(txChunk, (n) => n * 2)
 *
 *   const result = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(result)) // [2, 4, 6, 8]
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const map: {
  <A>(f: (a: NoInfer<A>) => A): (self: TxChunk<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A>(self: TxChunk<A>, f: (a: A) => A): Effect.Effect<void, never, Effect.Transaction>
} = dual(
  2,
  <A>(self: TxChunk<A>, f: (a: A) => A): Effect.Effect<void, never, Effect.Transaction> =>
    update(self, (current) => Chunk.map(current, f))
)

/**
 * Filters the `TxChunk` keeping only elements that satisfy the predicate.
 *
 * **Mutation behavior**: This function mutates the original TxChunk by removing
 * elements that don't match the predicate. It does not return a new TxChunk reference.
 *
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk = yield* TxChunk.fromIterable([1, 2, 3, 4, 5, 6])
 *
 *   // Keep only even numbers
 *   // Keep only even numbers - automatically transactional
 *   yield* TxChunk.filter(txChunk, (n) => n % 2 === 0)
 *
 *   const result = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(result)) // [2, 4, 6]
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const filter: {
  <A, B extends A>(refinement: (a: A) => a is B): (self: TxChunk<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A>(predicate: (a: A) => boolean): (self: TxChunk<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A, B extends A>(self: TxChunk<A>, refinement: (a: A) => a is B): Effect.Effect<void, never, Effect.Transaction>
  <A>(self: TxChunk<A>, predicate: (a: A) => boolean): Effect.Effect<void, never, Effect.Transaction>
} = dual(
  2,
  <A>(self: TxChunk<A>, predicate: (a: A) => boolean): Effect.Effect<void, never, Effect.Transaction> =>
    update(self, (current) => Chunk.filter(current, predicate))
)

/**
 * Concatenates another chunk to the end of the `TxChunk`.
 *
 * **Mutation behavior**: This function mutates the original TxChunk by appending
 * all elements from the other chunk. It does not return a new TxChunk reference.
 *
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk = yield* TxChunk.fromIterable([1, 2, 3])
 *   const otherChunk = Chunk.fromIterable([4, 5, 6])
 *
 *   // Append all elements from another chunk
 *   // Append all elements from another chunk - automatically transactional
 *   yield* TxChunk.appendAll(txChunk, otherChunk)
 *
 *   const result = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(result)) // [1, 2, 3, 4, 5, 6]
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const appendAll: {
  <A>(other: Chunk.Chunk<A>): (self: TxChunk<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A>(self: TxChunk<A>, other: Chunk.Chunk<A>): Effect.Effect<void, never, Effect.Transaction>
} = dual(
  2,
  <A>(self: TxChunk<A>, other: Chunk.Chunk<A>): Effect.Effect<void, never, Effect.Transaction> =>
    update(self, (current) => Chunk.appendAll(current, other))
)

/**
 * Concatenates another chunk to the beginning of the `TxChunk`.
 *
 * **Mutation behavior**: This function mutates the original TxChunk by prepending
 * all elements from the other chunk. It does not return a new TxChunk reference.
 *
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk = yield* TxChunk.fromIterable([4, 5, 6])
 *   const otherChunk = Chunk.fromIterable([1, 2, 3])
 *
 *   // Prepend all elements from another chunk
 *   // Prepend all elements from another chunk - automatically transactional
 *   yield* TxChunk.prependAll(txChunk, otherChunk)
 *
 *   const result = yield* TxChunk.get(txChunk)
 *   console.log(Chunk.toReadonlyArray(result)) // [1, 2, 3, 4, 5, 6]
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const prependAll: {
  <A>(other: Chunk.Chunk<A>): (self: TxChunk<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A>(self: TxChunk<A>, other: Chunk.Chunk<A>): Effect.Effect<void, never, Effect.Transaction>
} = dual(
  2,
  <A>(self: TxChunk<A>, other: Chunk.Chunk<A>): Effect.Effect<void, never, Effect.Transaction> =>
    update(self, (current) => Chunk.prependAll(current, other))
)

/**
 * Concatenates another `TxChunk` to the end of this `TxChunk`.
 *
 * **Mutation behavior**: This function mutates the original TxChunk by appending
 * all elements from the other TxChunk. It does not return a new TxChunk reference.
 *
 * @since 4.0.0
 * @category Combinators
 * @example
 * ```ts
 * import { Chunk, Effect, TxChunk } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txChunk1 = yield* TxChunk.fromIterable([1, 2, 3])
 *   const txChunk2 = yield* TxChunk.fromIterable([4, 5, 6])
 *
 *   // Concatenate atomically within a transaction
 *   yield* TxChunk.concat(txChunk1, txChunk2)
 *
 *   const result = yield* TxChunk.get(txChunk1)
 *   console.log(Chunk.toReadonlyArray(result)) // [1, 2, 3, 4, 5, 6]
 *
 *   // Original txChunk2 is unchanged
 *   const original = yield* TxChunk.get(txChunk2)
 *   console.log(Chunk.toReadonlyArray(original)) // [4, 5, 6]
 * })
 * ```
 */
export const concat: {
  <A>(other: TxChunk<A>): (self: TxChunk<A>) => Effect.Effect<void, never, Effect.Transaction>
  <A>(self: TxChunk<A>, other: TxChunk<A>): Effect.Effect<void, never, Effect.Transaction>
} = dual(
  2,
  <A>(self: TxChunk<A>, other: TxChunk<A>): Effect.Effect<void, never, Effect.Transaction> =>
    Effect.gen(function*() {
      const otherChunk = yield* get(other)
      yield* appendAll(self, otherChunk)
    })
)

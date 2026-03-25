/**
 * @since 2.0.0
 */

import * as Effect from "./Effect.ts"
import { format } from "./Formatter.ts"
import { dual } from "./Function.ts"
import * as HashSet from "./HashSet.ts"
import type { Inspectable } from "./Inspectable.ts"
import { NodeInspectSymbol, toJson } from "./Inspectable.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty, type Predicate, type Refinement } from "./Predicate.ts"
import * as TxRef from "./TxRef.ts"
import type { NoInfer } from "./Types.ts"

const TypeId = "~effect/transactions/TxHashSet"

const TxHashSetProto = {
  [TypeId]: TypeId,
  [NodeInspectSymbol](this: TxHashSet<unknown>) {
    return toJson(this)
  },
  toString(this: TxHashSet<unknown>) {
    return `TxHashSet(${format(toJson((this).ref))})`
  },
  toJSON(this: TxHashSet<unknown>) {
    return {
      _id: "TxHashSet",
      ref: toJson((this).ref)
    }
  },
  pipe(this: TxHashSet<unknown>) {
    return pipeArguments(this, arguments)
  }
}

/**
 * A TxHashSet is a transactional hash set data structure that provides atomic operations
 * on unique values within Effect transactions. It uses an immutable HashSet internally
 * with TxRef for transactional semantics, ensuring all operations are performed atomically.
 *
 * ## Mutation vs Return Behavior
 *
 * **Mutation operations** (add, remove, clear) modify the original TxHashSet and return `Effect<void>` or `Effect<boolean>`:
 * - These operations mutate the TxHashSet in place
 * - They do not create new TxHashSet instances
 * - Examples: `add`, `remove`, `clear`
 *
 * **Transform operations** (union, intersection, difference, map, filter) create new TxHashSet instances:
 * - These operations return `Effect<TxHashSet<T>>` with a new instance
 * - The original TxHashSet remains unchanged
 * - Examples: `union`, `intersection`, `difference`, `map`, `filter`
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a transactional hash set
 *   const txSet = yield* TxHashSet.make("apple", "banana", "cherry")
 *
 *   // Single operations are automatically transactional
 *   yield* TxHashSet.add(txSet, "grape")
 *   const hasApple = yield* TxHashSet.has(txSet, "apple")
 *   console.log(hasApple) // true
 *
 *   // Multi-step atomic operations
 *   yield* Effect.transaction(
 *     Effect.gen(function*() {
 *       const hasCherry = yield* TxHashSet.has(txSet, "cherry")
 *       if (hasCherry) {
 *         yield* TxHashSet.remove(txSet, "cherry")
 *         yield* TxHashSet.add(txSet, "orange")
 *       }
 *     })
 *   )
 *
 *   const size = yield* TxHashSet.size(txSet)
 *   console.log(size) // 4
 * })
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface TxHashSet<in out V> extends Inspectable, Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly ref: TxRef.TxRef<HashSet.HashSet<V>>
}

/**
 * The TxHashSet namespace contains type-level utilities and helper types
 * for working with TxHashSet instances.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a transactional color set
 *   const colors = yield* TxHashSet.make("red", "green", "blue")
 *
 *   // Extract the value type for reuse
 *   type Color = TxHashSet.TxHashSet.Value<typeof colors> // string
 *
 *   // Use extracted type in functions
 *   const addColor = (color: Color) => TxHashSet.add(colors, color)
 *
 *   yield* addColor("yellow")
 * })
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export declare namespace TxHashSet {
  /**
   * @example
   * ```ts
   * import { TxHashSet } from "effect"
   *
   * const fruits = TxHashSet.make("apple", "banana", "cherry")
   *
   * // Extract the value type
   * type Fruit = TxHashSet.TxHashSet.Value<typeof fruits> // string
   *
   * const processFruit = (fruit: Fruit) => {
   *   return `Processing ${fruit}`
   * }
   * ```
   *
   * @since 2.0.0
   * @category type-level
   */
  export type Value<T> = T extends TxHashSet<infer V> ? V : never
}

const makeTxHashSet = <V>(ref: TxRef.TxRef<HashSet.HashSet<V>>): TxHashSet<V> => {
  const self = Object.create(TxHashSetProto)
  self.ref = ref
  return self
}

/**
 * Creates an empty TxHashSet.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txSet = yield* TxHashSet.empty<string>()
 *
 *   console.log(yield* TxHashSet.size(txSet)) // 0
 *   console.log(yield* TxHashSet.isEmpty(txSet)) // true
 *
 *   // Add some values
 *   yield* TxHashSet.add(txSet, "hello")
 *   yield* TxHashSet.add(txSet, "world")
 *   console.log(yield* TxHashSet.size(txSet)) // 2
 * })
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const empty = <V = never>(): Effect.Effect<TxHashSet<V>, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const ref = yield* TxRef.make(HashSet.empty<V>())
    return makeTxHashSet(ref)
  })

/**
 * Creates a TxHashSet from a variable number of values.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fruits = yield* TxHashSet.make("apple", "banana", "cherry")
 *   console.log(yield* TxHashSet.size(fruits)) // 3
 *
 *   const numbers = yield* TxHashSet.make(1, 2, 3, 2, 1) // Duplicates ignored
 *   console.log(yield* TxHashSet.size(numbers)) // 3
 *
 *   const mixed = yield* TxHashSet.make("hello", 42, true)
 *   console.log(yield* TxHashSet.size(mixed)) // 3
 * })
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const make = <Values extends ReadonlyArray<any>>(
  ...values: Values
): Effect.Effect<TxHashSet<Values[number]>, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const hashSet = HashSet.make(...values)
    const ref = yield* TxRef.make(hashSet)
    return makeTxHashSet(ref)
  })

/**
 * Creates a TxHashSet from an iterable collection of values.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fromArray = yield* TxHashSet.fromIterable(["a", "b", "c", "b", "a"])
 *   console.log(yield* TxHashSet.size(fromArray)) // 3
 *
 *   const fromSet = yield* TxHashSet.fromIterable(new Set([1, 2, 3]))
 *   console.log(yield* TxHashSet.size(fromSet)) // 3
 *
 *   const fromString = yield* TxHashSet.fromIterable("hello")
 *   const values = yield* TxHashSet.toHashSet(fromString)
 *   console.log(Array.from(values)) // ["h", "e", "l", "o"]
 * })
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const fromIterable = <V>(values: Iterable<V>): Effect.Effect<TxHashSet<V>, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const hashSet = HashSet.fromIterable(values)
    const ref = yield* TxRef.make(hashSet)
    return makeTxHashSet(ref)
  })

/**
 * Creates a TxHashSet from an existing HashSet.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 * import * as HashSet from "effect/HashSet"
 *
 * const program = Effect.gen(function*() {
 *   const hashSet = HashSet.make("x", "y", "z")
 *   const txSet = yield* TxHashSet.fromHashSet(hashSet)
 *
 *   console.log(yield* TxHashSet.size(txSet)) // 3
 *   console.log(yield* TxHashSet.has(txSet, "y")) // true
 *
 *   // Original hashSet is unchanged when txSet is modified
 *   yield* TxHashSet.add(txSet, "w")
 *   console.log(HashSet.size(hashSet)) // 3 (original unchanged)
 *   console.log(yield* TxHashSet.size(txSet)) // 4
 * })
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const fromHashSet = <V>(hashSet: HashSet.HashSet<V>): Effect.Effect<TxHashSet<V>, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const ref = yield* TxRef.make(hashSet)
    return makeTxHashSet(ref)
  })

/**
 * Checks if a value is a TxHashSet.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 * import * as HashSet from "effect/HashSet"
 *
 * const program = Effect.gen(function*() {
 *   const txSet = yield* TxHashSet.make(1, 2, 3)
 *   const hashSet = HashSet.make(1, 2, 3)
 *   const array = [1, 2, 3]
 *
 *   console.log(TxHashSet.isTxHashSet(txSet)) // true
 *   console.log(TxHashSet.isTxHashSet(hashSet)) // false
 *   console.log(TxHashSet.isTxHashSet(array)) // false
 *   console.log(TxHashSet.isTxHashSet(null)) // false
 * })
 * ```
 *
 * @since 2.0.0
 * @category guards
 */
export const isTxHashSet = (u: unknown): u is TxHashSet<unknown> => hasProperty(u, TypeId)

/**
 * Adds a value to the TxHashSet. If the value already exists, the operation has no effect.
 *
 * **Mutation behavior**: This function mutates the original TxHashSet by adding
 * the specified value. It does not return a new TxHashSet reference.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txSet = yield* TxHashSet.make("a", "b")
 *
 *   yield* TxHashSet.add(txSet, "c")
 *   console.log(yield* TxHashSet.size(txSet)) // 3
 *   console.log(yield* TxHashSet.has(txSet, "c")) // true
 *
 *   // Adding existing value has no effect
 *   yield* TxHashSet.add(txSet, "a")
 *   console.log(yield* TxHashSet.size(txSet)) // 3 (unchanged)
 * })
 * ```
 *
 * @since 2.0.0
 * @category mutations
 */
export const add: {
  <V>(value: V): (self: TxHashSet<V>) => Effect.Effect<void, never, Effect.Transaction>
  <V>(self: TxHashSet<V>, value: V): Effect.Effect<void, never, Effect.Transaction>
} = dual<
  <V>(value: V) => (self: TxHashSet<V>) => Effect.Effect<void, never, Effect.Transaction>,
  <V>(self: TxHashSet<V>, value: V) => Effect.Effect<void, never, Effect.Transaction>
>(2, <V>(self: TxHashSet<V>, value: V) => TxRef.update(self.ref, (set) => HashSet.add(set, value)))

/**
 * Removes a value from the TxHashSet.
 *
 * **Mutation behavior**: This function mutates the original TxHashSet by removing
 * the specified value. It does not return a new TxHashSet reference.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txSet = yield* TxHashSet.make("a", "b", "c")
 *
 *   const removed = yield* TxHashSet.remove(txSet, "b")
 *   console.log(removed) // true (value existed and was removed)
 *   console.log(yield* TxHashSet.size(txSet)) // 2
 *   console.log(yield* TxHashSet.has(txSet, "b")) // false
 *
 *   // Removing non-existent value returns false
 *   const notRemoved = yield* TxHashSet.remove(txSet, "d")
 *   console.log(notRemoved) // false
 * })
 * ```
 *
 * @since 2.0.0
 * @category mutations
 */
export const remove: {
  <V>(value: V): (self: TxHashSet<V>) => Effect.Effect<boolean, never, Effect.Transaction>
  <V>(self: TxHashSet<V>, value: V): Effect.Effect<boolean, never, Effect.Transaction>
} = dual<
  <V>(value: V) => (self: TxHashSet<V>) => Effect.Effect<boolean, never, Effect.Transaction>,
  <V>(self: TxHashSet<V>, value: V) => Effect.Effect<boolean, never, Effect.Transaction>
>(2, <V>(self: TxHashSet<V>, value: V) =>
  Effect.gen(function*() {
    const currentSet = yield* TxRef.get(self.ref)
    const existed = HashSet.has(currentSet, value)
    if (existed) {
      yield* TxRef.set(self.ref, HashSet.remove(currentSet, value))
    }
    return existed
  }))

/**
 * Checks if the TxHashSet contains the specified value.
 *
 * @example
 * ```ts
 * import { Effect, Equal, Hash, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txSet = yield* TxHashSet.make("apple", "banana", "cherry")
 *
 *   console.log(yield* TxHashSet.has(txSet, "apple")) // true
 *   console.log(yield* TxHashSet.has(txSet, "grape")) // false
 *
 *   // Works with any type that implements Equal
 *   class Person implements Equal.Equal {
 *     constructor(readonly name: string) {}
 *
 *     [Equal.symbol](other: unknown) {
 *       return other instanceof Person && this.name === other.name
 *     }
 *
 *     [Hash.symbol](): number {
 *       return Hash.string(this.name)
 *     }
 *   }
 *
 *   const people = yield* TxHashSet.make(new Person("Alice"), new Person("Bob"))
 *   console.log(yield* TxHashSet.has(people, new Person("Alice"))) // true
 * })
 * ```
 *
 * @since 2.0.0
 * @category elements
 */
export const has: {
  <V>(value: V): (self: TxHashSet<V>) => Effect.Effect<boolean, never, Effect.Transaction>
  <V>(self: TxHashSet<V>, value: V): Effect.Effect<boolean, never, Effect.Transaction>
} = dual<
  <V>(value: V) => (self: TxHashSet<V>) => Effect.Effect<boolean, never, Effect.Transaction>,
  <V>(self: TxHashSet<V>, value: V) => Effect.Effect<boolean, never, Effect.Transaction>
>(2, <V>(self: TxHashSet<V>, value: V) =>
  Effect.gen(function*() {
    const set = yield* TxRef.get(self.ref)
    return HashSet.has(set, value)
  }))

/**
 * Returns the number of values in the TxHashSet.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const empty = yield* TxHashSet.empty<string>()
 *   console.log(yield* TxHashSet.size(empty)) // 0
 *
 *   const small = yield* TxHashSet.make("a", "b")
 *   console.log(yield* TxHashSet.size(small)) // 2
 *
 *   const fromIterable = yield* TxHashSet.fromIterable(["x", "y", "z", "x", "y"])
 *   console.log(yield* TxHashSet.size(fromIterable)) // 3 (duplicates ignored)
 * })
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const size = <V>(self: TxHashSet<V>): Effect.Effect<number, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const set = yield* TxRef.get(self.ref)
    return HashSet.size(set)
  })

/**
 * Checks if the TxHashSet is empty.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const empty = yield* TxHashSet.empty<string>()
 *   console.log(yield* TxHashSet.isEmpty(empty)) // true
 *
 *   const nonEmpty = yield* TxHashSet.make("a")
 *   console.log(yield* TxHashSet.isEmpty(nonEmpty)) // false
 * })
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const isEmpty = <V>(self: TxHashSet<V>): Effect.Effect<boolean, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const set = yield* TxRef.get(self.ref)
    return HashSet.isEmpty(set)
  })

/**
 * Removes all values from the TxHashSet.
 *
 * **Mutation behavior**: This function mutates the original TxHashSet by clearing
 * all values. It does not return a new TxHashSet reference.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const txSet = yield* TxHashSet.make("a", "b", "c")
 *   console.log(yield* TxHashSet.size(txSet)) // 3
 *
 *   yield* TxHashSet.clear(txSet)
 *   console.log(yield* TxHashSet.size(txSet)) // 0
 *   console.log(yield* TxHashSet.isEmpty(txSet)) // true
 * })
 * ```
 *
 * @since 2.0.0
 * @category mutations
 */
export const clear = <V>(self: TxHashSet<V>): Effect.Effect<void, never, Effect.Transaction> =>
  TxRef.set(self.ref, HashSet.empty<V>())

/**
 * Creates the union of two TxHashSets, returning a new TxHashSet.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const set1 = yield* TxHashSet.make("a", "b")
 *   const set2 = yield* TxHashSet.make("b", "c")
 *   const combined = yield* TxHashSet.union(set1, set2)
 *
 *   const values = yield* TxHashSet.toHashSet(combined)
 *   console.log(Array.from(values).sort()) // ["a", "b", "c"]
 *   console.log(yield* TxHashSet.size(combined)) // 3
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const union: {
  <V1>(that: TxHashSet<V1>): <V0>(self: TxHashSet<V0>) => Effect.Effect<TxHashSet<V1 | V0>, never, Effect.Transaction>
  <V0, V1>(self: TxHashSet<V0>, that: TxHashSet<V1>): Effect.Effect<TxHashSet<V0 | V1>, never, Effect.Transaction>
} = dual<
  <V1>(
    that: TxHashSet<V1>
  ) => <V0>(self: TxHashSet<V0>) => Effect.Effect<TxHashSet<V1 | V0>, never, Effect.Transaction>,
  <V0, V1>(
    self: TxHashSet<V0>,
    that: TxHashSet<V1>
  ) => Effect.Effect<TxHashSet<V0 | V1>, never, Effect.Transaction>
>(2, <V0, V1>(self: TxHashSet<V0>, that: TxHashSet<V1>) =>
  Effect.gen(function*() {
    const set1 = yield* TxRef.get(self.ref)
    const set2 = yield* TxRef.get(that.ref)
    const combined = HashSet.union(set1, set2)
    return yield* fromHashSet(combined)
  }))

/**
 * Creates the intersection of two TxHashSets, returning a new TxHashSet.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const set1 = yield* TxHashSet.make("a", "b", "c")
 *   const set2 = yield* TxHashSet.make("b", "c", "d")
 *   const common = yield* TxHashSet.intersection(set1, set2)
 *
 *   const values = yield* TxHashSet.toHashSet(common)
 *   console.log(Array.from(values).sort()) // ["b", "c"]
 *   console.log(yield* TxHashSet.size(common)) // 2
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const intersection: {
  <V1>(that: TxHashSet<V1>): <V0>(self: TxHashSet<V0>) => Effect.Effect<TxHashSet<V1 & V0>, never, Effect.Transaction>
  <V0, V1>(self: TxHashSet<V0>, that: TxHashSet<V1>): Effect.Effect<TxHashSet<V0 & V1>, never, Effect.Transaction>
} = dual<
  <V1>(
    that: TxHashSet<V1>
  ) => <V0>(self: TxHashSet<V0>) => Effect.Effect<TxHashSet<V1 & V0>, never, Effect.Transaction>,
  <V0, V1>(
    self: TxHashSet<V0>,
    that: TxHashSet<V1>
  ) => Effect.Effect<TxHashSet<V0 & V1>, never, Effect.Transaction>
>(2, <V0, V1>(self: TxHashSet<V0>, that: TxHashSet<V1>) =>
  Effect.gen(function*() {
    const set1 = yield* TxRef.get(self.ref)
    const set2 = yield* TxRef.get(that.ref)
    const common = HashSet.intersection(set1, set2)
    return yield* fromHashSet(common)
  }))

/**
 * Creates the difference of two TxHashSets (elements in the first set that are not in the second), returning a new TxHashSet.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const set1 = yield* TxHashSet.make("a", "b", "c")
 *   const set2 = yield* TxHashSet.make("b", "d")
 *   const diff = yield* TxHashSet.difference(set1, set2)
 *
 *   const values = yield* TxHashSet.toHashSet(diff)
 *   console.log(Array.from(values).sort()) // ["a", "c"]
 *   console.log(yield* TxHashSet.size(diff)) // 2
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const difference: {
  <V1>(that: TxHashSet<V1>): <V0>(self: TxHashSet<V0>) => Effect.Effect<TxHashSet<V0>, never, Effect.Transaction>
  <V0, V1>(self: TxHashSet<V0>, that: TxHashSet<V1>): Effect.Effect<TxHashSet<V0>, never, Effect.Transaction>
} = dual<
  <V1>(
    that: TxHashSet<V1>
  ) => <V0>(self: TxHashSet<V0>) => Effect.Effect<TxHashSet<V0>, never, Effect.Transaction>,
  <V0, V1>(
    self: TxHashSet<V0>,
    that: TxHashSet<V1>
  ) => Effect.Effect<TxHashSet<V0>, never, Effect.Transaction>
>(2, <V0, V1>(self: TxHashSet<V0>, that: TxHashSet<V1>) =>
  Effect.gen(function*() {
    const set1 = yield* TxRef.get(self.ref)
    const set2 = yield* TxRef.get(that.ref)
    const diff = HashSet.difference(set1, set2)
    return yield* fromHashSet(diff)
  }))

/**
 * Checks if a TxHashSet is a subset of another TxHashSet.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const small = yield* TxHashSet.make("a", "b")
 *   const large = yield* TxHashSet.make("a", "b", "c", "d")
 *   const other = yield* TxHashSet.make("x", "y")
 *
 *   console.log(yield* TxHashSet.isSubset(small, large)) // true
 *   console.log(yield* TxHashSet.isSubset(large, small)) // false
 *   console.log(yield* TxHashSet.isSubset(small, other)) // false
 *   console.log(yield* TxHashSet.isSubset(small, small)) // true
 * })
 * ```
 *
 * @since 2.0.0
 * @category elements
 */
export const isSubset: {
  <V1>(that: TxHashSet<V1>): <V0>(self: TxHashSet<V0>) => Effect.Effect<boolean, never, Effect.Transaction>
  <V0, V1>(self: TxHashSet<V0>, that: TxHashSet<V1>): Effect.Effect<boolean, never, Effect.Transaction>
} = dual<
  <V1>(that: TxHashSet<V1>) => <V0>(self: TxHashSet<V0>) => Effect.Effect<boolean, never, Effect.Transaction>,
  <V0, V1>(self: TxHashSet<V0>, that: TxHashSet<V1>) => Effect.Effect<boolean, never, Effect.Transaction>
>(2, <V0, V1>(self: TxHashSet<V0>, that: TxHashSet<V1>) =>
  Effect.gen(function*() {
    const set1 = yield* TxRef.get(self.ref)
    const set2 = yield* TxRef.get(that.ref)
    return HashSet.isSubset(set1, set2)
  }))

/**
 * Tests whether at least one value in the TxHashSet satisfies the predicate.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const numbers = yield* TxHashSet.make(1, 2, 3, 4, 5)
 *
 *   console.log(yield* TxHashSet.some(numbers, (n) => n > 3)) // true
 *   console.log(yield* TxHashSet.some(numbers, (n) => n > 10)) // false
 *
 *   const empty = yield* TxHashSet.empty<number>()
 *   console.log(yield* TxHashSet.some(empty, (n) => n > 0)) // false
 * })
 * ```
 *
 * @since 2.0.0
 * @category elements
 */
export const some: {
  <V>(predicate: Predicate<V>): (self: TxHashSet<V>) => Effect.Effect<boolean, never, Effect.Transaction>
  <V>(self: TxHashSet<V>, predicate: Predicate<V>): Effect.Effect<boolean, never, Effect.Transaction>
} = dual<
  <V>(predicate: Predicate<V>) => (self: TxHashSet<V>) => Effect.Effect<boolean, never, Effect.Transaction>,
  <V>(self: TxHashSet<V>, predicate: Predicate<V>) => Effect.Effect<boolean, never, Effect.Transaction>
>(2, <V>(self: TxHashSet<V>, predicate: Predicate<V>) =>
  Effect.gen(function*() {
    const set = yield* TxRef.get(self.ref)
    return HashSet.some(set, predicate)
  }))

/**
 * Tests whether all values in the TxHashSet satisfy the predicate.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const numbers = yield* TxHashSet.make(2, 4, 6, 8)
 *
 *   console.log(yield* TxHashSet.every(numbers, (n) => n % 2 === 0)) // true
 *   console.log(yield* TxHashSet.every(numbers, (n) => n > 5)) // false
 *
 *   const empty = yield* TxHashSet.empty<number>()
 *   console.log(yield* TxHashSet.every(empty, (n) => n > 0)) // true (vacuously true)
 * })
 * ```
 *
 * @since 2.0.0
 * @category elements
 */
export const every: {
  <V>(predicate: Predicate<V>): (self: TxHashSet<V>) => Effect.Effect<boolean, never, Effect.Transaction>
  <V>(self: TxHashSet<V>, predicate: Predicate<V>): Effect.Effect<boolean, never, Effect.Transaction>
} = dual<
  <V>(predicate: Predicate<V>) => (self: TxHashSet<V>) => Effect.Effect<boolean, never, Effect.Transaction>,
  <V>(self: TxHashSet<V>, predicate: Predicate<V>) => Effect.Effect<boolean, never, Effect.Transaction>
>(2, <V>(self: TxHashSet<V>, predicate: Predicate<V>) =>
  Effect.gen(function*() {
    const set = yield* TxRef.get(self.ref)
    return HashSet.every(set, predicate)
  }))

/**
 * Maps each value in the TxHashSet using the provided function, returning a new TxHashSet.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const numbers = yield* TxHashSet.make(1, 2, 3)
 *   const doubled = yield* TxHashSet.map(numbers, (n) => n * 2)
 *
 *   const values = yield* TxHashSet.toHashSet(doubled)
 *   console.log(Array.from(values).sort()) // [2, 4, 6]
 *   console.log(yield* TxHashSet.size(doubled)) // 3
 *
 *   // Mapping can reduce size if function produces duplicates
 *   const strings = yield* TxHashSet.make("apple", "banana", "cherry")
 *   const lengths = yield* TxHashSet.map(strings, (s) => s.length)
 *   const lengthValues = yield* TxHashSet.toHashSet(lengths)
 *   console.log(Array.from(lengthValues).sort()) // [5, 6] (apple=5, banana=6, cherry=6)
 * })
 * ```
 *
 * @since 2.0.0
 * @category mapping
 */
export const map: {
  <V, U>(f: (value: V) => U): (self: TxHashSet<V>) => Effect.Effect<TxHashSet<U>, never, Effect.Transaction>
  <V, U>(self: TxHashSet<V>, f: (value: V) => U): Effect.Effect<TxHashSet<U>, never, Effect.Transaction>
} = dual<
  <V, U>(f: (value: V) => U) => (self: TxHashSet<V>) => Effect.Effect<TxHashSet<U>, never, Effect.Transaction>,
  <V, U>(self: TxHashSet<V>, f: (value: V) => U) => Effect.Effect<TxHashSet<U>, never, Effect.Transaction>
>(2, <V, U>(self: TxHashSet<V>, f: (value: V) => U) =>
  Effect.gen(function*() {
    const currentSet = yield* TxRef.get(self.ref)
    const mappedSet = HashSet.map(currentSet, f)
    return yield* fromHashSet(mappedSet)
  }))

/**
 * Filters the TxHashSet keeping only values that satisfy the predicate, returning a new TxHashSet.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const numbers = yield* TxHashSet.make(1, 2, 3, 4, 5, 6)
 *   const evens = yield* TxHashSet.filter(numbers, (n) => n % 2 === 0)
 *
 *   const values = yield* TxHashSet.toHashSet(evens)
 *   console.log(Array.from(values).sort()) // [2, 4, 6]
 *   console.log(yield* TxHashSet.size(evens)) // 3
 * })
 * ```
 *
 * @since 2.0.0
 * @category filtering
 */
export const filter: {
  <V, U extends V>(
    refinement: Refinement<NoInfer<V>, U>
  ): (self: TxHashSet<V>) => Effect.Effect<TxHashSet<U>, never, Effect.Transaction>
  <V>(
    predicate: Predicate<NoInfer<V>>
  ): (self: TxHashSet<V>) => Effect.Effect<TxHashSet<V>, never, Effect.Transaction>
  <V, U extends V>(
    self: TxHashSet<V>,
    refinement: Refinement<V, U>
  ): Effect.Effect<TxHashSet<U>, never, Effect.Transaction>
  <V>(self: TxHashSet<V>, predicate: Predicate<V>): Effect.Effect<TxHashSet<V>, never, Effect.Transaction>
} = dual<
  {
    <V, U extends V>(
      refinement: Refinement<NoInfer<V>, U>
    ): (self: TxHashSet<V>) => Effect.Effect<TxHashSet<U>, never, Effect.Transaction>
    <V>(
      predicate: Predicate<NoInfer<V>>
    ): (self: TxHashSet<V>) => Effect.Effect<TxHashSet<V>, never, Effect.Transaction>
  },
  {
    <V, U extends V>(
      self: TxHashSet<V>,
      refinement: Refinement<V, U>
    ): Effect.Effect<TxHashSet<U>, never, Effect.Transaction>
    <V>(self: TxHashSet<V>, predicate: Predicate<V>): Effect.Effect<TxHashSet<V>, never, Effect.Transaction>
  }
>(2, <V>(self: TxHashSet<V>, predicate: Predicate<V>) =>
  Effect.gen(function*() {
    const currentSet = yield* TxRef.get(self.ref)
    const filteredSet = HashSet.filter(currentSet, predicate)
    return yield* fromHashSet(filteredSet)
  }))

/**
 * Reduces the TxHashSet to a single value by iterating through the values and applying an accumulator function.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const numbers = yield* TxHashSet.make(1, 2, 3, 4, 5)
 *   const sum = yield* TxHashSet.reduce(numbers, 0, (acc, n) => acc + n)
 *
 *   console.log(sum) // 15
 *
 *   const strings = yield* TxHashSet.make("a", "b", "c")
 *   const concatenated = yield* TxHashSet.reduce(strings, "", (acc, s) => acc + s)
 *   console.log(concatenated) // Order may vary: "abc", "bac", etc.
 * })
 * ```
 *
 * @since 2.0.0
 * @category folding
 */
export const reduce: {
  <V, U>(
    zero: U,
    f: (accumulator: U, value: V) => U
  ): (self: TxHashSet<V>) => Effect.Effect<U, never, Effect.Transaction>
  <V, U>(
    self: TxHashSet<V>,
    zero: U,
    f: (accumulator: U, value: V) => U
  ): Effect.Effect<U, never, Effect.Transaction>
} = dual<
  <V, U>(
    zero: U,
    f: (accumulator: U, value: V) => U
  ) => (self: TxHashSet<V>) => Effect.Effect<U, never, Effect.Transaction>,
  <V, U>(
    self: TxHashSet<V>,
    zero: U,
    f: (accumulator: U, value: V) => U
  ) => Effect.Effect<U, never, Effect.Transaction>
>(3, <V, U>(self: TxHashSet<V>, zero: U, f: (accumulator: U, value: V) => U) =>
  Effect.gen(function*() {
    const set = yield* TxRef.get(self.ref)
    return HashSet.reduce(set, zero, f)
  }))

/**
 * Converts the TxHashSet to an immutable HashSet snapshot.
 *
 * @example
 * ```ts
 * import { Effect, TxHashSet } from "effect"
 * import * as HashSet from "effect/HashSet"
 *
 * const program = Effect.gen(function*() {
 *   const txSet = yield* TxHashSet.make("x", "y", "z")
 *   const hashSet = yield* TxHashSet.toHashSet(txSet)
 *
 *   console.log(HashSet.size(hashSet)) // 3
 *   console.log(HashSet.has(hashSet, "y")) // true
 *
 *   // hashSet is a snapshot - modifications to txSet don't affect it
 *   yield* TxHashSet.add(txSet, "w")
 *   console.log(HashSet.size(hashSet)) // 3 (unchanged)
 *   console.log(yield* TxHashSet.size(txSet)) // 4
 * })
 * ```
 *
 * @since 2.0.0
 * @category conversions
 */
export const toHashSet = <V>(self: TxHashSet<V>): Effect.Effect<HashSet.HashSet<V>, never, Effect.Transaction> =>
  TxRef.get(self.ref)

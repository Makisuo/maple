/**
 * @fileoverview
 * MutableHashSet is a high-performance, mutable set implementation that provides efficient storage
 * and retrieval of unique values. Built on top of MutableHashMap, it inherits the same performance
 * characteristics and support for both structural and referential equality.
 *
 * The implementation uses a MutableHashMap internally where each value is stored as a key with a
 * boolean flag, providing O(1) average-case performance for all operations.
 *
 * Key Features:
 * - Mutable operations for performance-critical scenarios
 * - Supports both structural and referential equality
 * - Efficient duplicate detection and removal
 * - Iterable interface for easy traversal
 * - Memory-efficient storage with automatic deduplication
 * - Seamless integration with Effect's Equal and Hash interfaces
 *
 * Performance Characteristics:
 * - Add/Has/Remove: O(1) average, O(n) worst case (hash collisions)
 * - Clear: O(1)
 * - Size: O(1)
 * - Iteration: O(n)
 *
 * @since 2.0.0
 * @category data-structures
 */
import { format } from "./Formatter.ts"
import * as Dual from "./Function.ts"
import { type Inspectable, NodeInspectSymbol, toJson } from "./Inspectable.ts"
import * as MutableHashMap from "./MutableHashMap.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"

const TypeId = "~effect/collections/MutableHashSet"

/**
 * @example
 * ```ts
 * import { MutableHashSet } from "effect"
 *
 * // Create a mutable hash set
 * const set: MutableHashSet.MutableHashSet<string> = MutableHashSet.make(
 *   "apple",
 *   "banana"
 * )
 *
 * // Add elements
 * MutableHashSet.add(set, "cherry")
 *
 * // Check if elements exist
 * console.log(MutableHashSet.has(set, "apple")) // true
 * console.log(MutableHashSet.has(set, "grape")) // false
 *
 * // Iterate over elements
 * for (const value of set) {
 *   console.log(value) // "apple", "banana", "cherry"
 * }
 *
 * // Get size
 * console.log(MutableHashSet.size(set)) // 3
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface MutableHashSet<out V> extends Iterable<V>, Pipeable, Inspectable {
  readonly [TypeId]: typeof TypeId
  readonly keyMap: MutableHashMap.MutableHashMap<V, boolean>
}

/**
 * Checks if the specified value is a `MutableHashSet`, `false` otherwise.
 *
 * @category refinements
 * @since 4.0.0
 */
export const isMutableHashSet = <V>(value: unknown): value is MutableHashSet<V> => hasProperty(value, TypeId)

const MutableHashSetProto: Omit<MutableHashSet<unknown>, "keyMap"> = {
  [TypeId]: TypeId,
  [Symbol.iterator](this: MutableHashSet<unknown>): Iterator<unknown> {
    return Array.from(this.keyMap).map(([_]) => _)[Symbol.iterator]()
  },
  toString() {
    return `MutableHashSet(${format(Array.from(this))})`
  },
  toJSON() {
    return {
      _id: "MutableHashSet",
      values: toJson(Array.from(this))
    }
  },
  [NodeInspectSymbol]() {
    return this.toJSON()
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

const fromHashMap = <V>(keyMap: MutableHashMap.MutableHashMap<V, boolean>): MutableHashSet<V> => {
  const set = Object.create(MutableHashSetProto)
  set.keyMap = keyMap
  return set
}

/**
 * Creates an empty MutableHashSet.
 *
 * @example
 * ```ts
 * import { MutableHashSet } from "effect"
 *
 * const set = MutableHashSet.empty<string>()
 *
 * // Add some values
 * MutableHashSet.add(set, "apple")
 * MutableHashSet.add(set, "banana")
 * MutableHashSet.add(set, "apple") // Duplicate, no effect
 *
 * console.log(MutableHashSet.size(set)) // 2
 * console.log(Array.from(set)) // ["apple", "banana"]
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const empty = <K = never>(): MutableHashSet<K> => fromHashMap(MutableHashMap.empty())

/**
 * Creates a MutableHashSet from an iterable collection of values.
 * Duplicates are automatically removed.
 *
 * @example
 * ```ts
 * import { MutableHashSet } from "effect"
 *
 * const values = ["apple", "banana", "apple", "cherry", "banana"]
 * const set = MutableHashSet.fromIterable(values)
 *
 * console.log(MutableHashSet.size(set)) // 3
 * console.log(Array.from(set)) // ["apple", "banana", "cherry"]
 *
 * // Works with any iterable
 * const fromSet = MutableHashSet.fromIterable(new Set([1, 2, 3]))
 * console.log(MutableHashSet.size(fromSet)) // 3
 *
 * // From string characters
 * const fromString = MutableHashSet.fromIterable("hello")
 * console.log(Array.from(fromString)) // ["h", "e", "l", "o"]
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const fromIterable = <K = never>(keys: Iterable<K>): MutableHashSet<K> =>
  fromHashMap(MutableHashMap.fromIterable(Array.from(keys).map((k) => [k, true])))

/**
 * Creates a MutableHashSet from a variable number of values.
 * Duplicates are automatically removed.
 *
 * @example
 * ```ts
 * import { MutableHashSet } from "effect"
 *
 * const set = MutableHashSet.make("apple", "banana", "apple", "cherry")
 *
 * console.log(MutableHashSet.size(set)) // 3
 * console.log(Array.from(set)) // ["apple", "banana", "cherry"]
 *
 * // With numbers
 * const numbers = MutableHashSet.make(1, 2, 3, 2, 1)
 * console.log(MutableHashSet.size(numbers)) // 3
 * console.log(Array.from(numbers)) // [1, 2, 3]
 *
 * // Mixed types
 * const mixed = MutableHashSet.make("hello", 42, true, "hello")
 * console.log(MutableHashSet.size(mixed)) // 3
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const make = <Keys extends ReadonlyArray<unknown>>(
  ...keys: Keys
): MutableHashSet<Keys[number]> => fromIterable(keys)

/**
 * Adds a value to the MutableHashSet, mutating the set in place.
 * If the value already exists, the set remains unchanged.
 *
 * @example
 * ```ts
 * import { MutableHashSet } from "effect"
 *
 * const set = MutableHashSet.empty<string>()
 *
 * // Add new values
 * MutableHashSet.add(set, "apple")
 * MutableHashSet.add(set, "banana")
 *
 * console.log(MutableHashSet.size(set)) // 2
 * console.log(MutableHashSet.has(set, "apple")) // true
 *
 * // Add duplicate (no effect)
 * MutableHashSet.add(set, "apple")
 * console.log(MutableHashSet.size(set)) // 2
 *
 * // Pipe-able version
 * const addFruit = MutableHashSet.add("cherry")
 * addFruit(set)
 * console.log(MutableHashSet.size(set)) // 3
 * ```
 *
 * @since 2.0.0
 * @category mutations
 */
export const add: {
  <V>(key: V): (self: MutableHashSet<V>) => MutableHashSet<V>
  <V>(self: MutableHashSet<V>, key: V): MutableHashSet<V>
} = Dual.dual<
  <V>(key: V) => (self: MutableHashSet<V>) => MutableHashSet<V>,
  <V>(self: MutableHashSet<V>, key: V) => MutableHashSet<V>
>(2, (self, key) => (MutableHashMap.set(self.keyMap, key, true), self))

/**
 * Checks if the MutableHashSet contains the specified value.
 *
 * @example
 * ```ts
 * import { MutableHashSet } from "effect"
 *
 * const set = MutableHashSet.make("apple", "banana", "cherry")
 *
 * console.log(MutableHashSet.has(set, "apple")) // true
 * console.log(MutableHashSet.has(set, "grape")) // false
 *
 * // Pipe-able version
 * const hasApple = MutableHashSet.has("apple")
 * console.log(hasApple(set)) // true
 *
 * // Check after adding
 * MutableHashSet.add(set, "grape")
 * console.log(MutableHashSet.has(set, "grape")) // true
 * ```
 *
 * @since 2.0.0
 * @category elements
 */
export const has: {
  <V>(key: V): (self: MutableHashSet<V>) => boolean
  <V>(self: MutableHashSet<V>, key: V): boolean
} = Dual.dual<
  <V>(key: V) => (self: MutableHashSet<V>) => boolean,
  <V>(self: MutableHashSet<V>, key: V) => boolean
>(2, (self, key) => MutableHashMap.has(self.keyMap, key))

/**
 * Removes the specified value from the MutableHashSet, mutating the set in place.
 * If the value doesn't exist, the set remains unchanged.
 *
 * @example
 * ```ts
 * import { MutableHashSet } from "effect"
 *
 * const set = MutableHashSet.make("apple", "banana", "cherry")
 *
 * console.log(MutableHashSet.size(set)) // 3
 *
 * // Remove existing value
 * MutableHashSet.remove(set, "banana")
 * console.log(MutableHashSet.size(set)) // 2
 * console.log(MutableHashSet.has(set, "banana")) // false
 *
 * // Remove non-existent value (no effect)
 * MutableHashSet.remove(set, "grape")
 * console.log(MutableHashSet.size(set)) // 2
 *
 * // Pipe-able version
 * const removeFruit = MutableHashSet.remove("apple")
 * removeFruit(set)
 * console.log(MutableHashSet.size(set)) // 1
 * ```
 *
 * @since 2.0.0
 * @category mutations
 */
export const remove: {
  <V>(key: V): (self: MutableHashSet<V>) => MutableHashSet<V>
  <V>(self: MutableHashSet<V>, key: V): MutableHashSet<V>
} = Dual.dual<
  <V>(key: V) => (self: MutableHashSet<V>) => MutableHashSet<V>,
  <V>(self: MutableHashSet<V>, key: V) => MutableHashSet<V>
>(2, (self, key) => (MutableHashMap.remove(self.keyMap, key), self))

/**
 * Returns the number of unique values in the MutableHashSet.
 *
 * @example
 * ```ts
 * import { MutableHashSet } from "effect"
 *
 * const set = MutableHashSet.empty<string>()
 * console.log(MutableHashSet.size(set)) // 0
 *
 * MutableHashSet.add(set, "apple")
 * MutableHashSet.add(set, "banana")
 * MutableHashSet.add(set, "apple") // Duplicate
 * console.log(MutableHashSet.size(set)) // 2
 *
 * MutableHashSet.remove(set, "apple")
 * console.log(MutableHashSet.size(set)) // 1
 *
 * MutableHashSet.clear(set)
 * console.log(MutableHashSet.size(set)) // 0
 * ```
 *
 * @since 2.0.0
 * @category elements
 */
export const size = <V>(self: MutableHashSet<V>): number => MutableHashMap.size(self.keyMap)

/**
 * Removes all values from the MutableHashSet, mutating the set in place.
 * The set becomes empty after this operation.
 *
 * @example
 * ```ts
 * import { MutableHashSet } from "effect"
 *
 * const set = MutableHashSet.make("apple", "banana", "cherry")
 *
 * console.log(MutableHashSet.size(set)) // 3
 *
 * // Clear all values
 * MutableHashSet.clear(set)
 *
 * console.log(MutableHashSet.size(set)) // 0
 * console.log(MutableHashSet.has(set, "apple")) // false
 * console.log(Array.from(set)) // []
 *
 * // Can still add new values after clearing
 * MutableHashSet.add(set, "new")
 * console.log(MutableHashSet.size(set)) // 1
 * ```
 *
 * @since 2.0.0
 * @category mutations
 */
export const clear = <V>(self: MutableHashSet<V>): MutableHashSet<V> => (MutableHashMap.clear(self.keyMap), self)

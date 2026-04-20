/**
 * MutableHashMap is a high-performance, mutable hash map implementation designed for efficient key-value storage
 * with support for both structural and referential equality. It provides O(1) average-case performance for
 * basic operations and integrates seamlessly with Effect's Equal and Hash interfaces.
 *
 * The implementation uses a hybrid approach:
 * - Referential keys (without Equal implementation) are stored in a native Map
 * - Structural keys (with Equal implementation) are stored in hash buckets with collision handling
 *
 * Key Features:
 * - Mutable operations for performance-critical scenarios
 * - Supports both structural and referential equality
 * - Efficient collision handling through bucketing
 * - Iterable interface for easy traversal
 * - Memory-efficient storage with automatic bucket management
 *
 * Performance Characteristics:
 * - Get/Set/Has: O(1) average, O(n) worst case (hash collisions)
 * - Remove: O(1) average, O(n) worst case
 * - Clear: O(1)
 * - Size: O(1)
 * - Iteration: O(n)
 *
 * @since 2.0.0
 * @category data-structures
 */
import type { NonEmptyArray } from "./Array.ts"
import * as Equal from "./Equal.ts"
import { format } from "./Formatter.ts"
import { dual } from "./Function.ts"
import * as Hash from "./Hash.ts"
import { type Inspectable, NodeInspectSymbol, toJson } from "./Inspectable.ts"
import * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"

const TypeId = "~effect/collections/MutableHashMap"

/**
 * @example
 * ```ts
 * import * as MutableHashMap from "effect/MutableHashMap"
 *
 * // Create a mutable hash map with string keys and number values
 * const map: MutableHashMap.MutableHashMap<string, number> = MutableHashMap
 *   .empty()
 *
 * // Add some data
 * MutableHashMap.set(map, "count", 42)
 * MutableHashMap.set(map, "total", 100)
 *
 * // Use as iterable
 * for (const [key, value] of map) {
 *   console.log(`${key}: ${value}`)
 * }
 * // Output:
 * // count: 42
 * // total: 100
 *
 * // Convert to array
 * const entries = Array.from(map)
 * console.log(entries) // [["count", 42], ["total", 100]]
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface MutableHashMap<out K, out V> extends Iterable<[K, V]>, Pipeable, Inspectable {
  readonly [TypeId]: typeof TypeId
  readonly backing: Map<K, V>
  readonly buckets: Map<number, NonEmptyArray<K>>
}

/**
 * Checks if the specified value is a `MutableHashMap`, `false` otherwise.
 *
 * @category refinements
 * @since 4.0.0
 */
export const isMutableHashMap = <K, V>(value: unknown): value is MutableHashMap<K, V> => hasProperty(value, TypeId)

const MutableHashMapProto: Omit<MutableHashMap<unknown, unknown>, "backing" | "buckets" | "bucketsSize"> = {
  [TypeId]: TypeId,
  [Symbol.iterator](this: MutableHashMap<unknown, unknown>): Iterator<[unknown, unknown]> {
    return this.backing[Symbol.iterator]()
  },
  toString() {
    return `MutableHashMap(${format(Array.from(this))})`
  },
  toJSON() {
    return {
      _id: "MutableHashMap",
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

/**
 * Creates an empty MutableHashMap.
 *
 * @example
 * ```ts
 * import * as MutableHashMap from "effect/MutableHashMap"
 *
 * const map = MutableHashMap.empty<string, number>()
 *
 * // Add some entries
 * MutableHashMap.set(map, "key1", 42)
 * MutableHashMap.set(map, "key2", 100)
 *
 * console.log(MutableHashMap.size(map)) // 2
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const empty = <K, V>(): MutableHashMap<K, V> => {
  const self = Object.create(MutableHashMapProto)
  self.backing = new Map()
  self.buckets = new Map()
  return self
}

/**
 * Creates a MutableHashMap from a variable number of key-value pairs.
 *
 * @example
 * ```ts
 * import * as MutableHashMap from "effect/MutableHashMap"
 *
 * const map = MutableHashMap.make(
 *   ["key1", 42],
 *   ["key2", 100],
 *   ["key3", 200]
 * )
 *
 * console.log(MutableHashMap.get(map, "key1")) // Some(42)
 * console.log(MutableHashMap.size(map)) // 3
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const make: <Entries extends Array<readonly [any, any]>>(
  ...entries: Entries
) => MutableHashMap<
  Entries[number] extends readonly [infer K, any] ? K : never,
  Entries[number] extends readonly [any, infer V] ? V : never
> = (...entries) => fromIterable(entries)

/**
 * Creates a MutableHashMap from an iterable collection of key-value pairs.
 *
 * @example
 * ```ts
 * import * as MutableHashMap from "effect/MutableHashMap"
 *
 * const entries = [
 *   ["apple", 1],
 *   ["banana", 2],
 *   ["cherry", 3]
 * ] as const
 *
 * const map = MutableHashMap.fromIterable(entries)
 *
 * console.log(MutableHashMap.get(map, "banana")) // Some(2)
 * console.log(MutableHashMap.size(map)) // 3
 *
 * // Works with any iterable
 * const fromMap = MutableHashMap.fromIterable(new Map([["x", 10], ["y", 20]]))
 * console.log(MutableHashMap.get(fromMap, "x")) // Some(10)
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const fromIterable = <K, V>(entries: Iterable<readonly [K, V]>): MutableHashMap<K, V> => {
  const self = empty<K, V>()
  for (const [key, value] of entries) {
    set(self, key, value)
  }
  return self
}

/**
 * Retrieves the value associated with the specified key from the MutableHashMap.
 *
 * @example
 * ```ts
 * import * as MutableHashMap from "effect/MutableHashMap"
 *
 * const map = MutableHashMap.make(["key1", 42], ["key2", 100])
 *
 * console.log(MutableHashMap.get(map, "key1")) // Some(42)
 * console.log(MutableHashMap.get(map, "key3")) // None
 *
 * // Pipe-able version
 * const getValue = MutableHashMap.get("key1")
 * console.log(getValue(map)) // Some(42)
 * ```
 *
 * @since 2.0.0
 * @category elements
 */
export const get: {
  <K>(key: K): <V>(self: MutableHashMap<K, V>) => Option.Option<V>
  <K, V>(self: MutableHashMap<K, V>, key: K): Option.Option<V>
} = dual<
  <K>(key: K) => <V>(self: MutableHashMap<K, V>) => Option.Option<V>,
  <K, V>(self: MutableHashMap<K, V>, key: K) => Option.Option<V>
>(2, <K, V>(self: MutableHashMap<K, V>, key: K): Option.Option<V> => {
  if (self.backing.has(key)) {
    return Option.some(self.backing.get(key)!)
  } else if (isSimpleKey(key)) {
    return Option.none()
  }
  const refKey = referentialKeysCache.get(self)
  if (refKey !== undefined) {
    return self.backing.has(refKey) ? Option.some(self.backing.get(refKey)!) : Option.none()
  }
  const hash = Hash.hash(key)
  const bucket = self.buckets.get(hash)
  if (bucket === undefined) {
    return Option.none()
  }
  return getFromBucket(self, bucket, key)
})

const referentialKeysCache = new WeakMap<any, any>()
const isSimpleKey = (u: unknown): boolean => typeof u !== "object" && typeof u !== "function"

/**
 * Extracts all keys from the MutableHashMap into an array.
 *
 * @example
 * ```ts
 * import * as MutableHashMap from "effect/MutableHashMap"
 *
 * const map = MutableHashMap.make(
 *   ["apple", 1],
 *   ["banana", 2],
 *   ["cherry", 3]
 * )
 *
 * const allKeys = Array.from(MutableHashMap.keys(map))
 * console.log(allKeys) // ["apple", "banana", "cherry"]
 *
 * // Useful for iteration or validation
 * const hasRequiredKeys = allKeys.includes("apple") && allKeys.includes("banana")
 * ```
 *
 * @since 3.8.0
 * @category elements
 */
export const keys = <K, V>(self: MutableHashMap<K, V>): Iterable<K> => self.backing.keys()

/**
 * Extracts all values from the MutableHashMap into an array.
 *
 * @example
 * ```ts
 * import * as MutableHashMap from "effect/MutableHashMap"
 *
 * const map = MutableHashMap.make(
 *   ["apple", 1],
 *   ["banana", 2],
 *   ["cherry", 3]
 * )
 *
 * const allValues = Array.from(MutableHashMap.values(map))
 * console.log(allValues) // [1, 2, 3]
 *
 * // Useful for calculations
 * const total = allValues.reduce((sum, value) => sum + value, 0)
 * console.log(total) // 6
 *
 * // Filter values
 * const largeValues = allValues.filter((value) => value > 1)
 * console.log(largeValues) // [2, 3]
 * ```
 *
 * @since 3.8.0
 * @category elements
 */
export const values = <K, V>(self: MutableHashMap<K, V>): Iterable<V> => self.backing.values()

const getFromBucket = <K, V>(
  self: MutableHashMap<K, V>,
  bucket: NonEmptyArray<K>,
  key: K
): Option.Option<V> => {
  for (let i = 0, len = bucket.length; i < len; i++) {
    if (Equal.equals(key, bucket[i])) {
      const refKey = bucket[i]
      referentialKeysCache.set(key, refKey)
      return Option.some(self.backing.get(refKey)!)
    }
  }
  return Option.none()
}

/**
 * Checks if the MutableHashMap contains the specified key.
 *
 * @example
 * ```ts
 * import * as MutableHashMap from "effect/MutableHashMap"
 *
 * const map = MutableHashMap.make(["key1", 42], ["key2", 100])
 *
 * console.log(MutableHashMap.has(map, "key1")) // true
 * console.log(MutableHashMap.has(map, "key3")) // false
 *
 * // Pipe-able version
 * const hasKey = MutableHashMap.has("key1")
 * console.log(hasKey(map)) // true
 * ```
 *
 * @since 2.0.0
 * @category elements
 */
export const has: {
  <K>(key: K): <V>(self: MutableHashMap<K, V>) => boolean
  <K, V>(self: MutableHashMap<K, V>, key: K): boolean
} = dual<
  <K>(key: K) => <V>(self: MutableHashMap<K, V>) => boolean,
  <K, V>(self: MutableHashMap<K, V>, key: K) => boolean
>(2, (self, key) => Option.isSome(get(self, key)))

/**
 * Sets a key-value pair in the MutableHashMap, mutating the map in place.
 * If the key already exists, its value is updated.
 *
 * @example
 * ```ts
 * import * as MutableHashMap from "effect/MutableHashMap"
 *
 * const map = MutableHashMap.empty<string, number>()
 *
 * // Add new entries
 * MutableHashMap.set(map, "key1", 42)
 * MutableHashMap.set(map, "key2", 100)
 *
 * console.log(MutableHashMap.get(map, "key1")) // Some(42)
 * console.log(MutableHashMap.size(map)) // 2
 *
 * // Update existing entry
 * MutableHashMap.set(map, "key1", 999)
 * console.log(MutableHashMap.get(map, "key1")) // Some(999)
 *
 * // Pipe-able version
 * const setKey = MutableHashMap.set("key3", 300)
 * setKey(map)
 * console.log(MutableHashMap.size(map)) // 3
 * ```
 *
 * @since 2.0.0
 * @category mutations
 */
export const set: {
  <K, V>(key: K, value: V): (self: MutableHashMap<K, V>) => MutableHashMap<K, V>
  <K, V>(self: MutableHashMap<K, V>, key: K, value: V): MutableHashMap<K, V>
} = dual<
  <K, V>(key: K, value: V) => (self: MutableHashMap<K, V>) => MutableHashMap<K, V>,
  <K, V>(self: MutableHashMap<K, V>, key: K, value: V) => MutableHashMap<K, V>
>(3, <K, V>(self: MutableHashMap<K, V>, key: K, value: V) => {
  if (self.backing.has(key) || isSimpleKey(key)) {
    self.backing.set(key, value)
    return self
  }
  let refKey = referentialKeysCache.get(self)
  if (refKey !== undefined && self.backing.has(refKey)) {
    self.backing.set(refKey, value)
    return self
  }

  const hash = Hash.hash(key)
  const bucket = self.buckets.get(hash)
  if (bucket === undefined) {
    self.buckets.set(hash, [key])
    self.backing.set(key, value)
    return self
  }

  refKey = getRefKey(bucket, key)
  if (refKey === undefined) {
    bucket.push(key)
    refKey = key
  }
  self.backing.set(refKey, value)
  return self
})

const getRefKey = <K>(
  bucket: NonEmptyArray<K>,
  key: K
) => {
  for (let i = 0, len = bucket.length; i < len; i++) {
    if (Equal.equals(key, bucket[i])) {
      referentialKeysCache.set(key, bucket[i])
      return bucket[i]
    }
  }
}

/**
 * Updates the value of the specified key within the MutableHashMap if it exists.
 * If the key doesn't exist, the map remains unchanged.
 *
 * @example
 * ```ts
 * import * as MutableHashMap from "effect/MutableHashMap"
 *
 * const map = MutableHashMap.make(["count", 5], ["total", 100])
 *
 * // Increment existing value
 * MutableHashMap.modify(map, "count", (n) => n + 1)
 * console.log(MutableHashMap.get(map, "count")) // Some(6)
 *
 * // Double existing value
 * MutableHashMap.modify(map, "total", (n) => n * 2)
 * console.log(MutableHashMap.get(map, "total")) // Some(200)
 *
 * // Try to modify non-existent key (no effect)
 * MutableHashMap.modify(map, "missing", (n) => n + 1)
 * console.log(MutableHashMap.has(map, "missing")) // false
 *
 * // Pipe-able version
 * const increment = MutableHashMap.modify("count", (n: number) => n + 1)
 * increment(map)
 * ```
 *
 * @since 2.0.0
 * @category mutations
 */
export const modify: {
  <K, V>(key: K, f: (v: V) => V): (self: MutableHashMap<K, V>) => MutableHashMap<K, V>
  <K, V>(self: MutableHashMap<K, V>, key: K, f: (v: V) => V): MutableHashMap<K, V>
} = dual<
  <K, V>(key: K, f: (v: V) => V) => (self: MutableHashMap<K, V>) => MutableHashMap<K, V>,
  <K, V>(self: MutableHashMap<K, V>, key: K, f: (v: V) => V) => MutableHashMap<K, V>
>(3, <K, V>(self: MutableHashMap<K, V>, key: K, f: (v: V) => V) => {
  const hasKey = self.backing.has(key)
  if (hasKey || isSimpleKey(key)) {
    if (hasKey) {
      self.backing.set(key, f(self.backing.get(key)!))
    }
    return self
  }
  let refKey = referentialKeysCache.get(self)
  if (refKey !== undefined && self.backing.has(refKey)) {
    self.backing.set(refKey, f(self.backing.get(refKey)!))
    return self
  }

  const hash = Hash.hash(key)
  const bucket = self.buckets.get(hash)
  if (bucket === undefined) {
    return self
  }

  refKey = getRefKey(bucket, key)
  if (refKey === undefined) {
    return self
  }
  self.backing.set(refKey, f(self.backing.get(refKey)!))
  return self
})

/**
 * Sets or removes the specified key in the MutableHashMap using an update function.
 * The function receives the current value as an Option and returns an Option.
 * If the function returns Some, the key is set to that value.
 * If the function returns None, the key is removed.
 *
 * @example
 * ```ts
 * import * as MutableHashMap from "effect/MutableHashMap"
 * import * as Option from "effect/Option"
 *
 * const map = MutableHashMap.make(["count", 5])
 *
 * // Update existing key
 * MutableHashMap.modifyAt(
 *   map,
 *   "count",
 *   (option) => Option.map(option, (n) => n * 2)
 * )
 * console.log(MutableHashMap.get(map, "count")) // Some(10)
 *
 * // Add new key
 * MutableHashMap.modifyAt(
 *   map,
 *   "new",
 *   (option) => Option.isNone(option) ? Option.some(42) : option
 * )
 * console.log(MutableHashMap.get(map, "new")) // Some(42)
 *
 * // Remove key by returning None
 * MutableHashMap.modifyAt(map, "count", () => Option.none())
 * console.log(MutableHashMap.has(map, "count")) // false
 *
 * // Conditional update
 * MutableHashMap.modifyAt(
 *   map,
 *   "new",
 *   (option) => Option.filter(option, (n) => n > 50) // Remove if <= 50
 * )
 * console.log(MutableHashMap.has(map, "new")) // false (42 <= 50)
 * ```
 *
 * @since 2.0.0
 * @category mutations
 */
export const modifyAt: {
  <K, V>(key: K, f: (value: Option.Option<V>) => Option.Option<V>): (self: MutableHashMap<K, V>) => MutableHashMap<K, V>
  <K, V>(self: MutableHashMap<K, V>, key: K, f: (value: Option.Option<V>) => Option.Option<V>): MutableHashMap<K, V>
} = dual<
  <K, V>(
    key: K,
    f: (value: Option.Option<V>) => Option.Option<V>
  ) => (self: MutableHashMap<K, V>) => MutableHashMap<K, V>,
  <K, V>(
    self: MutableHashMap<K, V>,
    key: K,
    f: (value: Option.Option<V>) => Option.Option<V>
  ) => MutableHashMap<K, V>
>(3, (self, key, f) => {
  const current = get(self, key)
  const result = f(current)
  if (Option.isNone(result)) {
    if (Option.isSome(current)) {
      remove(self, key)
    }
    return self
  }
  set(self, key, result.value)
  return self
})

/**
 * Removes the specified key from the MutableHashMap, mutating the map in place.
 * If the key doesn't exist, the map remains unchanged.
 *
 * @example
 * ```ts
 * import * as MutableHashMap from "effect/MutableHashMap"
 *
 * const map = MutableHashMap.make(
 *   ["key1", 42],
 *   ["key2", 100],
 *   ["key3", 200]
 * )
 *
 * console.log(MutableHashMap.size(map)) // 3
 *
 * // Remove existing key
 * MutableHashMap.remove(map, "key2")
 * console.log(MutableHashMap.size(map)) // 2
 * console.log(MutableHashMap.has(map, "key2")) // false
 *
 * // Remove non-existent key (no effect)
 * MutableHashMap.remove(map, "nonexistent")
 * console.log(MutableHashMap.size(map)) // 2
 *
 * // Pipe-able version
 * const removeKey = MutableHashMap.remove("key1")
 * removeKey(map)
 * console.log(MutableHashMap.size(map)) // 1
 * ```
 *
 * @since 2.0.0
 * @category mutations
 */
export const remove: {
  <K>(key: K): <V>(self: MutableHashMap<K, V>) => MutableHashMap<K, V>
  <K, V>(self: MutableHashMap<K, V>, key: K): MutableHashMap<K, V>
} = dual<
  <K>(key: K) => <V>(self: MutableHashMap<K, V>) => MutableHashMap<K, V>,
  <K, V>(self: MutableHashMap<K, V>, key: K) => MutableHashMap<K, V>
>(2, <K, V>(self: MutableHashMap<K, V>, key_: K) => {
  if (isSimpleKey(key_)) {
    self.backing.delete(key_)
    return self
  }

  const key = referentialKeysCache.get(self) ?? key_
  const hash = Hash.hash(key)
  const bucket = self.buckets.get(hash)
  if (bucket === undefined) {
    return self
  }
  for (let i = 0, len = bucket.length; i < len; i++) {
    const bkey = bucket[i]
    if (bkey === key || Equal.equals(key, bkey)) {
      self.backing.delete(bkey)
      bucket.splice(i, 1)
      break
    }
  }
  if (bucket.length === 0) {
    self.buckets.delete(hash)
  }
  return self
})

/**
 * Removes all key-value pairs from the MutableHashMap, mutating the map in place.
 * The map becomes empty after this operation.
 *
 * @example
 * ```ts
 * import * as MutableHashMap from "effect/MutableHashMap"
 *
 * const map = MutableHashMap.make(
 *   ["key1", 42],
 *   ["key2", 100],
 *   ["key3", 200]
 * )
 *
 * console.log(MutableHashMap.size(map)) // 3
 *
 * // Clear all entries
 * MutableHashMap.clear(map)
 *
 * console.log(MutableHashMap.size(map)) // 0
 * console.log(MutableHashMap.has(map, "key1")) // false
 *
 * // Can still add new entries after clearing
 * MutableHashMap.set(map, "new", 999)
 * console.log(MutableHashMap.size(map)) // 1
 * ```
 *
 * @since 2.0.0
 * @category mutations
 */
export const clear = <K, V>(self: MutableHashMap<K, V>) => {
  self.backing.clear()
  self.buckets.clear()
  return self
}

/**
 * Returns the number of key-value pairs in the MutableHashMap.
 *
 * @example
 * ```ts
 * import * as MutableHashMap from "effect/MutableHashMap"
 *
 * const map = MutableHashMap.empty<string, number>()
 * console.log(MutableHashMap.size(map)) // 0
 *
 * MutableHashMap.set(map, "key1", 42)
 * MutableHashMap.set(map, "key2", 100)
 * console.log(MutableHashMap.size(map)) // 2
 *
 * MutableHashMap.remove(map, "key1")
 * console.log(MutableHashMap.size(map)) // 1
 *
 * MutableHashMap.clear(map)
 * console.log(MutableHashMap.size(map)) // 0
 * ```
 *
 * @since 2.0.0
 * @category elements
 */
export const size = <K, V>(self: MutableHashMap<K, V>): number => self.backing.size

/**
 * @since 2.0.0
 */
export const isEmpty = <K, V>(self: MutableHashMap<K, V>): boolean => self.backing.size === 0

/**
 * @since 2.0.0
 */
export const forEach: {
  <K, V>(f: (value: V, key: K) => void): (self: MutableHashMap<K, V>) => void
  <K, V>(self: MutableHashMap<K, V>, f: (value: V, key: K) => void): void
} = dual(2, <K, V>(self: MutableHashMap<K, V>, f: (value: V, key: K) => void) => {
  self.backing.forEach(f)
})

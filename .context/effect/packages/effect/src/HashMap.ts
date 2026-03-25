/**
 * @since 2.0.0
 */

import type { Equal } from "./Equal.ts"
import type { Inspectable } from "./Inspectable.ts"
import * as internal from "./internal/hashMap.ts"
import type { Option } from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import type { Result } from "./Result.ts"
import type { NoInfer } from "./Types.ts"

const TypeId = internal.HashMapTypeId

/**
 * A HashMap is an immutable key-value data structure that provides efficient lookup,
 * insertion, and deletion operations. It uses a Hash Array Mapped Trie (HAMT) internally
 * for structural sharing and optimal performance.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * // Create a HashMap
 * const map = HashMap.make(["a", 1], ["b", 2], ["c", 3])
 *
 * // Access values
 * const valueA = HashMap.get(map, "a") // Option.some(1)
 * const valueD = HashMap.get(map, "d") // Option.none()
 *
 * // Check if key exists
 * console.log(HashMap.has(map, "b")) // true
 *
 * // Add/update values (returns new HashMap)
 * const updated = HashMap.set(map, "d", 4)
 * console.log(HashMap.size(updated)) // 4
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface HashMap<out Key, out Value> extends Iterable<[Key, Value]>, Equal, Pipeable, Inspectable {
  readonly [TypeId]: typeof TypeId
}

/**
 * The HashMap namespace contains type-level utilities and helper types
 * for working with HashMap instances.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * // Create a concrete HashMap for type extraction
 * const inventory = HashMap.make(
 *   ["laptop", { quantity: 5, price: 999 }],
 *   ["mouse", { quantity: 20, price: 29 }]
 * )
 *
 * // Extract types for reuse
 * type ProductId = HashMap.HashMap.Key<typeof inventory> // string
 * type Product = HashMap.HashMap.Value<typeof inventory> // { quantity: number, price: number }
 * type InventoryEntry = HashMap.HashMap.Entry<typeof inventory> // [string, Product]
 *
 * // Use extracted types in functions
 * const updateInventory = (id: ProductId, product: Product) =>
 *   HashMap.set(inventory, id, product)
 *
 * const processEntry = ([id, product]: InventoryEntry) =>
 *   `${id}: ${product.quantity} @ $${product.price}`
 *
 * // Example of extracted types in action
 * const newProduct: Product = { quantity: 10, price: 199 }
 * const updatedInventory = updateInventory("tablet", newProduct)
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export declare namespace HashMap {
  /**
   * A function that updates a value based on its current state.
   * Takes an Option representing the current value and returns an Option
   * representing the new value.
   *
   * @example
   * ```ts
   * import * as HashMap from "effect/HashMap"
   * import * as Option from "effect/Option"
   *
   * const map = HashMap.make(["a", 1], ["b", 2])
   *
   * // Increment existing value or set to 1 if not present
   * const updateFn = (option: Option.Option<number>) =>
   *   Option.isSome(option) ? Option.some(option.value + 1) : Option.some(1)
   *
   * const updated = HashMap.modifyAt(map, "a", updateFn)
   * console.log(HashMap.get(updated, "a")) // Option.some(2)
   * ```
   *
   * @since 2.0.0
   * @category models
   */
  export type UpdateFn<V> = (option: Option<V>) => Option<V>

  /**
   * This type-level utility extracts the key type `K` from a `HashMap<K, V>` type.
   *
   * @example
   * ```ts
   * import * as HashMap from "effect/HashMap"
   *
   * // Create a HashMap to extract key type from
   * const userMap = HashMap.make(
   *   ["alice", { name: "Alice", age: 30 }],
   *   ["bob", { name: "Bob", age: 25 }]
   * )
   *
   * // Extract the key type (string)
   * type UserKey = HashMap.HashMap.Key<typeof userMap>
   *
   * // Use the extracted type in functions
   * const getUserById = (id: UserKey) => HashMap.get(userMap, id)
   * console.log(getUserById("alice")) // Option.some({ name: "Alice", age: 30 })
   * ```
   * @since 2.0.0
   * @category type-level
   */
  export type Key<T extends HashMap<any, any>> = [T] extends [HashMap<infer _K, infer _V>] ? _K : never

  /**
   * This type-level utility extracts the value type `V` from a `HashMap<K, V>` type.
   *
   * @example
   * ```ts
   * import * as HashMap from "effect/HashMap"
   *
   * // Create a HashMap with user data
   * const userMap = HashMap.make(
   *   ["alice", { name: "Alice", age: 30, active: true }],
   *   ["bob", { name: "Bob", age: 25, active: false }]
   * )
   *
   * // Extract the value type (User object)
   * type User = HashMap.HashMap.Value<typeof userMap>
   *
   * // Use the extracted type for type-safe operations
   * const processUser = (user: User) => {
   *   return user.active ? `${user.name} (active)` : `${user.name} (inactive)`
   * }
   *
   * const alice = HashMap.get(userMap, "alice")
   * // alice has type Option<User> thanks to type extraction
   * ```
   * @since 2.0.0
   * @category type-level
   */
  export type Value<T extends HashMap<any, any>> = [T] extends [HashMap<infer _K, infer _V>] ? _V : never

  /**
   * This type-level utility extracts the entry type `[K, V]` from a `HashMap<K, V>` type.
   *
   * @example
   * ```ts
   * import * as HashMap from "effect/HashMap"
   *
   * // Create a product catalog HashMap
   * const catalog = HashMap.make(
   *   ["laptop", { price: 999, category: "electronics" }],
   *   ["book", { price: 29, category: "education" }]
   * )
   *
   * // Extract the entry type [string, Product]
   * type CatalogEntry = HashMap.HashMap.Entry<typeof catalog>
   *
   * // Use the extracted type for processing entries
   * const processEntry = ([productId, product]: CatalogEntry) => {
   *   return `${productId}: $${product.price} (${product.category})`
   * }
   *
   * // Convert to entries and process
   * const descriptions = HashMap.toEntries(catalog).map(processEntry)
   * console.log(descriptions) // ["laptop: $999 (electronics)", "book: $29 (education)"]
   * ```
   * @since 3.9.0
   * @category type-level
   */
  export type Entry<T extends HashMap<any, any>> = [Key<T>, Value<T>]
}

/**
 * Checks if a value is a HashMap.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map = HashMap.make(["a", 1], ["b", 2])
 * const notMap = { a: 1 }
 *
 * console.log(HashMap.isHashMap(map)) // true
 * console.log(HashMap.isHashMap(notMap)) // false
 * console.log(HashMap.isHashMap(null)) // false
 * ```
 *
 * @since 2.0.0
 * @category refinements
 */
export const isHashMap: {
  <K, V>(u: Iterable<readonly [K, V]>): u is HashMap<K, V>
  (u: unknown): u is HashMap<unknown, unknown>
} = internal.isHashMap

/**
 * Creates a new empty `HashMap`.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map = HashMap.empty<string, number>()
 * console.log(HashMap.isEmpty(map)) // true
 * console.log(HashMap.size(map)) // 0
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const empty: <K = never, V = never>() => HashMap<K, V> = internal.empty

/**
 * Constructs a new `HashMap` from an array of key/value pairs.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map = HashMap.make(["a", 1], ["b", 2], ["c", 3])
 * console.log(HashMap.size(map)) // 3
 * console.log(HashMap.get(map, "b")) // Option.some(2)
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const make: <Entries extends ReadonlyArray<readonly [any, any]>>(
  ...entries: Entries
) => HashMap<
  Entries[number] extends readonly [infer K, any] ? K : never,
  Entries[number] extends readonly [any, infer V] ? V : never
> = internal.make

/**
 * Creates a new `HashMap` from an iterable collection of key/value pairs.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const entries = [["a", 1], ["b", 2], ["c", 3]] as const
 * const map = HashMap.fromIterable(entries)
 * console.log(HashMap.size(map)) // 3
 * console.log(HashMap.get(map, "a")) // Option.some(1)
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const fromIterable: <K, V>(entries: Iterable<readonly [K, V]>) => HashMap<K, V> = internal.fromIterable

/**
 * Checks if the `HashMap` contains any entries.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const emptyMap = HashMap.empty<string, number>()
 * const nonEmptyMap = HashMap.make(["a", 1])
 *
 * console.log(HashMap.isEmpty(emptyMap)) // true
 * console.log(HashMap.isEmpty(nonEmptyMap)) // false
 * ```
 *
 * @since 2.0.0
 * @category elements
 */
export const isEmpty: <K, V>(self: HashMap<K, V>) => boolean = internal.isEmpty

/**
 * Safely lookup the value for the specified key in the `HashMap` using the
 * internal hashing function.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map = HashMap.make(["a", 1], ["b", 2])
 *
 * console.log(HashMap.get(map, "a")) // Option.some(1)
 * console.log(HashMap.get(map, "c")) // Option.none()
 *
 * // Using pipe syntax
 * const value = HashMap.get("b")(map)
 * console.log(value) // Option.some(2)
 * ```
 *
 * @since 2.0.0
 * @category elements
 */
export const get: {
  <K1 extends K, K>(key: K1): <V>(self: HashMap<K, V>) => Option<V>
  <K1 extends K, K, V>(self: HashMap<K, V>, key: K1): Option<V>
} = internal.get

/**
 * Lookup the value for the specified key in the `HashMap` using a custom hash.
 *
 * @example
 * ```ts
 * import { Hash } from "effect"
 * import * as HashMap from "effect/HashMap"
 *
 * // Useful when implementing custom equality for complex keys
 * const userMap = HashMap.make(
 *   ["user123", { name: "Alice", role: "admin" }],
 *   ["user456", { name: "Bob", role: "user" }]
 * )
 *
 * // Use precomputed hash for performance in hot paths
 * const userId = "user123"
 * const precomputedHash = Hash.string(userId)
 *
 * // Lookup with custom hash (e.g., cached hash value)
 * const user = HashMap.getHash(userMap, userId, precomputedHash)
 * console.log(user) // Option.some({ name: "Alice", role: "admin" })
 *
 * // This avoids recomputing the hash when you already have it
 * const notFound = HashMap.getHash(userMap, "user999", Hash.string("user999"))
 * console.log(notFound) // Option.none()
 * ```
 *
 * @since 2.0.0
 * @category elements
 */
export const getHash: {
  <K1 extends K, K>(key: K1, hash: number): <V>(self: HashMap<K, V>) => Option<V>
  <K1 extends K, K, V>(self: HashMap<K, V>, key: K1, hash: number): Option<V>
} = internal.getHash

/**
 * Unsafely lookup the value for the specified key in the `HashMap` using the
 * internal hashing function.
 *
 * ⚠️ **Warning**: This function throws an error if the key is not found.
 * Use `HashMap.get` for safe access that returns `Option`.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 * import * as Option from "effect/Option"
 *
 * const config = HashMap.make(
 *   ["api_url", "https://api.example.com"],
 *   ["timeout", "5000"],
 *   ["retries", "3"]
 * )
 *
 * // Safe: use when you're certain the key exists
 * const apiUrl = HashMap.getUnsafe(config, "api_url") // "https://api.example.com"
 * console.log(`Connecting to: ${apiUrl}`)
 *
 * // Preferred: use get() for uncertain keys
 * const dbUrl = HashMap.get(config, "db_url") // Option.none()
 * if (Option.isSome(dbUrl)) {
 *   console.log(`Database: ${dbUrl.value}`)
 * }
 *
 * // This would throw: HashMap.getUnsafe(config, "db_url")
 * // Error: "HashMap.getUnsafe: key not found"
 * ```
 *
 * @since 2.0.0
 * @category unsafe
 */
export const getUnsafe: {
  <K1 extends K, K>(key: K1): <V>(self: HashMap<K, V>) => V
  <K1 extends K, K, V>(self: HashMap<K, V>, key: K1): V
} = internal.getUnsafe

/**
 * Checks if the specified key has an entry in the `HashMap`.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map = HashMap.make(["a", 1], ["b", 2])
 *
 * console.log(HashMap.has(map, "a")) // true
 * console.log(HashMap.has(map, "c")) // false
 *
 * // Using pipe syntax
 * const hasB = HashMap.has("b")(map)
 * console.log(hasB) // true
 * ```
 *
 * @since 2.0.0
 * @category elements
 */
export const has: {
  <K1 extends K, K>(key: K1): <K, V>(self: HashMap<K, V>) => boolean
  <K1 extends K, K, V>(self: HashMap<K, V>, key: K1): boolean
} = internal.has

/**
 * Checks if the specified key has an entry in the `HashMap` using a custom
 * hash.
 *
 * @example
 * ```ts
 * import { Hash } from "effect"
 * import * as HashMap from "effect/HashMap"
 *
 * // Create a map with case-sensitive keys
 * const userMap = HashMap.make(
 *   ["Admin", { role: "administrator" }],
 *   ["User", { role: "standard" }]
 * )
 *
 * // Check with exact hash
 * const exactHash = Hash.string("Admin")
 * console.log(HashMap.hasHash(userMap, "Admin", exactHash)) // true
 *
 * // Check case-insensitive by using custom hash
 * const caseInsensitiveHash = Hash.string("admin".toLowerCase())
 * console.log(HashMap.hasHash(userMap, "admin", caseInsensitiveHash)) // false (different hash)
 * ```
 *
 * @since 2.0.0
 * @category elements
 */
export const hasHash: {
  <K1 extends K, K>(key: K1, hash: number): <V>(self: HashMap<K, V>) => boolean
  <K1 extends K, K, V>(self: HashMap<K, V>, key: K1, hash: number): boolean
} = internal.hasHash

/**
 * Checks if an element matching the given predicate exists in the given `HashMap`.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const hm = HashMap.make([1, "a"])
 * HashMap.hasBy(hm, (value, key) => value === "a" && key === 1) // -> true
 * HashMap.hasBy(hm, (value) => value === "b") // -> false
 * ```
 *
 * @since 3.16.0
 * @category elements
 */
export const hasBy: {
  <K, V>(predicate: (value: NoInfer<V>, key: NoInfer<K>) => boolean): (self: HashMap<K, V>) => boolean
  <K, V>(self: HashMap<K, V>, predicate: (value: NoInfer<V>, key: NoInfer<K>) => boolean): boolean
} = internal.hasBy

/**
 * Sets the specified key to the specified value using the internal hashing
 * function.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map1 = HashMap.make(["a", 1])
 * const map2 = HashMap.set(map1, "b", 2)
 *
 * console.log(HashMap.size(map2)) // 2
 * console.log(HashMap.get(map2, "b")) // Option.some(2)
 *
 * // Original map is unchanged
 * console.log(HashMap.size(map1)) // 1
 * ```
 *
 * @since 2.0.0
 * @category transformations
 */
export const set: {
  <K, V>(key: K, value: V): (self: HashMap<K, V>) => HashMap<K, V>
  <K, V>(self: HashMap<K, V>, key: K, value: V): HashMap<K, V>
} = internal.set

/**
 * Returns an `IterableIterator` of the keys within the `HashMap`.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map = HashMap.make(["a", 1], ["b", 2], ["c", 3])
 * const keys = Array.from(HashMap.keys(map))
 * console.log(keys.sort()) // ["a", "b", "c"]
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const keys: <K, V>(self: HashMap<K, V>) => IterableIterator<K> = internal.keys

/**
 * Returns an `IterableIterator` of the values within the `HashMap`.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map = HashMap.make(["a", 1], ["b", 2], ["c", 3])
 * const values = Array.from(HashMap.values(map))
 * console.log(values.sort()) // [1, 2, 3]
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const values: <K, V>(self: HashMap<K, V>) => IterableIterator<V> = internal.values

/**
 * Returns an `Array` of the values within the `HashMap`.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const employees = HashMap.make(
 *   ["alice", { department: "engineering", salary: 90000 }],
 *   ["bob", { department: "marketing", salary: 75000 }],
 *   ["charlie", { department: "engineering", salary: 95000 }]
 * )
 *
 * // Extract all employee records
 * const allEmployees = HashMap.toValues(employees)
 * console.log(allEmployees.length) // 3
 *
 * // Calculate total salary
 * const totalSalary = allEmployees.reduce((sum, emp) => sum + emp.salary, 0)
 * console.log(totalSalary) // 260000
 *
 * // Filter by department
 * const engineers = allEmployees.filter((emp) => emp.department === "engineering")
 * console.log(engineers.length) // 2
 * ```
 *
 * @since 3.13.0
 * @category getters
 */
export const toValues = <K, V>(self: HashMap<K, V>): Array<V> => Array.from(values(self))

/**
 * Returns an `IterableIterator` of the entries within the `HashMap`.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * // Create a configuration map
 * const config = HashMap.make(
 *   ["database.host", "localhost"],
 *   ["database.port", "5432"],
 *   ["cache.enabled", "true"]
 * )
 *
 * // Get entries iterator for processing
 * const entries = HashMap.entries(config)
 *
 * // Process each configuration entry
 * for (const [key, value] of entries) {
 *   console.log(`Setting ${key} = ${value}`)
 * }
 * // Setting database.host = localhost
 * // Setting database.port = 5432
 * // Setting cache.enabled = true
 *
 * // Convert to array when you need all entries at once
 * const allEntries = Array.from(HashMap.entries(config))
 * console.log(allEntries.length) // 3
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const entries: <K, V>(self: HashMap<K, V>) => IterableIterator<[K, V]> = internal.entries

/**
 * Returns an `Array<[K, V]>` of the entries within the `HashMap`.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const gameScores = HashMap.make(
 *   ["alice", 1250],
 *   ["bob", 980],
 *   ["charlie", 1100]
 * )
 *
 * // Convert to entries for processing
 * const scoreEntries = HashMap.toEntries(gameScores)
 *
 * // Sort by score (descending)
 * const leaderboard = scoreEntries
 *   .sort(([, a], [, b]) => b - a)
 *   .map(([player, score], rank) => `${rank + 1}. ${player}: ${score}`)
 *
 * console.log(leaderboard)
 * // ["1. alice: 1250", "2. charlie: 1100", "3. bob: 980"]
 *
 * // Convert back to HashMap if needed
 * const sortedMap = HashMap.fromIterable(scoreEntries)
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const toEntries = <K, V>(self: HashMap<K, V>): Array<[K, V]> => Array.from(entries(self))

/**
 * Returns the number of entries within the `HashMap`.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const emptyMap = HashMap.empty<string, number>()
 * const map = HashMap.make(["a", 1], ["b", 2], ["c", 3])
 *
 * console.log(HashMap.size(emptyMap)) // 0
 * console.log(HashMap.size(map)) // 3
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const size: <K, V>(self: HashMap<K, V>) => number = internal.size

/**
 * Marks the `HashMap` as mutable for performance optimization during batch operations.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map = HashMap.make(["a", 1])
 *
 * // Begin mutation for efficient batch operations
 * const mutable = HashMap.beginMutation(map)
 *
 * // Multiple operations are now more efficient
 * HashMap.set(mutable, "b", 2)
 * HashMap.set(mutable, "c", 3)
 * HashMap.remove(mutable, "a")
 *
 * // End mutation to get final immutable result
 * const result = HashMap.endMutation(mutable)
 * console.log(HashMap.size(result)) // 2
 * ```
 *
 * @since 2.0.0
 * @category mutations
 */
export const beginMutation: <K, V>(self: HashMap<K, V>) => HashMap<K, V> = internal.beginMutation

/**
 * Marks the `HashMap` as immutable, completing the mutation cycle.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * // Start with an existing map
 * const original = HashMap.make(["x", 10], ["y", 20])
 *
 * // Begin mutation for batch operations
 * const mutable = HashMap.beginMutation(original)
 *
 * // Perform multiple efficient operations
 * HashMap.set(mutable, "z", 30)
 * HashMap.remove(mutable, "x")
 * HashMap.set(mutable, "w", 40)
 *
 * // End mutation to get final immutable result
 * const final = HashMap.endMutation(mutable)
 *
 * console.log(HashMap.size(final)) // 3
 * console.log(HashMap.has(final, "x")) // false
 * console.log(HashMap.get(final, "z")) // Option.some(30)
 * ```
 *
 * @since 2.0.0
 * @category mutations
 */
export const endMutation: <K, V>(self: HashMap<K, V>) => HashMap<K, V> = internal.endMutation

/**
 * Mutates the `HashMap` within the context of the provided function.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map1 = HashMap.make(["a", 1])
 * const map2 = HashMap.mutate(map1, (mutable) => {
 *   HashMap.set(mutable, "b", 2)
 *   HashMap.set(mutable, "c", 3)
 * })
 * // Returns a new HashMap with mutations applied
 * ```
 *
 * @since 2.0.0
 * @category mutations
 */
export const mutate: {
  <K, V>(f: (self: HashMap<K, V>) => void): (self: HashMap<K, V>) => HashMap<K, V>
  <K, V>(self: HashMap<K, V>, f: (self: HashMap<K, V>) => void): HashMap<K, V>
} = internal.mutate

/**
 * Set or remove the specified key in the `HashMap` using the specified
 * update function. The value of the specified key will be computed using the
 * provided hash.
 *
 * The update function will be invoked with the current value of the key if it
 * exists, or `None` if no such value exists.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 * import * as Option from "effect/Option"
 *
 * const map = HashMap.make(["a", 1], ["b", 2])
 *
 * // Increment existing value or set to 1 if not present
 * const updateFn = (option: Option.Option<number>) =>
 *   Option.isSome(option) ? Option.some(option.value + 1) : Option.some(1)
 *
 * const updated = HashMap.modifyAt(map, "a", updateFn)
 * console.log(HashMap.get(updated, "a")) // Option.some(2)
 * ```
 *
 * @since 2.0.0
 * @category transformations
 */
export const modifyAt: {
  <K, V>(key: K, f: HashMap.UpdateFn<V>): (self: HashMap<K, V>) => HashMap<K, V>
  <K, V>(self: HashMap<K, V>, key: K, f: HashMap.UpdateFn<V>): HashMap<K, V>
} = internal.modifyAt

/**
 * Alter the value of the specified key in the `HashMap` using the specified
 * update function. The value of the specified key will be computed using the
 * provided hash.
 *
 * The update function will be invoked with the current value of the key if it
 * exists, or `None` if no such value exists.
 *
 * This function will always either update or insert a value into the `HashMap`.
 *
 * @example
 * ```ts
 * import { Hash } from "effect"
 * import * as HashMap from "effect/HashMap"
 * import * as Option from "effect/Option"
 *
 * // Useful when working with precomputed hashes for performance
 * const counters = HashMap.make(["downloads", 100], ["views", 250])
 *
 * // Cache hash computation for frequently accessed keys
 * const metricKey = "downloads"
 * const cachedHash = Hash.string(metricKey)
 *
 * // Update function that increments counter or initializes to 1
 * const incrementCounter = (current: Option.Option<number>) =>
 *   Option.isSome(current) ? Option.some(current.value + 1) : Option.some(1)
 *
 * // Use cached hash for efficient updates in loops
 * const updated = HashMap.modifyHash(
 *   counters,
 *   metricKey,
 *   cachedHash,
 *   incrementCounter
 * )
 * console.log(HashMap.get(updated, "downloads")) // Option.some(101)
 *
 * // Add new metric with precomputed hash
 * const newMetric = "clicks"
 * const clicksHash = Hash.string(newMetric)
 * const withClicks = HashMap.modifyHash(
 *   updated,
 *   newMetric,
 *   clicksHash,
 *   incrementCounter
 * )
 * console.log(HashMap.get(withClicks, "clicks")) // Option.some(1)
 * ```
 *
 * @since 2.0.0
 * @category transformations
 */
export const modifyHash: {
  <K, V>(key: K, hash: number, f: HashMap.UpdateFn<V>): (self: HashMap<K, V>) => HashMap<K, V>
  <K, V>(self: HashMap<K, V>, key: K, hash: number, f: HashMap.UpdateFn<V>): HashMap<K, V>
} = internal.modifyHash

/**
 * Updates the value of the specified key within the `HashMap` if it exists.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map1 = HashMap.make(["a", 1], ["b", 2])
 * const map2 = HashMap.modify(map1, "a", (value) => value * 3)
 *
 * console.log(HashMap.get(map2, "a")) // Option.some(3)
 * console.log(HashMap.get(map2, "b")) // Option.some(2)
 * ```
 *
 * @since 2.0.0
 * @category transformations
 */
export const modify: {
  <K, V>(key: K, f: (v: V) => V): (self: HashMap<K, V>) => HashMap<K, V>
  <K, V>(self: HashMap<K, V>, key: K, f: (v: V) => V): HashMap<K, V>
} = internal.modify

/**
 * Performs a union of this `HashMap` and that `HashMap`.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map1 = HashMap.make(["a", 1], ["b", 2])
 * const map2 = HashMap.make(["b", 20], ["c", 3])
 * const union = HashMap.union(map1, map2)
 *
 * console.log(HashMap.size(union)) // 3
 * console.log(HashMap.get(union, "b")) // Option.some(20) - map2 wins
 * ```
 *
 * @since 2.0.0
 * @category combining
 */
export const union: {
  <K1, V1>(that: HashMap<K1, V1>): <K0, V0>(self: HashMap<K0, V0>) => HashMap<K1 | K0, V1 | V0>
  <K0, V0, K1, V1>(self: HashMap<K0, V0>, that: HashMap<K1, V1>): HashMap<K0 | K1, V0 | V1>
} = internal.union

/**
 * Remove the entry for the specified key in the `HashMap` using the internal
 * hashing function.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map1 = HashMap.make(["a", 1], ["b", 2], ["c", 3])
 * const map2 = HashMap.remove(map1, "b")
 *
 * console.log(HashMap.size(map2)) // 2
 * console.log(HashMap.has(map2, "b")) // false
 * console.log(HashMap.has(map2, "a")) // true
 * ```
 *
 * @since 2.0.0
 * @category transformations
 */
export const remove: {
  <K>(key: K): <V>(self: HashMap<K, V>) => HashMap<K, V>
  <K, V>(self: HashMap<K, V>, key: K): HashMap<K, V>
} = internal.remove

/**
 * Removes all entries in the `HashMap` which have the specified keys.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map1 = HashMap.make(["a", 1], ["b", 2], ["c", 3], ["d", 4])
 * const map2 = HashMap.removeMany(map1, ["b", "d"])
 *
 * console.log(HashMap.size(map2)) // 2
 * console.log(HashMap.has(map2, "a")) // true
 * console.log(HashMap.has(map2, "c")) // true
 * ```
 *
 * @since 2.0.0
 * @category transformations
 */
export const removeMany: {
  <K>(keys: Iterable<K>): <V>(self: HashMap<K, V>) => HashMap<K, V>
  <K, V>(self: HashMap<K, V>, keys: Iterable<K>): HashMap<K, V>
} = internal.removeMany

/**
 * Sets multiple key-value pairs in the `HashMap`.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map1 = HashMap.make(["a", 1], ["b", 2])
 * const newEntries = [["c", 3], ["d", 4], ["a", 10]] as const // "a" will be overwritten
 * const map2 = HashMap.setMany(map1, newEntries)
 *
 * console.log(HashMap.size(map2)) // 4
 * console.log(HashMap.get(map2, "a")) // Option.some(10)
 * console.log(HashMap.get(map2, "c")) // Option.some(3)
 * ```
 *
 * @since 2.0.0
 * @category transformations
 */
export const setMany: {
  <K, V>(entries: Iterable<readonly [K, V]>): (self: HashMap<K, V>) => HashMap<K, V>
  <K, V>(self: HashMap<K, V>, entries: Iterable<readonly [K, V]>): HashMap<K, V>
} = internal.setMany

/**
 * Maps over the entries of the `HashMap` using the specified function.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map1 = HashMap.make(["a", 1], ["b", 2], ["c", 3])
 * const map2 = HashMap.map(map1, (value, key) => `${key}:${value * 2}`)
 *
 * console.log(HashMap.get(map2, "a")) // Option.some("a:2")
 * console.log(HashMap.get(map2, "b")) // Option.some("b:4")
 * ```
 *
 * @since 2.0.0
 * @category mapping
 */
export const map: {
  <A, V, K>(f: (value: V, key: K) => A): (self: HashMap<K, V>) => HashMap<K, A>
  <K, V, A>(self: HashMap<K, V>, f: (value: V, key: K) => A): HashMap<K, A>
} = internal.map

/**
 * Chains over the entries of the `HashMap` using the specified function.
 *
 * **NOTE**: the hash and equal of both maps have to be the same.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map1 = HashMap.make(["a", 1], ["b", 2])
 * const map2 = HashMap.flatMap(
 *   map1,
 *   (value, key) => HashMap.make([key + "1", value], [key + "2", value * 2])
 * )
 *
 * console.log(HashMap.size(map2)) // 4
 * console.log(HashMap.get(map2, "a1")) // Option.some(1)
 * console.log(HashMap.get(map2, "b2")) // Option.some(4)
 * ```
 *
 * @since 2.0.0
 * @category sequencing
 */
export const flatMap: {
  <A, K, B>(f: (value: A, key: K) => HashMap<K, B>): (self: HashMap<K, A>) => HashMap<K, B>
  <K, A, B>(self: HashMap<K, A>, f: (value: A, key: K) => HashMap<K, B>): HashMap<K, B>
} = internal.flatMap

/**
 * Applies the specified function to the entries of the `HashMap`.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map = HashMap.make(["a", 1], ["b", 2])
 * const collected: Array<[string, number]> = []
 *
 * HashMap.forEach(map, (value, key) => {
 *   collected.push([key, value])
 * })
 *
 * console.log(collected.sort()) // [["a", 1], ["b", 2]]
 * ```
 *
 * @since 2.0.0
 * @category traversing
 */
export const forEach: {
  <V, K>(f: (value: V, key: K) => void): (self: HashMap<K, V>) => void
  <V, K>(self: HashMap<K, V>, f: (value: V, key: K) => void): void
} = internal.forEach

/**
 * Reduces the specified state over the entries of the `HashMap`.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map = HashMap.make(["a", 1], ["b", 2], ["c", 3])
 * const sum = HashMap.reduce(map, 0, (acc, value) => acc + value)
 *
 * console.log(sum) // 6
 * ```
 *
 * @since 2.0.0
 * @category folding
 */
export const reduce: {
  <Z, V, K>(zero: Z, f: (accumulator: Z, value: V, key: K) => Z): (self: HashMap<K, V>) => Z
  <K, V, Z>(self: HashMap<K, V>, zero: Z, f: (accumulator: Z, value: V, key: K) => Z): Z
} = internal.reduce

/**
 * Filters entries out of a `HashMap` using the specified predicate.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map1 = HashMap.make(["a", 1], ["b", 2], ["c", 3], ["d", 4])
 * const map2 = HashMap.filter(map1, (value) => value % 2 === 0)
 *
 * console.log(HashMap.size(map2)) // 2
 * console.log(HashMap.has(map2, "b")) // true
 * console.log(HashMap.has(map2, "d")) // true
 * console.log(HashMap.has(map2, "a")) // false
 * ```
 *
 * @since 2.0.0
 * @category filtering
 */
export const filter: {
  <K, A>(f: (a: NoInfer<A>, k: K) => boolean): (self: HashMap<K, A>) => HashMap<K, A>
  <K, A>(self: HashMap<K, A>, f: (a: A, k: K) => boolean): HashMap<K, A>
} = internal.filter

/**
 * Filters out `None` values from a `HashMap` of `Options`s.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 * import * as Option from "effect/Option"
 *
 * const map1 = HashMap.make(
 *   ["a", Option.some(1)],
 *   ["b", Option.none()],
 *   ["c", Option.some(3)]
 * )
 * const map2 = HashMap.compact(map1)
 *
 * console.log(HashMap.size(map2)) // 2
 * console.log(HashMap.get(map2, "a")) // Option.some(1)
 * console.log(HashMap.has(map2, "b")) // false
 * ```
 *
 * @since 2.0.0
 * @category filtering
 */
export const compact: <K, A>(self: HashMap<K, Option<A>>) => HashMap<K, A> = internal.compact

/**
 * Maps over the entries of the `HashMap` using the specified filter and keeps
 * only successful results.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 * import * as Result from "effect/Result"
 *
 * const map1 = HashMap.make(["a", 1], ["b", 2], ["c", 3], ["d", 4])
 * const map2 = HashMap.filterMap(
 *   map1,
 *   (value) => value % 2 === 0 ? Result.succeed(value * 2) : Result.failVoid
 * )
 *
 * console.log(HashMap.size(map2)) // 2
 * console.log(HashMap.get(map2, "b")) // Option.some(4)
 * console.log(HashMap.get(map2, "d")) // Option.some(8)
 * ```
 *
 * @since 2.0.0
 * @category filtering
 */
export const filterMap: {
  <A, K, B, X>(f: (input: A, key: K) => Result<B, X>): (self: HashMap<K, A>) => HashMap<K, B>
  <K, A, B, X>(self: HashMap<K, A>, f: (input: A, key: K) => Result<B, X>): HashMap<K, B>
} = internal.filterMap

/**
 * Returns the first element that satisfies the specified
 * predicate, or `None` if no such element exists.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 * import * as Option from "effect/Option"
 *
 * const map = HashMap.make(["a", 1], ["b", 2], ["c", 3])
 * const result = HashMap.findFirst(map, (value) => value > 1)
 * console.log(result) // Option.some(["c", 3])
 * console.log(Option.getOrElse(result, () => ["", 0])) // ["c", 3]
 * ```
 *
 * @category elements
 * @since 2.0.0
 */
export const findFirst: {
  <K, A>(predicate: (a: NoInfer<A>, k: K) => boolean): (self: HashMap<K, A>) => Option<[K, A]>
  <K, A>(self: HashMap<K, A>, predicate: (a: A, k: K) => boolean): Option<[K, A]>
} = internal.findFirst

/**
 * Checks if any entry in a hashmap meets a specific condition.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map = HashMap.make(["a", 1], ["b", 2], ["c", 3])
 *
 * console.log(HashMap.some(map, (value) => value > 2)) // true
 * console.log(HashMap.some(map, (value) => value > 5)) // false
 * ```
 *
 * @since 3.13.0
 * @category elements
 */
export const some: {
  <K, A>(predicate: (a: NoInfer<A>, k: K) => boolean): (self: HashMap<K, A>) => boolean
  <K, A>(self: HashMap<K, A>, predicate: (a: A, k: K) => boolean): boolean
} = internal.some

/**
 * Checks if all entries in a hashmap meets a specific condition.
 *
 * @example
 * ```ts
 * import * as HashMap from "effect/HashMap"
 *
 * const map = HashMap.make(["a", 1], ["b", 2], ["c", 3])
 *
 * console.log(HashMap.every(map, (value) => value > 0)) // true
 * console.log(HashMap.every(map, (value) => value > 1)) // false
 * ```
 *
 * @param self - The hashmap to check.
 * @param predicate - The condition to test entries (value, key).
 *
 * @since 3.14.0
 * @category elements
 */
export const every: {
  <K, A>(predicate: (a: NoInfer<A>, k: K) => boolean): (self: HashMap<K, A>) => boolean
  <K, A>(self: HashMap<K, A>, predicate: (a: A, k: K) => boolean): boolean
} = internal.every

/**
 * This module provides utility functions for working with records in TypeScript.
 *
 * @since 2.0.0
 */

import type * as Combiner from "./Combiner.ts"
import * as Equal from "./Equal.ts"
import type { Equivalence } from "./Equivalence.ts"
import { dual, identity } from "./Function.ts"
import type { TypeLambda } from "./HKT.ts"
import * as Option from "./Option.ts"
import * as Reducer from "./Reducer.ts"
import type { Result } from "./Result.ts"
import * as R from "./Result.ts"
import type { NoInfer } from "./Types.ts"

/**
 * Represents a readonly record with keys of type `K` and values of type `A`.
 * This is the foundational type for immutable key-value mappings in Effect.
 *
 * @example
 * ```ts
 * import type { Record } from "effect"
 *
 * // Creating a readonly record type
 * type UserRecord = Record.ReadonlyRecord<"name" | "age", string | number>
 *
 * const user: UserRecord = {
 *   name: "John",
 *   age: 30
 * }
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export type ReadonlyRecord<in out K extends string | symbol, out A> = {
  readonly [P in K]: A
}

/**
 * Namespace containing utility types for working with readonly records.
 * These types help with type-level operations on record keys and values.
 *
 * @example
 * ```ts
 * import type { Record } from "effect"
 *
 * // Using NonLiteralKey to convert literal keys to generic types
 * type GenericKey = Record.ReadonlyRecord.NonLiteralKey<"foo" | "bar"> // string
 *
 * // Using IntersectKeys to find common keys between record types
 * type CommonKeys = Record.ReadonlyRecord.IntersectKeys<"a" | "b", "b" | "c"> // "b"
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export declare namespace ReadonlyRecord {
  type IsFiniteString<T extends string> = T extends "" ? true :
    [T] extends [`${infer Head}${infer Rest}`]
      ? string extends Head ? false : `${number}` extends Head ? false : Rest extends "" ? true : IsFiniteString<Rest>
    : false

  /**
   * Represents a type that converts literal string keys to generic string type and symbol keys to generic symbol type.
   * This is useful for maintaining type safety while allowing flexible key types in record operations.
   *
   * @example
   * ```ts
   * import type { Record } from "effect"
   *
   * // For literal string keys, this becomes 'string'
   * type Example1 = Record.ReadonlyRecord.NonLiteralKey<"foo" | "bar"> // string
   *
   * // For symbol keys, this becomes 'symbol'
   * type Example2 = Record.ReadonlyRecord.NonLiteralKey<symbol> // symbol
   * ```
   *
   * @category models
   * @since 2.0.0
   */
  export type NonLiteralKey<K extends string | symbol> = K extends string ? IsFiniteString<K> extends true ? string : K
    : symbol

  /**
   * Represents the intersection of two key types, handling both literal and non-literal string keys.
   * This type is used in record operations that need to compute overlapping keys.
   *
   * @example
   * ```ts
   * import type { Record } from "effect"
   *
   * // Intersection of literal keys
   * type Example1 = Record.ReadonlyRecord.IntersectKeys<"a" | "b", "b" | "c"> // "b"
   *
   * // Intersection with generic string
   * type Example2 = Record.ReadonlyRecord.IntersectKeys<string, "a" | "b"> // string
   * ```
   *
   * @category models
   * @since 2.0.0
   */
  export type IntersectKeys<K1 extends string, K2 extends string> = [string] extends [K1 | K2] ?
    NonLiteralKey<K1> & NonLiteralKey<K2>
    : K1 & K2
}

/**
 * Type lambda for readonly records, used in higher-kinded type operations.
 * This enables records to work with generic type constructors and functors.
 *
 * @example
 * ```ts
 * import type { Record } from "effect"
 *
 * // The type lambda allows records to be used as higher-kinded types
 * type RecordTypeLambda = Record.ReadonlyRecordTypeLambda<"key1" | "key2">
 *
 * // This enables mapping over the type parameter
 * type StringRecord = RecordTypeLambda["type"] // ReadonlyRecord<"key1" | "key2", Target>
 * ```
 *
 * @category type lambdas
 * @since 2.0.0
 */
export interface ReadonlyRecordTypeLambda<K extends string = string> extends TypeLambda {
  readonly type: ReadonlyRecord<K, this["Target"]>
}

/**
 * Creates a new, empty record.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 *
 * // Create an empty record
 * const emptyRecord = Record.empty<string, number>()
 * console.log(emptyRecord) // {}
 *
 * // The type ensures type safety for future operations
 * const withValue = Record.set(emptyRecord, "count", 42)
 * console.log(withValue) // { count: 42 }
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const empty = <K extends string | symbol = never, V = never>(): Record<
  ReadonlyRecord.NonLiteralKey<K>,
  V
> => ({} as any)

/**
 * Determine if a record is empty.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Record.isEmptyRecord({}), true)
 * assert.deepStrictEqual(Record.isEmptyRecord({ a: 3 }), false)
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isEmptyRecord = <K extends string, A>(self: Record<K, A>): self is Record<K, never> =>
  Object.keys(self).length === 0

/**
 * Determine if a record is empty.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Record.isEmptyReadonlyRecord({}), true)
 * assert.deepStrictEqual(Record.isEmptyReadonlyRecord({ a: 3 }), false)
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isEmptyReadonlyRecord: <K extends string, A>(
  self: ReadonlyRecord<K, A>
) => self is ReadonlyRecord<K, never> = isEmptyRecord

/**
 * Takes an iterable and a projection function and returns a record.
 * The projection function maps each value of the iterable to a tuple of a key and a value, which is then added to the resulting record.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * const input = [1, 2, 3, 4]
 *
 * assert.deepStrictEqual(
 *   Record.fromIterableWith(input, (a) => [String(a), a * 2]),
 *   { "1": 2, "2": 4, "3": 6, "4": 8 }
 * )
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const fromIterableWith: {
  <A, K extends string | symbol, B>(
    f: (a: A) => readonly [K, B]
  ): (self: Iterable<A>) => Record<ReadonlyRecord.NonLiteralKey<K>, B>
  <A, K extends string | symbol, B>(
    self: Iterable<A>,
    f: (a: A) => readonly [K, B]
  ): Record<ReadonlyRecord.NonLiteralKey<K>, B>
} = dual(
  2,
  <A, K extends string, B>(
    self: Iterable<A>,
    f: (a: A) => readonly [K, B]
  ): Record<ReadonlyRecord.NonLiteralKey<K>, B> => {
    const out: Record<string, B> = empty()
    for (const a of self) {
      const [k, b] = f(a)
      out[k] = b
    }
    return out
  }
)

/**
 * Creates a new record from an iterable, utilizing the provided function to determine the key for each element.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * const users = [
 *   { id: "2", name: "name2" },
 *   { id: "1", name: "name1" }
 * ]
 *
 * assert.deepStrictEqual(
 *   Record.fromIterableBy(users, (user) => user.id),
 *   {
 *     "2": { id: "2", name: "name2" },
 *     "1": { id: "1", name: "name1" }
 *   }
 * )
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const fromIterableBy = <A, K extends string | symbol>(
  items: Iterable<A>,
  f: (a: A) => K
): Record<ReadonlyRecord.NonLiteralKey<K>, A> => fromIterableWith(items, (a) => [f(a), a])

/**
 * Builds a record from an iterable of key-value pairs.
 *
 * If there are conflicting keys when using `fromEntries`, the last occurrence of the key/value pair will overwrite the
 * previous ones. So the resulting record will only have the value of the last occurrence of each key.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * const input: Array<[string, number]> = [["a", 1], ["b", 2]]
 *
 * assert.deepStrictEqual(Record.fromEntries(input), { a: 1, b: 2 })
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const fromEntries: <Entry extends readonly [string | symbol, any]>(
  entries: Iterable<Entry>
) => Record<ReadonlyRecord.NonLiteralKey<Entry[0]>, Entry[1]> = Object.fromEntries

/**
 * Transforms the values of a record into an `Array` with a custom mapping function.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * const x = { a: 1, b: 2, c: 3 }
 * assert.deepStrictEqual(Record.collect(x, (key, n) => [key, n]), [["a", 1], [
 *   "b",
 *   2
 * ], ["c", 3]])
 * ```
 *
 * @category conversions
 * @since 2.0.0
 */
export const collect: {
  <K extends string, A, B>(f: (key: K, a: A) => B): (self: ReadonlyRecord<K, A>) => Array<B>
  <K extends string, A, B>(self: ReadonlyRecord<K, A>, f: (key: K, a: A) => B): Array<B>
} = dual(
  2,
  <K extends string, A, B>(self: ReadonlyRecord<K, A>, f: (key: K, a: A) => B): Array<B> => {
    const out: Array<B> = []
    for (const key of keys(self)) {
      out.push(f(key, self[key]))
    }
    return out
  }
)

/**
 * Takes a record and returns an array of tuples containing its keys and values.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * const x = { a: 1, b: 2, c: 3 }
 * assert.deepStrictEqual(Record.toEntries(x), [["a", 1], ["b", 2], ["c", 3]])
 * ```
 *
 * @category conversions
 * @since 2.0.0
 */
export const toEntries: <K extends string, A>(self: ReadonlyRecord<K, A>) => Array<[K, A]> = collect((
  key,
  value
) => [key, value])

/**
 * Returns the number of key/value pairs in a record.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Record.size({ a: "a", b: 1, c: true }), 3)
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const size = <K extends string, A>(self: ReadonlyRecord<K, A>): number => keys(self).length

/**
 * Check if a given `key` exists in a record.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Record.has({ a: 1, b: 2 }, "a"), true)
 * assert.deepStrictEqual(Record.has(Record.empty<string>(), "c"), false)
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const has: {
  <K extends string | symbol>(
    key: NoInfer<K>
  ): <A>(self: ReadonlyRecord<K, A>) => boolean
  <K extends string | symbol, A>(
    self: ReadonlyRecord<K, A>,
    key: NoInfer<K>
  ): boolean
} = dual(
  2,
  <K extends string | symbol, A>(
    self: ReadonlyRecord<K, A>,
    key: NoInfer<K>
  ): boolean => Object.hasOwn(self, key)
)

/**
 * Retrieve a value at a particular key from a record, returning it wrapped in an `Option`.
 *
 * @example
 * ```ts
 * import { Option, Record as R } from "effect"
 * import * as assert from "node:assert"
 *
 * const person: Record<string, unknown> = { name: "John Doe", age: 35 }
 *
 * assert.deepStrictEqual(R.get(person, "name"), Option.some("John Doe"))
 * assert.deepStrictEqual(R.get(person, "email"), Option.none())
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const get: {
  <K extends string | symbol>(key: NoInfer<K>): <A>(self: ReadonlyRecord<K, A>) => Option.Option<A>
  <K extends string | symbol, A>(self: ReadonlyRecord<K, A>, key: NoInfer<K>): Option.Option<A>
} = dual(
  2,
  <K extends string | symbol, A>(self: ReadonlyRecord<K, A>, key: NoInfer<K>): Option.Option<A> =>
    has(self, key) ? Option.some(self[key]) : Option.none()
)

/**
 * Apply a function to the element at the specified key, creating a new record,
 * or return `Option.none()` if the key doesn't exist.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 *
 * const f = (x: number) => x * 2
 *
 * const input: Record<string, number> = { a: 3 }
 *
 * Record.modify(input, "a", f) // Option.some({ a: 6 })
 * Record.modify(input, "b", f) // Option.none()
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const modify: {
  <K extends string | symbol, A, B>(
    key: NoInfer<K>,
    f: (a: A) => B
  ): (self: ReadonlyRecord<K, A>) => Option.Option<Record<K, A | B>>
  <K extends string | symbol, A, B>(
    self: ReadonlyRecord<K, A>,
    key: NoInfer<K>,
    f: (a: A) => B
  ): Option.Option<Record<K, A | B>>
} = dual(
  3,
  <K extends string | symbol, A, B>(
    self: ReadonlyRecord<K, A>,
    key: NoInfer<K>,
    f: (a: A) => B
  ): Option.Option<Record<K, A | B>> => {
    if (!has(self, key)) return Option.none()
    return Option.some({ ...self, [key]: f(self[key]) })
  }
)

/**
 * Replaces a value in the record with the new value passed as parameter.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 *
 * Record.replace({ a: 1, b: 2, c: 3 }, "a", 10) // Option.some({ a: 10, b: 2, c: 3 })
 * Record.replace(Record.empty<string>(), "a", 10) // Option.none()
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const replace: {
  <K extends string | symbol, B>(
    key: NoInfer<K>,
    b: B
  ): <A>(self: ReadonlyRecord<K, A>) => Option.Option<Record<K, A | B>>
  <K extends string | symbol, A, B>(
    self: ReadonlyRecord<K, A>,
    key: NoInfer<K>,
    b: B
  ): Option.Option<Record<K, A | B>>
} = dual(
  3,
  <K extends string | symbol, A, B>(
    self: ReadonlyRecord<K, A>,
    key: NoInfer<K>,
    b: B
  ): Option.Option<Record<K, A | B>> => modify(self, key, () => b)
)

/**
 * If the given key exists in the record, returns a new record with the key removed.
 * If the key does not exist, returns a shallow copy of the original record.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Record.remove({ a: 1, b: 2 }, "a"), { b: 2 })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const remove: {
  <K extends string | symbol, X extends K>(key: X): <A>(self: ReadonlyRecord<K, A>) => Record<Exclude<K, X>, A>
  <K extends string | symbol, A, X extends K>(self: ReadonlyRecord<K, A>, key: X): Record<Exclude<K, X>, A>
} = dual(
  2,
  <K extends string | symbol, A, X extends K>(self: ReadonlyRecord<K, A>, key: X): Record<Exclude<K, X>, A> => {
    if (!has(self, key)) {
      return { ...self }
    }
    const out = { ...self }
    delete out[key]
    return out
  }
)

/**
 * Retrieves the value of the property with the given `key` from a record and returns an `Option`
 * of a tuple with the value and the record with the removed property.
 * If the key is not present, returns `Option.none()`.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 *
 * const input: Record<string, number> = { a: 1, b: 2 }
 *
 * Record.pop(input, "a") // Option.some([1, { b: 2 }])
 * Record.pop(input, "c") // Option.none()
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const pop: {
  <K extends string | symbol, X extends K>(
    key: X
  ): <A>(self: ReadonlyRecord<K, A>) => Option.Option<[A, Record<Exclude<K, X>, A>]>
  <K extends string | symbol, A, X extends K>(
    self: ReadonlyRecord<K, A>,
    key: X
  ): Option.Option<[A, Record<Exclude<K, X>, A>]>
} = dual(2, <K extends string | symbol, A, X extends K>(
  self: ReadonlyRecord<K, A>,
  key: X
): Option.Option<[A, Record<Exclude<K, X>, A>]> =>
  has(self, key) ? Option.some([self[key], remove(self, key)]) : Option.none())

/**
 * Maps a record into another record by applying a transformation function to each of its values.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * const f = (n: number) => `-${n}`
 *
 * assert.deepStrictEqual(Record.map({ a: 3, b: 5 }, f), { a: "-3", b: "-5" })
 *
 * const g = (n: number, key: string) => `${key.toUpperCase()}-${n}`
 *
 * assert.deepStrictEqual(Record.map({ a: 3, b: 5 }, g), { a: "A-3", b: "B-5" })
 * ```
 *
 * @category mapping
 * @since 2.0.0
 */
export const map: {
  <K extends string, A, B>(f: (a: A, key: NoInfer<K>) => B): (self: ReadonlyRecord<K, A>) => Record<K, B>
  <K extends string, A, B>(self: ReadonlyRecord<K, A>, f: (a: A, key: NoInfer<K>) => B): Record<K, B>
} = dual(
  2,
  <K extends string, A, B>(self: ReadonlyRecord<K, A>, f: (a: A, key: NoInfer<K>) => B): Record<K, B> => {
    const out: Record<K, B> = { ...self } as any
    for (const key of keys(self)) {
      out[key] = f(self[key], key)
    }
    return out
  }
)

/**
 * Maps the keys of a `ReadonlyRecord` while preserving the corresponding values.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   Record.mapKeys({ a: 3, b: 5 }, (key) => key.toUpperCase()),
 *   { A: 3, B: 5 }
 * )
 * ```
 *
 * @category mapping
 * @since 2.0.0
 */
export const mapKeys: {
  <K extends string, A, K2 extends string>(
    f: (key: K, a: A) => K2
  ): (self: ReadonlyRecord<K, A>) => Record<K2, A>
  <K extends string, A, K2 extends string>(
    self: ReadonlyRecord<K, A>,
    f: (key: K, a: A) => K2
  ): Record<K2, A>
} = dual(
  2,
  <K extends string, A, K2 extends string>(
    self: ReadonlyRecord<K, A>,
    f: (key: K, a: A) => K2
  ): Record<K2, A> => {
    const out: Record<K2, A> = {} as any
    for (const key of keys(self)) {
      const a = self[key]
      out[f(key, a)] = a
    }
    return out
  }
)

/**
 * Maps entries of a `ReadonlyRecord` using the provided function, allowing modification of both keys and corresponding values.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   Record.mapEntries({ a: 3, b: 5 }, (a, key) => [key.toUpperCase(), a + 1]),
 *   { A: 4, B: 6 }
 * )
 * ```
 *
 * @category mapping
 * @since 2.0.0
 */
export const mapEntries: {
  <K extends string, A, K2 extends string, B>(
    f: (a: A, key: K) => readonly [K2, B]
  ): (self: ReadonlyRecord<K, A>) => Record<K2, B>
  <K extends string, A, K2 extends string, B>(
    self: ReadonlyRecord<K, A>,
    f: (a: A, key: K) => [K2, B]
  ): Record<K2, B>
} = dual(
  2,
  <K extends string, A, K2 extends string, B>(
    self: ReadonlyRecord<K, A>,
    f: (a: A, key: K) => [K2, B]
  ): Record<K2, B> => {
    const out = {} as Record<K2, B>
    for (const key of keys(self)) {
      const [k, b] = f(self[key], key)
      out[k] = b
    }
    return out
  }
)

/**
 * Transforms a record by applying the function `f` to each key and value in the original record.
 * If the function succeeds, the key-value pair is included in the output record.
 *
 * @example
 * ```ts
 * import { Record, Result } from "effect"
 * import * as assert from "node:assert"
 *
 * const x = { a: 1, b: 2, c: 3 }
 * const f = (a: number, key: string) => a > 2 ? Result.succeed(a * 2) : Result.failVoid
 * assert.deepStrictEqual(Record.filterMap(x, f), { c: 6 })
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const filterMap: {
  <K extends string, A, B, X>(
    f: (input: A, key: K) => Result<B, X>
  ): (self: ReadonlyRecord<K, A>) => Record<ReadonlyRecord.NonLiteralKey<K>, B>
  <K extends string, A, B, X>(
    self: ReadonlyRecord<K, A>,
    f: (input: A, key: K) => Result<B, X>
  ): Record<ReadonlyRecord.NonLiteralKey<K>, B>
} = dual(
  2,
  <K extends string, A, B, X>(
    self: ReadonlyRecord<K, A>,
    f: (input: A, key: K) => Result<B, X>
  ): Record<ReadonlyRecord.NonLiteralKey<K>, B> => {
    const out: Record<string, B> = empty()
    for (const key of keys(self)) {
      const result = f(self[key], key)
      if (R.isSuccess(result)) {
        out[key] = result.success
      }
    }
    return out
  }
)

/**
 * Selects properties from a record whose values match the given predicate.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * const x = { a: 1, b: 2, c: 3, d: 4 }
 * assert.deepStrictEqual(Record.filter(x, (n) => n > 2), { c: 3, d: 4 })
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const filter: {
  <K extends string, A, B extends A>(
    refinement: (a: NoInfer<A>, key: K) => a is B
  ): (self: ReadonlyRecord<K, A>) => Record<ReadonlyRecord.NonLiteralKey<K>, B>
  <K extends string, A>(
    predicate: (A: NoInfer<A>, key: K) => boolean
  ): (self: ReadonlyRecord<K, A>) => Record<ReadonlyRecord.NonLiteralKey<K>, A>
  <K extends string, A, B extends A>(
    self: ReadonlyRecord<K, A>,
    refinement: (a: A, key: K) => a is B
  ): Record<ReadonlyRecord.NonLiteralKey<K>, B>
  <K extends string, A>(
    self: ReadonlyRecord<K, A>,
    predicate: (a: A, key: K) => boolean
  ): Record<ReadonlyRecord.NonLiteralKey<K>, A>
} = dual(
  2,
  <K extends string, A>(
    self: ReadonlyRecord<K, A>,
    predicate: (a: A, key: K) => boolean
  ): Record<ReadonlyRecord.NonLiteralKey<K>, A> => {
    const out: Record<string, A> = empty()
    for (const key of keys(self)) {
      if (predicate(self[key], key)) {
        out[key] = self[key]
      }
    }
    return out
  }
)

/**
 * Given a record with `Option` values, returns a new record containing only the `Some` values, preserving the original keys.
 *
 * @example
 * ```ts
 * import { Option, Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   Record.getSomes({ a: Option.some(1), b: Option.none(), c: Option.some(2) }),
 *   { a: 1, c: 2 }
 * )
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const getSomes: <K extends string, A>(
  self: ReadonlyRecord<K, Option.Option<A>>
) => Record<ReadonlyRecord.NonLiteralKey<K>, A> = <K extends string, A>(
  self: ReadonlyRecord<K, Option.Option<A>>
): Record<ReadonlyRecord.NonLiteralKey<K>, A> => {
  const out: Record<string, A> = empty()
  for (const key of keys(self)) {
    const option = self[key]
    if (Option.isSome(option)) {
      out[key] = option.value
    }
  }
  return out
}

/**
 * Given a record with `Result` values, returns a new record containing only the `Err` values, preserving the original keys.
 *
 * @example
 * ```ts
 * import { Record, Result } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   Record.getFailures({
 *     a: Result.succeed(1),
 *     b: Result.fail("err"),
 *     c: Result.succeed(2)
 *   }),
 *   { b: "err" }
 * )
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const getFailures = <K extends string, A, E>(
  self: ReadonlyRecord<K, Result<A, E>>
): Record<ReadonlyRecord.NonLiteralKey<K>, E> => {
  const out: Record<string, E> = empty()
  for (const key of keys(self)) {
    const value = self[key]
    if (R.isFailure(value)) {
      out[key] = value.failure
    }
  }

  return out
}

/**
 * Given a record with `Result` values, returns a new record containing only the `Ok` values, preserving the original keys.
 *
 * @example
 * ```ts
 * import { Record, Result } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   Record.getSuccesses({
 *     a: Result.succeed(1),
 *     b: Result.fail("err"),
 *     c: Result.succeed(2)
 *   }),
 *   { a: 1, c: 2 }
 * )
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const getSuccesses = <K extends string, A, E>(
  self: ReadonlyRecord<K, Result<A, E>>
): Record<string, A> => {
  const out: Record<string, A> = empty()
  for (const key of keys(self)) {
    const value = self[key]
    if (R.isSuccess(value)) {
      out[key] = value.success
    }
  }

  return out
}

/**
 * Partitions the elements of a record into two groups: those that match a filter, and those that don't.
 *
 * @example
 * ```ts
 * import { Record, Result } from "effect"
 * import * as assert from "node:assert"
 *
 * const x = { a: 1, b: 2, c: 3 }
 * const f = (n: number) => (n % 2 === 0 ? Result.succeed(n) : Result.fail(n))
 * assert.deepStrictEqual(Record.partition(x, f), [{ a: 1, c: 3 }, { b: 2 }])
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const partition: {
  <K extends string, A, B, C>(
    f: (input: A, key: K) => Result<C, B>
  ): (
    self: ReadonlyRecord<K, A>
  ) => [left: Record<ReadonlyRecord.NonLiteralKey<K>, B>, right: Record<ReadonlyRecord.NonLiteralKey<K>, C>]
  <K extends string, A, B, C>(
    self: ReadonlyRecord<K, A>,
    f: (input: A, key: K) => Result<C, B>
  ): [left: Record<ReadonlyRecord.NonLiteralKey<K>, B>, right: Record<ReadonlyRecord.NonLiteralKey<K>, C>]
} = dual(
  2,
  <K extends string, A, B, C>(
    self: ReadonlyRecord<K, A>,
    f: (input: A, key: K) => Result<C, B>
  ): [left: Record<ReadonlyRecord.NonLiteralKey<K>, B>, right: Record<ReadonlyRecord.NonLiteralKey<K>, C>] => {
    const left: Record<string, B> = empty()
    const right: Record<string, C> = empty()
    for (const key of keys(self)) {
      const e = f(self[key], key)
      if (R.isFailure(e)) {
        left[key] = e.failure
      } else {
        right[key] = e.success
      }
    }
    return [left, right]
  }
)

/**
 * Partitions a record of `Result` values into two separate records,
 * one with the `Err` values and one with the `Ok` values.
 *
 * @example
 * ```ts
 * import { Record, Result } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   Record.separate({ a: Result.fail("e"), b: Result.succeed(1) }),
 *   [{ a: "e" }, { b: 1 }]
 * )
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const separate: <K extends string, A, B>(
  self: ReadonlyRecord<K, Result<B, A>>
) => [Record<ReadonlyRecord.NonLiteralKey<K>, A>, Record<ReadonlyRecord.NonLiteralKey<K>, B>] = partition(identity)

/**
 * Retrieve the keys of a given record as an array.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Record.keys({ a: 1, b: 2, c: 3 }), ["a", "b", "c"])
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const keys = <K extends string | symbol, A>(self: ReadonlyRecord<K, A>): Array<K & string> =>
  Object.keys(self) as Array<K & string>

/**
 * Retrieve the values of a given record as an array.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Record.values({ a: 1, b: 2, c: 3 }), [1, 2, 3])
 * ```
 *
 * @category getters
 * @since 2.0.0
 */
export const values = <K extends string, A>(self: ReadonlyRecord<K, A>): Array<A> => collect(self, (_, a) => a)

/**
 * Add a new key-value pair or update an existing key's value in a record.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Record.set("a", 5)({ a: 1, b: 2 }), { a: 5, b: 2 })
 * assert.deepStrictEqual(Record.set("c", 5)({ a: 1, b: 2 }), { a: 1, b: 2, c: 5 })
 * ```
 *
 * @category utils
 * @since 2.0.0
 */
export const set: {
  <K extends string | symbol, K1 extends K | ((string | symbol) & {}), B>(
    key: K1,
    value: B
  ): <A>(self: ReadonlyRecord<K, A>) => Record<K | K1, A | B>
  <K extends string | symbol, A, K1 extends K | ((string | symbol) & {}), B>(
    self: ReadonlyRecord<K, A>,
    key: K1,
    value: B
  ): Record<K | K1, A | B>
} = dual(
  3,
  <K extends string | symbol, A, K1 extends K | ((string | symbol) & {}), B>(
    self: ReadonlyRecord<K, A>,
    key: K1,
    value: B
  ): Record<K | K1, A | B> => {
    return { ...self, [key]: value } as any
  }
)

/**
 * Check if all the keys and values in one record are also found in another record.
 * Uses the provided equivalence function to compare values.
 *
 * @example
 * ```ts
 * import { Equal, Record } from "effect"
 * import * as assert from "node:assert"
 *
 * const isSubrecord = Record.isSubrecordBy(Equal.asEquivalence<number>())
 *
 * assert.deepStrictEqual(
 *   Record.isSubrecord({ a: 1 } as Record<string, number>, { a: 1, b: 2 }),
 *   true
 * )
 * assert.deepStrictEqual(
 *   Record.isSubrecord({ a: 1, b: 2 }, { a: 1 } as Record<string, number>),
 *   false
 * )
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const isSubrecordBy = <A>(equivalence: Equivalence<A>): {
  <K extends string>(that: ReadonlyRecord<K, A>): (self: ReadonlyRecord<K, A>) => boolean
  <K extends string>(self: ReadonlyRecord<K, A>, that: ReadonlyRecord<K, A>): boolean
} =>
  dual(2, <K extends string>(self: ReadonlyRecord<K, A>, that: ReadonlyRecord<K, A>): boolean => {
    for (const key of keys(self)) {
      if (!has(that, key) || !equivalence(self[key], that[key])) {
        return false
      }
    }
    return true
  })

/**
 * Check if one record is a subrecord of another, meaning it contains all the keys and values found in the second record.
 * This comparison uses default equality checks (`Equal.equivalence()`).
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   Record.isSubrecord({ a: 1 } as Record<string, number>, { a: 1, b: 2 }),
 *   true
 * )
 * assert.deepStrictEqual(
 *   Record.isSubrecord({ a: 1, b: 2 }, { a: 1 } as Record<string, number>),
 *   false
 * )
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const isSubrecord: {
  <K extends string, A>(that: ReadonlyRecord<K, A>): (self: ReadonlyRecord<K, A>) => boolean
  <K extends string, A>(self: ReadonlyRecord<K, A>, that: ReadonlyRecord<K, A>): boolean
} = isSubrecordBy(Equal.asEquivalence())

/**
 * Reduce a record to a single value by combining its entries with a specified function.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   Record.reduce({ a: 1, b: 2, c: 3 }, 0, (acc, value, key) => acc + value),
 *   6
 * )
 * ```
 *
 * @category folding
 * @since 2.0.0
 */
export const reduce: {
  <Z, V, K extends string>(
    zero: Z,
    f: (accumulator: Z, value: V, key: K) => Z
  ): (self: ReadonlyRecord<K, V>) => Z
  <K extends string, V, Z>(self: ReadonlyRecord<K, V>, zero: Z, f: (accumulator: Z, value: V, key: K) => Z): Z
} = dual(
  3,
  <K extends string, V, Z>(
    self: ReadonlyRecord<K, V>,
    zero: Z,
    f: (accumulator: Z, value: V, key: K) => Z
  ): Z => {
    let out: Z = zero
    for (const key of keys(self)) {
      out = f(out, self[key], key)
    }
    return out
  }
)

/**
 * Check if all entries in a record meet a specific condition.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Record.every({ a: 1, b: 2 }, (n) => n > 0), true)
 * assert.deepStrictEqual(Record.every({ a: 1, b: -1 }, (n) => n > 0), false)
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const every: {
  <A, K extends string, B extends A>(
    refinement: (value: A, key: K) => value is B
  ): (self: ReadonlyRecord<K, A>) => self is ReadonlyRecord<K, B>
  <A, K extends string>(predicate: (value: A, key: K) => boolean): (self: ReadonlyRecord<K, A>) => boolean
  <A, K extends string, B extends A>(
    self: ReadonlyRecord<K, A>,
    refinement: (value: A, key: K) => value is B
  ): self is ReadonlyRecord<K, B>
  <K extends string, A>(self: ReadonlyRecord<K, A>, predicate: (value: A, key: K) => boolean): boolean
} = dual(
  2,
  <A, K extends string, B extends A>(
    self: ReadonlyRecord<K, A>,
    refinement: (value: A, key: K) => value is B
  ): self is ReadonlyRecord<K, B> => {
    for (const key of keys(self)) {
      if (!refinement(self[key], key)) {
        return false
      }
    }
    return true
  }
)

/**
 * Check if any entry in a record meets a specific condition.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Record.some({ a: 1, b: 2 }, (n) => n > 1), true)
 * assert.deepStrictEqual(Record.some({ a: 1, b: 2 }, (n) => n > 2), false)
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const some: {
  <A, K extends string>(predicate: (value: A, key: K) => boolean): (self: ReadonlyRecord<K, A>) => boolean
  <K extends string, A>(self: ReadonlyRecord<K, A>, predicate: (value: A, key: K) => boolean): boolean
} = dual(
  2,
  <K extends string, A>(self: ReadonlyRecord<K, A>, predicate: (value: A, key: K) => boolean): boolean => {
    for (const key of keys(self)) {
      if (predicate(self[key], key)) {
        return true
      }
    }
    return false
  }
)

/**
 * Merge two records, preserving entries that exist in either of the records.
 * For keys that exist in both records, the provided combine function is used to merge the values.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   Record.union({ a: 1, b: 2 }, { b: 3, c: 4 }, (a, b) => a + b),
 *   { a: 1, b: 5, c: 4 }
 * )
 * ```
 *
 * @category combining
 * @since 2.0.0
 */
export const union: {
  <K1 extends string, A, B, C>(
    that: ReadonlyRecord<K1, B>,
    combine: (selfValue: A, thatValue: B) => C
  ): <K0 extends string>(self: ReadonlyRecord<K0, A>) => Record<K0 | K1, A | B | C>
  <K0 extends string, A, K1 extends string, B, C>(
    self: ReadonlyRecord<K0, A>,
    that: ReadonlyRecord<K1, B>,
    combine: (selfValue: A, thatValue: B) => C
  ): Record<K0 | K1, A | B | C>
} = dual(
  3,
  <K0 extends string, A, K1 extends string, B, C>(
    self: ReadonlyRecord<K0, A>,
    that: ReadonlyRecord<K1, B>,
    combine: (selfValue: A, thatValue: B) => C
  ): Record<K0 | K1, A | B | C> => {
    if (isEmptyRecord(self)) {
      return { ...that } as any
    }
    if (isEmptyRecord(that)) {
      return { ...self } as any
    }
    const out: Record<string, A | B | C> = empty()
    for (const key of keys(self)) {
      if (has(that, key as any)) {
        out[key] = combine(self[key], that[key as unknown as K1])
      } else {
        out[key] = self[key]
      }
    }
    for (const key of keys(that)) {
      if (!has(out, key)) {
        out[key] = that[key]
      }
    }
    return out
  }
)

/**
 * Merge two records, retaining only the entries that exist in both records.
 * For intersecting keys, the provided combine function is used to merge the values.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   Record.intersection({ a: 1, b: 2 }, { b: 3, c: 4 }, (a, b) => a + b),
 *   { b: 5 }
 * )
 * ```
 *
 * @category combining
 * @since 2.0.0
 */
export const intersection: {
  <K1 extends string, A, B, C>(
    that: ReadonlyRecord<K1, B>,
    combine: (selfValue: A, thatValue: B) => C
  ): <K0 extends string>(self: ReadonlyRecord<K0, A>) => Record<ReadonlyRecord.IntersectKeys<K0, K1>, C>
  <K0 extends string, A, K1 extends string, B, C>(
    self: ReadonlyRecord<K0, A>,
    that: ReadonlyRecord<K1, B>,
    combine: (selfValue: A, thatValue: B) => C
  ): Record<ReadonlyRecord.IntersectKeys<K0, K1>, C>
} = dual(
  3,
  <K0 extends string, A, K1 extends string, B, C>(
    self: ReadonlyRecord<K0, A>,
    that: ReadonlyRecord<K1, B>,
    combine: (selfValue: A, thatValue: B) => C
  ): Record<ReadonlyRecord.IntersectKeys<K0, K1>, C> => {
    const out: Record<string, C> = empty()
    if (isEmptyRecord(self) || isEmptyRecord(that)) {
      return out
    }
    for (const key of keys(self)) {
      if (has(that, key as any)) {
        out[key] = combine(self[key], that[key as unknown as K1])
      }
    }
    return out
  }
)

/**
 * Merge two records, preserving only the entries that are unique to each record.
 * Keys that exist in both records are excluded from the result.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   Record.difference({ a: 1, b: 2 }, { b: 3, c: 4 }),
 *   { a: 1, c: 4 }
 * )
 * ```
 *
 * @category combining
 * @since 2.0.0
 */
export const difference: {
  <K1 extends string, B>(
    that: ReadonlyRecord<K1, B>
  ): <K0 extends string, A>(self: ReadonlyRecord<K0, A>) => Record<K0 | K1, A | B>
  <K0 extends string, A, K1 extends string, B>(
    self: ReadonlyRecord<K0, A>,
    that: ReadonlyRecord<K1, B>
  ): Record<K0 | K1, A | B>
} = dual(2, <K0 extends string, A, K1 extends string, B>(
  self: ReadonlyRecord<K0, A>,
  that: ReadonlyRecord<K1, B>
): Record<K0 | K1, A | B> => {
  if (isEmptyRecord(self)) {
    return { ...that } as any
  }
  if (isEmptyRecord(that)) {
    return { ...self } as any
  }
  const out = {} as Record<K0 | K1, A | B>
  for (const key of keys(self)) {
    if (!has(that, key as any)) {
      out[key] = self[key]
    }
  }
  for (const key of keys(that)) {
    if (!has(self, key as any)) {
      out[key] = that[key]
    }
  }
  return out
})

/**
 * Create an `Equivalence` for records using the provided `Equivalence` for values.
 * Two records are considered equivalent if they have the same keys and their corresponding values are equivalent.
 *
 * @example
 * ```ts
 * import { Equal, Record } from "effect"
 * import * as assert from "node:assert"
 *
 * const recordEquivalence = Record.makeEquivalence(Equal.asEquivalence<number>())
 *
 * assert.deepStrictEqual(recordEquivalence({ a: 1, b: 2 }, { a: 1, b: 2 }), true)
 * assert.deepStrictEqual(recordEquivalence({ a: 1, b: 2 }, { a: 1, b: 3 }), false)
 * ```
 *
 * @category instances
 * @since 2.0.0
 */
export const makeEquivalence = <K extends string, A>(
  equivalence: Equivalence<A>
): Equivalence<ReadonlyRecord<K, A>> => {
  const is = isSubrecordBy(equivalence)
  return (self, that) => is(self, that) && is(that, self)
}

/**
 * Create a non-empty record from a single element.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(Record.singleton("a", 1), { a: 1 })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const singleton = <K extends string | symbol, A>(key: K, value: A): Record<K, A> => ({
  [key]: value
} as any)

/**
 * A `Reducer` for combining `Record`s using union.
 *
 * Values for keys that exist in both records are combined using the provided `Combiner`.
 *
 * @since 4.0.0
 */
export function makeReducerUnion<K extends string, A>(combiner: Combiner.Combiner<A>): Reducer.Reducer<Record<K, A>> {
  return Reducer.make<Record<K, A>>(
    (self, that) => union(self, that, combiner.combine),
    {} as Record<K, A>
  )
}

/**
 * A `Reducer` for combining `Record`s using intersection.
 *
 * Values are combined using the provided `Combiner`.
 *
 * @since 4.0.0
 */
export function makeReducerIntersection<K extends string, A>(
  combiner: Combiner.Combiner<A>
): Reducer.Reducer<Record<K, A>> {
  return Reducer.make(
    (self, that) => intersection(self, that, combiner.combine) as any,
    {} as Record<K, A>
  )
}

/**
 * Returns the first entry that satisfies the specified
 * predicate, or `None` if no such entry exists.
 *
 * @example
 * ```ts
 * import { Record } from "effect"
 *
 * const record = { a: 1, b: 2, c: 3 }
 * const result = Record.findFirst(
 *   record,
 *   (value, key) => value > 1 && key !== "b"
 * )
 * console.log(result) // Option.Some(["c", 3])
 * ```
 *
 * @category elements
 * @since 3.14.0
 */
export const findFirst: {
  <K extends string | symbol, V, V2 extends V>(
    refinement: (value: NoInfer<V>, key: NoInfer<K>) => value is V2
  ): (self: ReadonlyRecord<K, V>) => Option.Option<[K, V2]>
  <K extends string | symbol, V>(
    predicate: (value: NoInfer<V>, key: NoInfer<K>) => boolean
  ): (self: ReadonlyRecord<K, V>) => Option.Option<[K, V]>
  <K extends string | symbol, V, V2 extends V>(
    self: ReadonlyRecord<K, V>,
    refinement: (value: NoInfer<V>, key: NoInfer<K>) => value is V2
  ): Option.Option<[K, V2]>
  <K extends string | symbol, V>(
    self: ReadonlyRecord<K, V>,
    predicate: (value: NoInfer<V>, key: NoInfer<K>) => boolean
  ): Option.Option<[K, V]>
} = dual(
  2,
  <K extends string | symbol, V>(
    self: ReadonlyRecord<K, V>,
    f: (value: V, key: K) => boolean
  ): Option.Option<[K, V]> => {
    const k = keys(self)
    for (let i = 0; i < k.length; i++) {
      const key = k[i]
      if (f(self[key], key)) {
        return Option.some([key, self[key]])
      }
    }
    return Option.none()
  }
)

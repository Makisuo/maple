/**
 * This module provides utility functions and type class instances for working with the `string` type in TypeScript.
 * It includes functions for basic string manipulation.
 *
 * @since 2.0.0
 */

import type { NonEmptyArray } from "./Array.ts"
import * as Equ from "./Equivalence.ts"
import { dual } from "./Function.ts"
import * as readonlyArray from "./internal/array.ts"
import * as number from "./Number.ts"
import * as Option from "./Option.ts"
import * as order from "./Order.ts"
import type * as Ordering from "./Ordering.ts"
import type { Refinement } from "./Predicate.ts"
import * as predicate from "./Predicate.ts"
import * as Reducer from "./Reducer.ts"

/**
 * Reference to the global `String` constructor.
 *
 * @category constructors
 * @since 4.0.0
 */
export const String = globalThis.String

/**
 * Tests if a value is a `string`.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(String.isString("a"), true)
 * assert.deepStrictEqual(String.isString(1), false)
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isString: Refinement<unknown, string> = predicate.isString

/**
 * `Order` instance for comparing strings using lexicographic ordering.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 *
 * console.log(String.Order("apple", "banana")) // -1
 * console.log(String.Order("banana", "apple")) // 1
 * console.log(String.Order("apple", "apple")) // 0
 * ```
 *
 * @category instances
 * @since 2.0.0
 */
export const Order: order.Order<string> = order.String

/**
 * An `Equivalence` instance for strings using strict equality (`===`).
 *
 * @example
 * ```ts
 * import { String } from "effect"
 *
 * console.log(String.Equivalence("hello", "hello")) // true
 * console.log(String.Equivalence("hello", "world")) // false
 * ```
 *
 * @category instances
 * @since 4.0.0
 */
export const Equivalence: Equ.Equivalence<string> = Equ.String

/**
 * The empty string `""`.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 *
 * console.log(String.empty) // ""
 * console.log(String.isEmpty(String.empty)) // true
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const empty: "" = "" as const

/**
 * Concatenates two strings at the type level.
 *
 * @example
 * ```ts
 * import type { String } from "effect"
 *
 * // Type-level concatenation
 * type Result = String.Concat<"hello", "world"> // "helloworld"
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export type Concat<A extends string, B extends string> = `${A}${B}`

/**
 * Concatenates two strings at runtime.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 *
 * const result1 = String.concat("hello", "world")
 * console.log(result1) // "helloworld"
 *
 * const result2 = pipe("hello", String.concat("world"))
 * console.log(result2) // "helloworld"
 * ```
 *
 * @category concatenating
 * @since 2.0.0
 */
export const concat: {
  <B extends string>(that: B): <A extends string>(self: A) => Concat<A, B>
  <A extends string, B extends string>(self: A, that: B): Concat<A, B>
} = dual(2, (self: string, that: string): string => self + that)

/**
 * Converts a string to uppercase.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("a", String.toUpperCase), "A")
 * assert.deepStrictEqual(String.toUpperCase("hello"), "HELLO")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const toUpperCase = <S extends string>(self: S): Uppercase<S> => self.toUpperCase() as Uppercase<S>

/**
 * Converts a string to lowercase.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("A", String.toLowerCase), "a")
 * assert.deepStrictEqual(String.toLowerCase("HELLO"), "hello")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const toLowerCase = <T extends string>(self: T): Lowercase<T> => self.toLowerCase() as Lowercase<T>

/**
 * Capitalizes the first character of a string.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("abc", String.capitalize), "Abc")
 * assert.deepStrictEqual(String.capitalize("hello"), "Hello")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const capitalize = <T extends string>(self: T): Capitalize<T> => {
  if (self.length === 0) return self as Capitalize<T>

  return (toUpperCase(self[0]) + self.slice(1)) as Capitalize<T>
}

/**
 * Uncapitalizes the first character of a string.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("ABC", String.uncapitalize), "aBC")
 * assert.deepStrictEqual(String.uncapitalize("Hello"), "hello")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const uncapitalize = <T extends string>(self: T): Uncapitalize<T> => {
  if (self.length === 0) return self as Uncapitalize<T>

  return (toLowerCase(self[0]) + self.slice(1)) as Uncapitalize<T>
}

/**
 * Replaces the first occurrence of a substring or pattern in a string.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("abc", String.replace("b", "d")), "adc")
 * assert.deepStrictEqual(
 *   pipe("hello world", String.replace("world", "Effect")),
 *   "hello Effect"
 * )
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const replace = (searchValue: string | RegExp, replaceValue: string) => (self: string): string =>
  self.replace(searchValue, replaceValue)

/**
 * Type-level representation of trimming whitespace from both ends of a string.
 *
 * @example
 * ```ts
 * import type { String } from "effect"
 *
 * type Result = String.Trim<"  hello  "> // "hello"
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export type Trim<A extends string> = TrimEnd<TrimStart<A>>

/**
 * Removes whitespace from both ends of a string.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(String.trim(" a "), "a")
 * assert.deepStrictEqual(String.trim("  hello world  "), "hello world")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const trim = <A extends string>(self: A): Trim<A> => self.trim() as Trim<A>

/**
 * Type-level representation of trimming whitespace from the start of a string.
 *
 * @example
 * ```ts
 * import type { String } from "effect"
 *
 * type Result = String.TrimStart<"  hello"> // "hello"
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export type TrimStart<A extends string> = A extends `${" " | "\n" | "\t" | "\r"}${infer B}` ? TrimStart<B> : A

/**
 * Removes whitespace from the start of a string.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(String.trimStart(" a "), "a ")
 * assert.deepStrictEqual(String.trimStart("  hello world"), "hello world")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const trimStart = <A extends string>(self: A): TrimStart<A> => self.trimStart() as TrimStart<A>

/**
 * Type-level representation of trimming whitespace from the end of a string.
 *
 * @example
 * ```ts
 * import type { String } from "effect"
 *
 * type Result = String.TrimEnd<"hello  "> // "hello"
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export type TrimEnd<A extends string> = A extends `${infer B}${" " | "\n" | "\t" | "\r"}` ? TrimEnd<B> : A

/**
 * Removes whitespace from the end of a string.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(String.trimEnd(" a "), " a")
 * assert.deepStrictEqual(String.trimEnd("hello world  "), "hello world")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const trimEnd = <A extends string>(self: A): TrimEnd<A> => self.trimEnd() as TrimEnd<A>

/**
 * Extracts a section of a string and returns it as a new string.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("abcd", String.slice(1, 3)), "bc")
 * assert.deepStrictEqual(pipe("hello world", String.slice(0, 5)), "hello")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const slice = (start?: number, end?: number) => (self: string): string => self.slice(start, end)

/**
 * Test whether a `string` is empty.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(String.isEmpty(""), true)
 * assert.deepStrictEqual(String.isEmpty("a"), false)
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const isEmpty = (self: string): self is "" => self.length === 0

/**
 * Test whether a `string` is non empty.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(String.isNonEmpty(""), false)
 * assert.deepStrictEqual(String.isNonEmpty("a"), true)
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isNonEmpty = (self: string): boolean => self.length > 0

/**
 * Calculate the number of characters in a `string`.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(String.length("abc"), 3)
 * ```
 *
 * @category utilities
 * @since 2.0.0
 */
export const length = (self: string): number => self.length

/**
 * Splits a string into an array of substrings using a separator.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("abc", String.split("")), ["a", "b", "c"])
 * assert.deepStrictEqual(pipe("", String.split("")), [""])
 * assert.deepStrictEqual(String.split("hello,world", ","), ["hello", "world"])
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const split: {
  (separator: string | RegExp): (self: string) => NonEmptyArray<string>
  (self: string, separator: string | RegExp): NonEmptyArray<string>
} = dual(2, (self: string, separator: string | RegExp): NonEmptyArray<string> => {
  const out = self.split(separator)
  return readonlyArray.isArrayNonEmpty(out) ? out : [self]
})

/**
 * Returns `true` if `searchString` appears as a substring of `self`, at one or more positions that are
 * greater than or equal to `position`; otherwise, returns `false`.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("hello world", String.includes("world")), true)
 * assert.deepStrictEqual(pipe("hello world", String.includes("foo")), false)
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const includes = (searchString: string, position?: number) => (self: string): boolean =>
  self.includes(searchString, position)

/**
 * Returns `true` if the string starts with the specified search string.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("hello world", String.startsWith("hello")), true)
 * assert.deepStrictEqual(pipe("hello world", String.startsWith("world")), false)
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const startsWith = (searchString: string, position?: number) => (self: string): boolean =>
  self.startsWith(searchString, position)

/**
 * Returns `true` if the string ends with the specified search string.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("hello world", String.endsWith("world")), true)
 * assert.deepStrictEqual(pipe("hello world", String.endsWith("hello")), false)
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const endsWith = (searchString: string, position?: number) => (self: string): boolean =>
  self.endsWith(searchString, position)

/**
 * Returns the character code at the specified index, or `None` if the index is out of bounds.
 *
 * **Example**
 *
 * ```ts
 * import { String } from "effect"
 *
 * String.charCodeAt("abc", 1) // Option.some(98)
 * String.charCodeAt("abc", 4) // Option.none()
 * ```
 *
 * @category elements
 * @since 2.0.0
 */
export const charCodeAt: {
  (index: number): (self: string) => Option.Option<number>
  (self: string, index: number): Option.Option<number>
} = dual(
  2,
  (self: string, index: number): Option.Option<number> =>
    Option.filter(Option.some(self.charCodeAt(index)), (charCode) => !isNaN(charCode))
)

/**
 * Extracts characters from a string between two specified indices.
 *
 * **Example**
 *
 * ```ts
 * import { pipe, String } from "effect"
 *
 * pipe("abcd", String.substring(1)) // "bcd"
 * pipe("abcd", String.substring(1, 3)) // "bc"
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const substring = (start: number, end?: number) => (self: string): string => self.substring(start, end)

/**
 * Returns the character at the specified index, or `None` if the index is out of bounds.
 *
 * **Example**
 *
 * ```ts
 * import { pipe, String } from "effect"
 *
 * pipe("abc", String.at(1)) // Option.some("b")
 * pipe("abc", String.at(4)) // Option.none()
 * ```
 *
 * @category elements
 * @since 2.0.0
 */
export const at: {
  (index: number): (self: string) => Option.Option<string>
  (self: string, index: number): Option.Option<string>
} = dual(2, (self: string, index: number): Option.Option<string> => Option.fromUndefinedOr(self.at(index)))

/**
 * Returns the character at the specified index, or `None` if the index is out of bounds.
 *
 * **Example**
 *
 * ```ts
 * import { pipe, String } from "effect"
 *
 * pipe("abc", String.charAt(1)) // Option.some("b")
 * pipe("abc", String.charAt(4)) // Option.none()
 * ```
 *
 * @category elements
 * @since 2.0.0
 */
export const charAt: {
  (index: number): (self: string) => Option.Option<string>
  (self: string, index: number): Option.Option<string>
} = dual(
  2,
  (self: string, index: number): Option.Option<string> => Option.filter(Option.some(self.charAt(index)), isNonEmpty)
)

/**
 * Returns the Unicode code point at the specified index, or `None` if the index is out of bounds.
 *
 * **Example**
 *
 * ```ts
 * import { pipe, String } from "effect"
 *
 * pipe("abc", String.codePointAt(1)) // Option.some(98)
 * pipe("abc", String.codePointAt(10)) // Option.none()
 * ```
 *
 * @category elements
 * @since 2.0.0
 */
export const codePointAt: {
  (index: number): (self: string) => Option.Option<number>
  (self: string, index: number): Option.Option<number>
} = dual(2, (self: string, index: number): Option.Option<number> => Option.fromUndefinedOr(self.codePointAt(index)))

/**
 * Returns the index of the first occurrence of a substring, or `None` if not found.
 *
 * **Example**
 *
 * ```ts
 * import { pipe, String } from "effect"
 *
 * pipe("abbbc", String.indexOf("b")) // Option.some(1)
 * pipe("abbbc", String.indexOf("z")) // Option.none()
 * ```
 *
 * @category searching
 * @since 2.0.0
 */
export const indexOf = (searchString: string) => (self: string): Option.Option<number> =>
  Option.filter(Option.some(self.indexOf(searchString)), number.isGreaterThanOrEqualTo(0))

/**
 * Returns the index of the last occurrence of a substring, or `None` if not found.
 *
 * **Example**
 *
 * ```ts
 * import { pipe, String } from "effect"
 *
 * pipe("abbbc", String.lastIndexOf("b")) // Option.some(3)
 * pipe("abbbc", String.lastIndexOf("d")) // Option.none()
 * ```
 *
 * @category searching
 * @since 2.0.0
 */
export const lastIndexOf = (searchString: string) => (self: string): Option.Option<number> =>
  Option.filter(Option.some(self.lastIndexOf(searchString)), number.isGreaterThanOrEqualTo(0))

/**
 * Compares two strings according to the current locale.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("a", String.localeCompare("b")), -1)
 * assert.deepStrictEqual(pipe("b", String.localeCompare("a")), 1)
 * assert.deepStrictEqual(pipe("a", String.localeCompare("a")), 0)
 * ```
 *
 * @category comparing
 * @since 2.0.0
 */
export const localeCompare =
  (that: string, locales?: Array<string>, options?: Intl.CollatorOptions) => (self: string): Ordering.Ordering =>
    number.sign(self.localeCompare(that, locales, options))

/**
 * A `pipe`-able version of the native `match` method.
 *
 * **Example**
 *
 * ```ts
 * import { pipe, String } from "effect"
 *
 * pipe("hello", String.match(/l+/)) // Option.some(["ll"])
 * pipe("hello", String.match(/x/)) // Option.none()
 * ```
 *
 * @category searching
 * @since 2.0.0
 */
export const match = (regExp: RegExp | string) => (self: string): Option.Option<RegExpMatchArray> =>
  Option.fromNullOr(self.match(regExp))

/**
 * It is the `pipe`-able version of the native `matchAll` method.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 *
 * const matches = pipe("hello world", String.matchAll(/l/g))
 * console.log(Array.from(matches)) // [["l"], ["l"], ["l"]]
 * ```
 *
 * @category searching
 * @since 2.0.0
 */
export const matchAll = (regExp: RegExp) => (self: string): IterableIterator<RegExpMatchArray> => self.matchAll(regExp)

/**
 * Normalizes a string according to the specified Unicode normalization form.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * const str = "\u1E9B\u0323"
 * assert.deepStrictEqual(pipe(str, String.normalize()), "\u1E9B\u0323")
 * assert.deepStrictEqual(pipe(str, String.normalize("NFC")), "\u1E9B\u0323")
 * assert.deepStrictEqual(pipe(str, String.normalize("NFD")), "\u017F\u0323\u0307")
 * assert.deepStrictEqual(pipe(str, String.normalize("NFKC")), "\u1E69")
 * assert.deepStrictEqual(
 *   pipe(str, String.normalize("NFKD")),
 *   "\u0073\u0323\u0307"
 * )
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const normalize = (form?: "NFC" | "NFD" | "NFKC" | "NFKD") => (self: string): string => self.normalize(form)

/**
 * Pads the string from the end with a given fill string to a specified length.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("a", String.padEnd(5)), "a    ")
 * assert.deepStrictEqual(pipe("a", String.padEnd(5, "_")), "a____")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const padEnd = (maxLength: number, fillString?: string) => (self: string): string =>
  self.padEnd(maxLength, fillString)

/**
 * Pads the string from the start with a given fill string to a specified length.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("a", String.padStart(5)), "    a")
 * assert.deepStrictEqual(pipe("a", String.padStart(5, "_")), "____a")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const padStart = (maxLength: number, fillString?: string) => (self: string): string =>
  self.padStart(maxLength, fillString)

/**
 * Repeats the string the specified number of times.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("a", String.repeat(5)), "aaaaa")
 * assert.deepStrictEqual(pipe("hello", String.repeat(3)), "hellohellohello")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const repeat = (count: number) => (self: string): string => self.repeat(count)

/**
 * Replaces all occurrences of a substring or pattern in a string.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(pipe("ababb", String.replaceAll("b", "c")), "acacc")
 * assert.deepStrictEqual(pipe("ababb", String.replaceAll(/ba/g, "cc")), "accbb")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const replaceAll = (searchValue: string | RegExp, replaceValue: string) => (self: string): string =>
  self.replaceAll(searchValue, replaceValue)

/**
 * Searches for a match between a regular expression and the string.
 *
 * **Example**
 *
 * ```ts
 * import { String } from "effect"
 *
 * String.search("ababb", "b") // Option.some(1)
 * String.search("ababb", /abb/) // Option.some(2)
 * String.search("ababb", "d") // Option.none()
 * ```
 *
 * @category searching
 * @since 2.0.0
 */
export const search: {
  (regExp: RegExp | string): (self: string) => Option.Option<number>
  (self: string, regExp: RegExp | string): Option.Option<number>
} = dual(
  2,
  (self: string, regExp: RegExp | string): Option.Option<number> =>
    Option.filter(Option.some(self.search(regExp)), number.isGreaterThanOrEqualTo(0))
)

/**
 * Converts the string to lowercase according to the specified locale.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * const str = "\u0130"
 * assert.deepStrictEqual(pipe(str, String.toLocaleLowerCase("tr")), "i")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const toLocaleLowerCase = (locale?: string | Array<string>) => (self: string): string =>
  self.toLocaleLowerCase(locale)

/**
 * Converts the string to uppercase according to the specified locale.
 *
 * @example
 * ```ts
 * import { pipe, String } from "effect"
 * import * as assert from "node:assert"
 *
 * const str = "i\u0307"
 * assert.deepStrictEqual(pipe(str, String.toLocaleUpperCase("lt-LT")), "I")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const toLocaleUpperCase = (locale?: string | Array<string>) => (self: string): string =>
  self.toLocaleUpperCase(locale)

/**
 * Keep the specified number of characters from the start of a string.
 *
 * If `n` is larger than the available number of characters, the string will
 * be returned whole.
 *
 * If `n` is not a positive number, an empty string will be returned.
 *
 * If `n` is a float, it will be rounded down to the nearest integer.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(String.takeLeft("Hello World", 5), "Hello")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const takeLeft: {
  (n: number): (self: string) => string
  (self: string, n: number): string
} = dual(2, (self: string, n: number): string => self.slice(0, Math.max(n, 0)))

/**
 * Keep the specified number of characters from the end of a string.
 *
 * If `n` is larger than the available number of characters, the string will
 * be returned whole.
 *
 * If `n` is not a positive number, an empty string will be returned.
 *
 * If `n` is a float, it will be rounded down to the nearest integer.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(String.takeRight("Hello World", 5), "World")
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const takeRight: {
  (n: number): (self: string) => string
  (self: string, n: number): string
} = dual(
  2,
  (self: string, n: number): string => self.slice(Math.max(0, self.length - Math.floor(n)), Infinity)
)

const CR = 0x0d
const LF = 0x0a

/**
 * Returns an `IterableIterator` which yields each line contained within the
 * string, trimming off the trailing newline character.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 *
 * const lines = String.linesIterator("hello\nworld\n")
 * console.log(Array.from(lines)) // ["hello", "world"]
 * ```
 *
 * @category splitting
 * @since 2.0.0
 */
export const linesIterator = (self: string): LinesIterator => linesSeparated(self, true)

/**
 * Returns an `IterableIterator` which yields each line contained within the
 * string as well as the trailing newline character.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 *
 * const lines = String.linesWithSeparators("hello\nworld\n")
 * console.log(Array.from(lines)) // ["hello\n", "world\n"]
 * ```
 *
 * @category splitting
 * @since 2.0.0
 */
export const linesWithSeparators = (s: string): LinesIterator => linesSeparated(s, false)

/**
 * For every line in this string, strip a leading prefix consisting of blanks
 * or control characters followed by the character specified by `marginChar`
 * from the line.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 *
 * const text = "  |hello\n  |world"
 * const result = String.stripMarginWith(text, "|")
 * console.log(result) // "hello\nworld"
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const stripMarginWith: {
  (marginChar: string): (self: string) => string
  (self: string, marginChar: string): string
} = dual(2, (self: string, marginChar: string): string => {
  let out = ""

  for (const line of linesWithSeparators(self)) {
    let index = 0

    while (index < line.length && line.charAt(index) <= " ") {
      index = index + 1
    }

    const stripped = index < line.length && line.charAt(index) === marginChar
      ? line.substring(index + 1)
      : line

    out = out + stripped
  }

  return out
})

/**
 * For every line in this string, strip a leading prefix consisting of blanks
 * or control characters followed by the `"|"` character from the line.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 *
 * const text = "  |hello\n  |world"
 * const result = String.stripMargin(text)
 * console.log(result) // "hello\nworld"
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const stripMargin = (self: string): string => stripMarginWith(self, "|")

/**
 * Converts a snake_case string to camelCase.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 *
 * console.log(String.snakeToCamel("hello_world")) // "helloWorld"
 * console.log(String.snakeToCamel("foo_bar_baz")) // "fooBarBaz"
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const snakeToCamel = (self: string): string => {
  let str = self[0]
  for (let i = 1; i < self.length; i++) {
    str += self[i] === "_" ? self[++i].toUpperCase() : self[i]
  }
  return str
}

/**
 * Converts a snake_case string to PascalCase.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 *
 * console.log(String.snakeToPascal("hello_world")) // "HelloWorld"
 * console.log(String.snakeToPascal("foo_bar_baz")) // "FooBarBaz"
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const snakeToPascal = (self: string): string => {
  let str = self[0].toUpperCase()
  for (let i = 1; i < self.length; i++) {
    str += self[i] === "_" ? self[++i].toUpperCase() : self[i]
  }
  return str
}

/**
 * Converts a snake_case string to kebab-case.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 *
 * console.log(String.snakeToKebab("hello_world")) // "hello-world"
 * console.log(String.snakeToKebab("foo_bar_baz")) // "foo-bar-baz"
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const snakeToKebab = (self: string): string => self.replace(/_/g, "-")

/**
 * Converts a camelCase string to snake_case.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 *
 * console.log(String.camelToSnake("helloWorld")) // "hello_world"
 * console.log(String.camelToSnake("fooBarBaz")) // "foo_bar_baz"
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const camelToSnake = (self: string): string => self.replace(/([A-Z])/g, "_$1").toLowerCase()

/**
 * Converts a PascalCase string to snake_case.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 *
 * console.log(String.pascalToSnake("HelloWorld")) // "hello_world"
 * console.log(String.pascalToSnake("FooBarBaz")) // "foo_bar_baz"
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const pascalToSnake = (self: string): string =>
  (self.slice(0, 1) + self.slice(1).replace(/([A-Z])/g, "_$1")).toLowerCase()

/**
 * Converts a kebab-case string to snake_case.
 *
 * @example
 * ```ts
 * import { String } from "effect"
 *
 * console.log(String.kebabToSnake("hello-world")) // "hello_world"
 * console.log(String.kebabToSnake("foo-bar-baz")) // "foo_bar_baz"
 * ```
 *
 * @category transforming
 * @since 2.0.0
 */
export const kebabToSnake = (self: string): string => self.replace(/-/g, "_")

class LinesIterator implements IterableIterator<string> {
  private index: number
  private readonly length: number
  readonly s: string
  readonly stripped: boolean

  constructor(
    s: string,
    stripped: boolean = false
  ) {
    this.s = s
    this.stripped = stripped
    this.index = 0
    this.length = s.length
  }

  next(): IteratorResult<string> {
    if (this.done) {
      return { done: true, value: undefined }
    }
    const start = this.index
    while (!this.done && !isLineBreak(this.s[this.index]!)) {
      this.index = this.index + 1
    }
    let end = this.index
    if (!this.done) {
      const char = this.s[this.index]!
      this.index = this.index + 1
      if (!this.done && isLineBreak2(char, this.s[this.index]!)) {
        this.index = this.index + 1
      }
      if (!this.stripped) {
        end = this.index
      }
    }
    return { done: false, value: this.s.substring(start, end) }
  }

  [Symbol.iterator](): IterableIterator<string> {
    return new LinesIterator(this.s, this.stripped)
  }

  private get done(): boolean {
    return this.index >= this.length
  }
}

/**
 * Test if the provided character is a line break character (i.e. either `"\r"`
 * or `"\n"`).
 */
const isLineBreak = (char: string): boolean => {
  const code = char.charCodeAt(0)
  return code === CR || code === LF
}

/**
 * Test if the provided characters combine to form a carriage return/line-feed
 * (i.e. `"\r\n"`).
 */
const isLineBreak2 = (char0: string, char1: string): boolean => char0.charCodeAt(0) === CR && char1.charCodeAt(0) === LF

const linesSeparated = (self: string, stripped: boolean): LinesIterator => new LinesIterator(self, stripped)

/**
 * Normalize a string to a specific case format
 *
 * @category transforming
 * @since 4.0.0
 */
export const noCase: {
  (options?: {
    readonly splitRegExp?: RegExp | ReadonlyArray<RegExp> | undefined
    readonly stripRegExp?: RegExp | ReadonlyArray<RegExp> | undefined
    readonly delimiter?: string | undefined
    readonly transform?: (part: string, index: number, parts: ReadonlyArray<string>) => string
  }): (self: string) => string
  (self: string, options?: {
    readonly splitRegExp?: RegExp | ReadonlyArray<RegExp> | undefined
    readonly stripRegExp?: RegExp | ReadonlyArray<RegExp> | undefined
    readonly delimiter?: string | undefined
    readonly transform?: (part: string, index: number, parts: ReadonlyArray<string>) => string
  }): string
} = dual((args) => typeof args[0] === "string", (input: string, options?: {
  readonly splitRegExp?: RegExp | ReadonlyArray<RegExp> | undefined
  readonly stripRegExp?: RegExp | ReadonlyArray<RegExp> | undefined
  readonly delimiter?: string | undefined
  readonly transform?: (part: string, index: number, parts: ReadonlyArray<string>) => string
}): string => {
  const delimiter = options?.delimiter ?? " "
  const transform = options?.transform ?? toLowerCase
  const result = input
    .replace(SPLIT_REGEXP[0], "$1\0$2")
    .replace(SPLIT_REGEXP[1], "$1\0$2")
    .replace(STRIP_REGEXP, "\0")
  let start = 0
  let end = result.length
  // Trim the delimiter from around the output string.
  while (result.charAt(start) === "\0") {
    start++
  }
  while (result.charAt(end - 1) === "\0") {
    end--
  }

  // Transform each token independently.
  return result.slice(start, end).split("\0").map(transform).join(delimiter)
})

// Support camel case ("camelCase" -> "camel Case" and "CAMELCase" -> "CAMEL Case").
const SPLIT_REGEXP = [/([a-z0-9])([A-Z])/g, /([A-Z])([A-Z][a-z])/g]

// Remove all non-word characters.
const STRIP_REGEXP = /[^A-Z0-9]+/gi

const pascalCaseTransform = (input: string, index: number): string => {
  const firstChar = input.charAt(0)
  const lowerChars = input.substring(1).toLowerCase()
  if (index > 0 && firstChar >= "0" && firstChar <= "9") {
    return `_${firstChar}${lowerChars}`
  }
  return `${firstChar.toUpperCase()}${lowerChars}`
}

/**
 * Converts a string to PascalCase.
 *
 * @since 4.0.0
 * @category transforming
 */
export const pascalCase: (self: string) => string = noCase({
  delimiter: "",
  transform: pascalCaseTransform
})

const camelCaseTransform = (input: string, index: number): string =>
  index === 0
    ? input.toLowerCase()
    : pascalCaseTransform(input, index)

/**
 * Converts a string to camelCase.
 *
 * @since 4.0.0
 * @category transforming
 */
export const camelCase: (self: string) => string = noCase({
  delimiter: "",
  transform: camelCaseTransform
})

/**
 * Converts a string to CONSTANT_CASE (uppercase with underscores).
 *
 * @since 4.0.0
 * @category transforming
 */
export const constantCase: (self: string) => string = noCase({
  delimiter: "_",
  transform: toUpperCase
})

/**
 * Converts a string to kebab-case (lowercase with hyphens).
 *
 * @since 4.0.0
 * @category transforming
 */
export const kebabCase: (self: string) => string = noCase({
  delimiter: "-"
})

/**
 * Converts a string to snake_case (lowercase with underscores).
 *
 * @since 4.0.0
 * @category transforming
 */
export const snakeCase: (self: string) => string = noCase({
  delimiter: "_"
})

/**
 * A `Reducer` for concatenating `string`s.
 *
 * @since 4.0.0
 */
export const ReducerConcat: Reducer.Reducer<string> = Reducer.make((a, b) => a + b, "")

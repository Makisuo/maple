/**
 * This module provides utility functions for working with RegExp in TypeScript.
 *
 * @since 2.0.0
 */
import * as predicate from "./Predicate.ts"

/**
 * @since 4.0.0
 * @category constructors
 * @example
 * ```ts
 * import { RegExp } from "effect"
 *
 * // Create a regular expression using Effect's RegExp constructor
 * const pattern = new RegExp.RegExp("hello", "i")
 *
 * // Test the pattern
 * console.log(pattern.test("Hello World")) // true
 * console.log(pattern.test("goodbye")) // false
 * ```
 */
export const RegExp = globalThis.RegExp

/**
 * Tests if a value is a `RegExp`.
 *
 * @example
 * ```ts
 * import { RegExp } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(RegExp.isRegExp(/a/), true)
 * assert.deepStrictEqual(RegExp.isRegExp("a"), false)
 * ```
 *
 * @category guards
 * @since 3.9.0
 */
export const isRegExp: (input: unknown) => input is RegExp = predicate.isRegExp

/**
 * Escapes special characters in a regular expression pattern.
 *
 * @example
 * ```ts
 * import { RegExp } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(RegExp.escape("a*b"), "a\\*b")
 * ```
 *
 * @category utilities
 * @since 2.0.0
 */
export const escape = (string: string): string => string.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")

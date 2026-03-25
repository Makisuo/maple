/**
 * @fileoverview
 * The Ordering module provides utilities for working with comparison results and ordering operations.
 * An Ordering represents the result of comparing two values, expressing whether the first value is
 * less than (-1), equal to (0), or greater than (1) the second value.
 *
 * This module is fundamental for building comparison functions, sorting algorithms, and implementing
 * ordered data structures. It provides composable operations for combining multiple comparison results
 * and pattern matching on ordering outcomes.
 *
 * Key Features:
 * - Type-safe representation of comparison results (-1, 0, 1)
 * - Composable operations for combining multiple orderings
 * - Pattern matching utilities for handling different ordering cases
 * - Ordering reversal and combination functions
 * - Integration with Effect's functional programming patterns
 *
 * Common Use Cases:
 * - Implementing custom comparison functions
 * - Building complex sorting criteria
 * - Combining multiple comparison results
 * - Creating ordered data structures
 * - Pattern matching on comparison outcomes
 *
 * @since 2.0.0
 * @category utilities
 */
import type { LazyArg } from "./Function.ts"
import { dual } from "./Function.ts"
import * as Reducer_ from "./Reducer.ts"

/**
 * Represents the result of comparing two values.
 *
 * - `-1` indicates the first value is less than the second
 * - `0` indicates the values are equal
 * - `1` indicates the first value is greater than the second
 *
 * @example
 * ```ts
 * import type { Ordering } from "effect"
 *
 * // Custom comparison function
 * const compareNumbers = (a: number, b: number): Ordering.Ordering => {
 *   if (a < b) return -1
 *   if (a > b) return 1
 *   return 0
 * }
 *
 * console.log(compareNumbers(5, 10)) // -1 (5 < 10)
 * console.log(compareNumbers(10, 5)) // 1 (10 > 5)
 * console.log(compareNumbers(5, 5)) // 0 (5 == 5)
 *
 * // Using with string comparison
 * const compareStrings = (a: string, b: string): Ordering.Ordering => {
 *   return a.localeCompare(b) as Ordering.Ordering
 * }
 * ```
 *
 * @category model
 * @since 2.0.0
 */
export type Ordering = -1 | 0 | 1

/**
 * Inverts the ordering of the input Ordering.
 * This is useful for creating descending sort orders from ascending ones.
 *
 * @example
 * ```ts
 * import { Ordering } from "effect"
 *
 * // Basic reversal
 * console.log(Ordering.reverse(1)) // -1 (greater becomes less)
 * console.log(Ordering.reverse(-1)) // 1 (less becomes greater)
 * console.log(Ordering.reverse(0)) // 0 (equal stays equal)
 *
 * // Creating descending sort from ascending comparison
 * const compareNumbers = (a: number, b: number): Ordering.Ordering =>
 *   a < b ? -1 : a > b ? 1 : 0
 *
 * const compareDescending = (a: number, b: number): Ordering.Ordering =>
 *   Ordering.reverse(compareNumbers(a, b))
 *
 * const numbers = [3, 1, 4, 1, 5]
 * numbers.sort(compareNumbers) // [1, 1, 3, 4, 5] (ascending)
 * numbers.sort(compareDescending) // [5, 4, 3, 1, 1] (descending)
 *
 * // Useful for toggling sort direction
 * const createSorter = (ascending: boolean) => (a: number, b: number) => {
 *   const ordering = compareNumbers(a, b)
 *   return ascending ? ordering : Ordering.reverse(ordering)
 * }
 * ```
 *
 * @category transformations
 * @since 2.0.0
 */
export const reverse = (o: Ordering): Ordering => (o === -1 ? 1 : o === 1 ? -1 : 0)

/**
 * Depending on the `Ordering` parameter given to it, returns a value produced by one of the 3 functions provided as parameters.
 *
 * @example
 * ```ts
 * import { Ordering } from "effect"
 * import { constant } from "effect/Function"
 * import * as assert from "node:assert"
 *
 * const toMessage = Ordering.match({
 *   onLessThan: constant("less than"),
 *   onEqual: constant("equal"),
 *   onGreaterThan: constant("greater than")
 * })
 *
 * assert.deepStrictEqual(toMessage(-1), "less than")
 * assert.deepStrictEqual(toMessage(0), "equal")
 * assert.deepStrictEqual(toMessage(1), "greater than")
 * ```
 *
 * @category pattern matching
 * @since 2.0.0
 */
export const match: {
  <A, B, C = B>(
    options: {
      readonly onLessThan: LazyArg<A>
      readonly onEqual: LazyArg<B>
      readonly onGreaterThan: LazyArg<C>
    }
  ): (self: Ordering) => A | B | C
  <A, B, C = B>(
    o: Ordering,
    options: {
      readonly onLessThan: LazyArg<A>
      readonly onEqual: LazyArg<B>
      readonly onGreaterThan: LazyArg<C>
    }
  ): A | B | C
} = dual(2, <A, B, C = B>(
  self: Ordering,
  { onEqual, onGreaterThan, onLessThan }: {
    readonly onLessThan: LazyArg<A>
    readonly onEqual: LazyArg<B>
    readonly onGreaterThan: LazyArg<C>
  }
): A | B | C => self === -1 ? onLessThan() : self === 0 ? onEqual() : onGreaterThan())

/**
 * A `Reducer` for combining `Ordering`s.
 *
 * If any of the `Ordering`s is non-zero, the result is the first non-zero `Ordering`.
 * If all the `Ordering`s are zero, the result is zero.
 *
 * @since 4.0.0
 */
export const Reducer: Reducer_.Reducer<Ordering> = Reducer_.make<Ordering>(
  (self, that) => self !== 0 ? self : that,
  0,
  (collection) => {
    let ordering: Ordering = 0
    for (ordering of collection) {
      if (ordering !== 0) {
        return ordering
      }
    }
    return ordering
  }
)

/**
 * This module provides utility functions and type class instances for working with the `boolean` type in TypeScript.
 * It includes functions for basic boolean operations.
 *
 * @since 2.0.0
 */
import * as Equ from "./Equivalence.ts"
import type { LazyArg } from "./Function.ts"
import { dual } from "./Function.ts"
import * as order from "./Order.ts"
import * as predicate from "./Predicate.ts"
import * as Reducer from "./Reducer.ts"

/**
 * Reference to the global Boolean constructor.
 *
 * @example
 * ```ts
 * import * as Boolean from "effect/Boolean"
 *
 * const bool = Boolean.Boolean(1)
 * console.log(bool) // true
 *
 * const fromString = Boolean.Boolean("false")
 * console.log(fromString) // true (non-empty string)
 *
 * const fromZero = Boolean.Boolean(0)
 * console.log(fromZero) // false
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const Boolean = globalThis.Boolean

/**
 * Tests if a value is a `boolean`.
 *
 * @example
 * ```ts
 * import { isBoolean } from "effect/Boolean"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(isBoolean(true), true)
 * assert.deepStrictEqual(isBoolean("true"), false)
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isBoolean: (input: unknown) => input is boolean = predicate.isBoolean

/**
 * This function returns the result of either of the given functions depending on the value of the boolean parameter.
 * It is useful when you have to run one of two functions depending on the boolean value.
 *
 * @example
 * ```ts
 * import * as Boolean from "effect/Boolean"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   Boolean.match(true, {
 *     onFalse: () => "It's false!",
 *     onTrue: () => "It's true!"
 *   }),
 *   "It's true!"
 * )
 * ```
 *
 * @category pattern matching
 * @since 2.0.0
 */
export const match: {
  <A, B = A>(options: {
    readonly onFalse: LazyArg<A>
    readonly onTrue: LazyArg<B>
  }): (value: boolean) => A | B
  <A, B>(value: boolean, options: {
    readonly onFalse: LazyArg<A>
    readonly onTrue: LazyArg<B>
  }): A | B
} = dual(2, <A, B>(value: boolean, options: {
  readonly onFalse: LazyArg<A>
  readonly onTrue: LazyArg<B>
}): A | B => value ? options.onTrue() : options.onFalse())

/**
 * Provides an `Order` instance for `boolean` that allows comparing and sorting boolean values.
 * In this ordering, `false` is considered less than `true`.
 *
 * @example
 * ```ts
 * import * as Boolean from "effect/Boolean"
 *
 * console.log(Boolean.Order(false, true)) // -1 (false < true)
 * console.log(Boolean.Order(true, false)) // 1 (true > false)
 * console.log(Boolean.Order(true, true)) // 0 (true === true)
 * ```
 *
 * @category instances
 * @since 2.0.0
 */
export const Order: order.Order<boolean> = order.Boolean

/**
 * An `Equivalence` instance for booleans using strict equality (`===`).
 *
 * @example
 * ```ts
 * import { Boolean } from "effect"
 *
 * console.log(Boolean.Equivalence(true, true)) // true
 * console.log(Boolean.Equivalence(true, false)) // false
 * ```
 *
 * @category instances
 * @since 4.0.0
 */
export const Equivalence: Equ.Equivalence<boolean> = Equ.Boolean

/**
 * Negates the given boolean: `!self`
 *
 * @example
 * ```ts
 * import { not } from "effect/Boolean"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(not(true), false)
 * assert.deepStrictEqual(not(false), true)
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const not = (self: boolean): boolean => !self

/**
 * Combines two boolean using AND: `self && that`.
 *
 * @example
 * ```ts
 * import { and } from "effect/Boolean"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(and(true, true), true)
 * assert.deepStrictEqual(and(true, false), false)
 * assert.deepStrictEqual(and(false, true), false)
 * assert.deepStrictEqual(and(false, false), false)
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const and: {
  (that: boolean): (self: boolean) => boolean
  (self: boolean, that: boolean): boolean
} = dual(2, (self: boolean, that: boolean): boolean => self && that)

/**
 * Combines two boolean using NAND: `!(self && that)`.
 *
 * @example
 * ```ts
 * import { nand } from "effect/Boolean"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(nand(true, true), false)
 * assert.deepStrictEqual(nand(true, false), true)
 * assert.deepStrictEqual(nand(false, true), true)
 * assert.deepStrictEqual(nand(false, false), true)
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const nand: {
  (that: boolean): (self: boolean) => boolean
  (self: boolean, that: boolean): boolean
} = dual(2, (self: boolean, that: boolean): boolean => !(self && that))

/**
 * Combines two boolean using OR: `self || that`.
 *
 * @example
 * ```ts
 * import { or } from "effect/Boolean"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(or(true, true), true)
 * assert.deepStrictEqual(or(true, false), true)
 * assert.deepStrictEqual(or(false, true), true)
 * assert.deepStrictEqual(or(false, false), false)
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const or: {
  (that: boolean): (self: boolean) => boolean
  (self: boolean, that: boolean): boolean
} = dual(2, (self: boolean, that: boolean): boolean => self || that)

/**
 * Combines two booleans using NOR: `!(self || that)`.
 *
 * @example
 * ```ts
 * import { nor } from "effect/Boolean"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(nor(true, true), false)
 * assert.deepStrictEqual(nor(true, false), false)
 * assert.deepStrictEqual(nor(false, true), false)
 * assert.deepStrictEqual(nor(false, false), true)
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const nor: {
  (that: boolean): (self: boolean) => boolean
  (self: boolean, that: boolean): boolean
} = dual(2, (self: boolean, that: boolean): boolean => !(self || that))

/**
 * Combines two booleans using XOR: `(!self && that) || (self && !that)`.
 *
 * @example
 * ```ts
 * import { xor } from "effect/Boolean"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(xor(true, true), false)
 * assert.deepStrictEqual(xor(true, false), true)
 * assert.deepStrictEqual(xor(false, true), true)
 * assert.deepStrictEqual(xor(false, false), false)
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const xor: {
  (that: boolean): (self: boolean) => boolean
  (self: boolean, that: boolean): boolean
} = dual(2, (self: boolean, that: boolean): boolean => (!self && that) || (self && !that))

/**
 * Combines two booleans using EQV (aka XNOR): `!xor(self, that)`.
 *
 * @example
 * ```ts
 * import { eqv } from "effect/Boolean"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(eqv(true, true), true)
 * assert.deepStrictEqual(eqv(true, false), false)
 * assert.deepStrictEqual(eqv(false, true), false)
 * assert.deepStrictEqual(eqv(false, false), true)
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const eqv: {
  (that: boolean): (self: boolean) => boolean
  (self: boolean, that: boolean): boolean
} = dual(2, (self: boolean, that: boolean): boolean => !xor(self, that))

/**
 * Combines two booleans using an implication: `(!self || that)`.
 *
 * @example
 * ```ts
 * import { implies } from "effect/Boolean"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(implies(true, true), true)
 * assert.deepStrictEqual(implies(true, false), false)
 * assert.deepStrictEqual(implies(false, true), true)
 * assert.deepStrictEqual(implies(false, false), true)
 * ```
 *
 * @category combinators
 * @since 2.0.0
 */
export const implies: {
  (that: boolean): (self: boolean) => boolean
  (self: boolean, that: boolean): boolean
} = dual(2, (self, that) => self ? that : true)

/**
 * This utility function is used to check if all the elements in a collection of boolean values are `true`.
 *
 * @example
 * ```ts
 * import { every } from "effect/Boolean"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(every([true, true, true]), true)
 * assert.deepStrictEqual(every([true, false, true]), false)
 * ```
 *
 * @category utilities
 * @since 2.0.0
 */
export const every = (collection: Iterable<boolean>): boolean => {
  for (const b of collection) {
    if (!b) {
      return false
    }
  }
  return true
}

/**
 * This utility function is used to check if at least one of the elements in a collection of boolean values is `true`.
 *
 * @example
 * ```ts
 * import { some } from "effect/Boolean"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(some([true, false, true]), true)
 * assert.deepStrictEqual(some([false, false, false]), false)
 * ```
 *
 * @category utilities
 * @since 2.0.0
 */
export const some = (collection: Iterable<boolean>): boolean => {
  for (const b of collection) {
    if (b) {
      return true
    }
  }
  return false
}

/**
 * A `Reducer` for combining `boolean`s using AND.
 *
 * The `initialValue` is `true`.
 *
 * @since 4.0.0
 */
export const ReducerAnd: Reducer.Reducer<boolean> = Reducer.make((a, b) => a && b, true)

/**
 * A `Reducer` for combining `boolean`s using OR.
 *
 * The `initialValue` is `false`.
 *
 * @since 4.0.0
 */
export const ReducerOr: Reducer.Reducer<boolean> = Reducer.make((a, b) => a || b, false)

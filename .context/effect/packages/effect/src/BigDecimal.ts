/**
 * This module provides utility functions and type class instances for working with the `BigDecimal` type in TypeScript.
 * It includes functions for basic arithmetic operations.
 *
 * A `BigDecimal` allows storing any real number to arbitrary precision; which avoids common floating point errors
 * (such as 0.1 + 0.2 ≠ 0.3) at the cost of complexity.
 *
 * Internally, `BigDecimal` uses a `BigInt` object, paired with a 64-bit integer which determines the position of the
 * decimal point. Therefore, the precision *is not* actually arbitrary, but limited to 2<sup>63</sup> decimal places.
 *
 * It is not recommended to convert a floating point number to a decimal directly, as the floating point representation
 * may be unexpected.
 *
 * @since 2.0.0
 */

import * as Equal from "./Equal.ts"
import * as Equ from "./Equivalence.ts"
import { dual } from "./Function.ts"
import * as Hash from "./Hash.ts"
import { type Inspectable, NodeInspectSymbol } from "./Inspectable.ts"
import * as Option from "./Option.ts"
import * as order from "./Order.ts"
import type { Ordering } from "./Ordering.ts"
import { type Pipeable, pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"

const DEFAULT_PRECISION = 100
const FINITE_INT_REGEXP = /^[+-]?\d+$/

const TypeId = "~effect/BigDecimal"

/**
 * Represents an arbitrary precision decimal number.
 *
 * @example
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * const d = BigDecimal.fromNumberUnsafe(123.45)
 *
 * d.value // 12345n
 * d.scale // 2
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface BigDecimal extends Equal.Equal, Pipeable, Inspectable {
  readonly [TypeId]: typeof TypeId
  readonly value: bigint
  readonly scale: number
  /** @internal */
  normalized?: BigDecimal
}

const BigDecimalProto: Omit<BigDecimal, "value" | "scale" | "normalized"> = {
  [TypeId]: TypeId,
  [Hash.symbol](this: BigDecimal): number {
    const normalized = normalize(this)
    return Hash.combine(Hash.hash(normalized.value), Hash.number(normalized.scale))
  },
  [Equal.symbol](this: BigDecimal, that: unknown): boolean {
    return isBigDecimal(that) && equals(this, that)
  },
  toString(this: BigDecimal) {
    return `BigDecimal(${format(this)})`
  },
  toJSON(this: BigDecimal) {
    return {
      _id: "BigDecimal",
      value: String(this.value),
      scale: this.scale
    }
  },
  [NodeInspectSymbol](this: BigDecimal) {
    return this.toJSON()
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
} as const

/**
 * Checks if a given value is a `BigDecimal`.
 *
 * @example
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * const decimal = BigDecimal.fromNumber(123.45)
 * console.log(BigDecimal.isBigDecimal(decimal)) // true
 * console.log(BigDecimal.isBigDecimal(123.45)) // false
 * console.log(BigDecimal.isBigDecimal("123.45")) // false
 * ```
 *
 * @since 2.0.0
 * @category guards
 */
export const isBigDecimal = (u: unknown): u is BigDecimal => hasProperty(u, TypeId)

/**
 * Creates a `BigDecimal` from a `bigint` value and a scale.
 *
 * @example
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * // Create 123.45 (12345 with scale 2)
 * const decimal = BigDecimal.make(12345n, 2)
 * console.log(BigDecimal.format(decimal)) // "123.45"
 *
 * // Create 42 (42 with scale 0)
 * const integer = BigDecimal.make(42n, 0)
 * console.log(BigDecimal.format(integer)) // "42"
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const make = (value: bigint, scale: number): BigDecimal => {
  const o = Object.create(BigDecimalProto)
  o.value = value
  o.scale = scale
  return o
}

/**
 * Internal function used to create pre-normalized `BigDecimal`s.
 *
 * @internal
 */
export const makeNormalizedUnsafe = (value: bigint, scale: number): BigDecimal => {
  if (value !== bigint0 && value % bigint10 === bigint0) {
    throw new RangeError("Value must be normalized")
  }

  const o = make(value, scale)
  o.normalized = o
  return o
}

const bigint0 = BigInt(0)
const bigint1 = BigInt(1)
const bigint10 = BigInt(10)
const zero = makeNormalizedUnsafe(bigint0, 0)

/**
 * Normalizes a given `BigDecimal` by removing trailing zeros.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, make, normalize } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   normalize(fromStringUnsafe("123.00000")),
 *   normalize(make(123n, 0))
 * )
 * assert.deepStrictEqual(
 *   normalize(fromStringUnsafe("12300000")),
 *   normalize(make(123n, -5))
 * )
 * ```
 *
 * @since 2.0.0
 * @category scaling
 */
export const normalize = (self: BigDecimal): BigDecimal => {
  if (self.normalized === undefined) {
    if (self.value === bigint0) {
      self.normalized = zero
    } else {
      const digits = `${self.value}`

      let trail = 0
      for (let i = digits.length - 1; i >= 0; i--) {
        if (digits[i] === "0") {
          trail++
        } else {
          break
        }
      }

      if (trail === 0) {
        self.normalized = self
      }

      const value = BigInt(digits.substring(0, digits.length - trail))
      const scale = self.scale - trail
      self.normalized = makeNormalizedUnsafe(value, scale)
    }
  }

  return self.normalized
}

/**
 * Scales a given `BigDecimal` to the specified scale.
 *
 * If the given scale is smaller than the current scale, the value will be rounded down to
 * the nearest integer.
 *
 * @example
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * const decimal = BigDecimal.fromNumberUnsafe(123.45)
 *
 * // Increase scale (add more precision)
 * const scaled = BigDecimal.scale(decimal, 4)
 * console.log(BigDecimal.format(scaled)) // "123.4500"
 *
 * // Decrease scale (reduce precision, rounds down)
 * const reduced = BigDecimal.scale(decimal, 1)
 * console.log(BigDecimal.format(reduced)) // "123.4"
 * ```
 *
 * @since 2.0.0
 * @category scaling
 */
export const scale: {
  (scale: number): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, scale: number): BigDecimal
} = dual(2, (self: BigDecimal, scale: number): BigDecimal => {
  if (scale > self.scale) {
    return make(self.value * bigint10 ** BigInt(scale - self.scale), scale)
  }

  if (scale < self.scale) {
    return make(self.value / bigint10 ** BigInt(self.scale - scale), scale)
  }

  return self
})

/**
 * Provides an addition operation on `BigDecimal`s.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, sum } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   sum(fromStringUnsafe("2"), fromStringUnsafe("3")),
 *   fromStringUnsafe("5")
 * )
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const sum: {
  (that: BigDecimal): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, that: BigDecimal): BigDecimal
} = dual(2, (self: BigDecimal, that: BigDecimal): BigDecimal => {
  if (that.value === bigint0) {
    return self
  }

  if (self.value === bigint0) {
    return that
  }

  if (self.scale > that.scale) {
    return make(scale(that, self.scale).value + self.value, self.scale)
  }

  if (self.scale < that.scale) {
    return make(scale(self, that.scale).value + that.value, that.scale)
  }

  return make(self.value + that.value, self.scale)
})

/**
 * Provides a multiplication operation on `BigDecimal`s.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, multiply } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   multiply(fromStringUnsafe("2"), fromStringUnsafe("3")),
 *   fromStringUnsafe("6")
 * )
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const multiply: {
  (that: BigDecimal): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, that: BigDecimal): BigDecimal
} = dual(2, (self: BigDecimal, that: BigDecimal): BigDecimal => {
  if (that.value === bigint0 || self.value === bigint0) {
    return zero
  }

  return make(self.value * that.value, self.scale + that.scale)
})

/**
 * Provides a subtraction operation on `BigDecimal`s.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, subtract } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   subtract(fromStringUnsafe("2"), fromStringUnsafe("3")),
 *   fromStringUnsafe("-1")
 * )
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const subtract: {
  (that: BigDecimal): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, that: BigDecimal): BigDecimal
} = dual(2, (self: BigDecimal, that: BigDecimal): BigDecimal => {
  if (that.value === bigint0) {
    return self
  }

  if (self.value === bigint0) {
    return make(-that.value, that.scale)
  }

  if (self.scale > that.scale) {
    return make(self.value - scale(that, self.scale).value, self.scale)
  }

  if (self.scale < that.scale) {
    return make(scale(self, that.scale).value - that.value, that.scale)
  }

  return make(self.value - that.value, self.scale)
})

/**
 * Internal function used for arbitrary precision division.
 */
const divideWithPrecision = (
  num: bigint,
  den: bigint,
  scale: number,
  precision: number
): BigDecimal => {
  const numNegative = num < bigint0
  const denNegative = den < bigint0
  const negateResult = numNegative !== denNegative

  num = numNegative ? -num : num
  den = denNegative ? -den : den

  // Shift digits until numerator is larger than denominator (set scale appropriately).
  while (num < den) {
    num *= bigint10
    scale++
  }

  // First division.
  let quotient = num / den
  let remainder = num % den

  if (remainder === bigint0) {
    // No remainder, return immediately.
    return make(negateResult ? -quotient : quotient, scale)
  }

  // The quotient is guaranteed to be non-negative at this point. No need to consider sign.
  let count = `${quotient}`.length

  // Shift the remainder by 1 decimal; The quotient will be 1 digit upon next division.
  remainder *= bigint10
  while (remainder !== bigint0 && count < precision) {
    const q = remainder / den
    const r = remainder % den
    quotient = quotient * bigint10 + q
    remainder = r * bigint10

    count++
    scale++
  }

  if (remainder !== bigint0) {
    // Round final number with remainder.
    quotient += roundTerminal(remainder / den)
  }

  return make(negateResult ? -quotient : quotient, scale)
}

/**
 * Internal function used for rounding.
 *
 * Returns 1 if the most significant digit is >= 5, otherwise 0.
 *
 * This is used after dividing a number by a power of ten and rounding the last digit.
 *
 * @internal
 */
export const roundTerminal = (n: bigint): bigint => {
  const pos = n >= bigint0 ? 0 : 1
  return Number(`${n}`[pos]) < 5 ? bigint0 : bigint1
}

/**
 * Provides a division operation on `BigDecimal`s.
 *
 * If the dividend is not a multiple of the divisor the result will be a `BigDecimal` value
 * which represents the integer division rounded down to the nearest integer.
 *
 * If the divisor is `0`, the result will be `Option.none()`.
 *
 * @example
 * ```ts
 * import { BigDecimal, Option } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.divide(
 *     BigDecimal.fromStringUnsafe("6"),
 *     BigDecimal.fromStringUnsafe("3")
 *   ),
 *   Option.some(BigDecimal.fromStringUnsafe("2"))
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.divide(
 *     BigDecimal.fromStringUnsafe("6"),
 *     BigDecimal.fromStringUnsafe("4")
 *   ),
 *   Option.some(BigDecimal.fromStringUnsafe("1.5"))
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.divide(
 *     BigDecimal.fromStringUnsafe("6"),
 *     BigDecimal.fromStringUnsafe("0")
 *   ),
 *   Option.none()
 * )
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const divide: {
  (that: BigDecimal): (self: BigDecimal) => Option.Option<BigDecimal>
  (self: BigDecimal, that: BigDecimal): Option.Option<BigDecimal>
} = dual(2, (self: BigDecimal, that: BigDecimal): Option.Option<BigDecimal> => {
  if (that.value === bigint0) {
    return Option.none()
  }

  if (self.value === bigint0) {
    return Option.some(zero)
  }

  const scale = self.scale - that.scale
  if (self.value === that.value) {
    return Option.some(make(bigint1, scale))
  }

  return Option.some(divideWithPrecision(self.value, that.value, scale, DEFAULT_PRECISION))
})

/**
 * Provides an unsafe division operation on `BigDecimal`s.
 *
 * If the dividend is not a multiple of the divisor the result will be a `BigDecimal` value
 * which represents the integer division rounded down to the nearest integer.
 *
 * Throws a `RangeError` if the divisor is `0`.
 *
 * @example
 * ```ts
 * import { divideUnsafe, fromStringUnsafe } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   divideUnsafe(fromStringUnsafe("6"), fromStringUnsafe("3")),
 *   fromStringUnsafe("2")
 * )
 * assert.deepStrictEqual(
 *   divideUnsafe(fromStringUnsafe("6"), fromStringUnsafe("4")),
 *   fromStringUnsafe("1.5")
 * )
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const divideUnsafe: {
  (that: BigDecimal): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, that: BigDecimal): BigDecimal
} = dual(2, (self: BigDecimal, that: BigDecimal): BigDecimal => {
  if (that.value === bigint0) {
    throw new RangeError("Division by zero")
  }

  if (self.value === bigint0) {
    return zero
  }

  const scale = self.scale - that.scale
  if (self.value === that.value) {
    return make(bigint1, scale)
  }
  return divideWithPrecision(self.value, that.value, scale, DEFAULT_PRECISION)
})

/**
 * Provides an `Order` instance for `BigDecimal` that allows comparing and sorting BigDecimal values.
 *
 * @example
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * const a = BigDecimal.fromNumberUnsafe(1.5)
 * const b = BigDecimal.fromNumberUnsafe(2.3)
 * const c = BigDecimal.fromNumberUnsafe(1.5)
 *
 * console.log(BigDecimal.Order(a, b)) // -1 (a < b)
 * console.log(BigDecimal.Order(b, a)) // 1 (b > a)
 * console.log(BigDecimal.Order(a, c)) // 0 (a === c)
 * ```
 *
 * @since 2.0.0
 * @category instances
 */
export const Order: order.Order<BigDecimal> = order.make((self, that) => {
  const scmp = order.Number(sign(self), sign(that))
  if (scmp !== 0) {
    return scmp
  }

  if (self.scale > that.scale) {
    return order.BigInt(self.value, scale(that, self.scale).value)
  }

  if (self.scale < that.scale) {
    return order.BigInt(scale(self, that.scale).value, that.value)
  }

  return order.BigInt(self.value, that.value)
})

/**
 * Returns `true` if the first argument is less than the second, otherwise `false`.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, isLessThan } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   isLessThan(fromStringUnsafe("2"), fromStringUnsafe("3")),
 *   true
 * )
 * assert.deepStrictEqual(
 *   isLessThan(fromStringUnsafe("3"), fromStringUnsafe("3")),
 *   false
 * )
 * assert.deepStrictEqual(
 *   isLessThan(fromStringUnsafe("4"), fromStringUnsafe("3")),
 *   false
 * )
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const isLessThan: {
  (that: BigDecimal): (self: BigDecimal) => boolean
  (self: BigDecimal, that: BigDecimal): boolean
} = order.isLessThan(Order)

/**
 * Checks if a given `BigDecimal` is less than or equal to the provided one.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, isLessThanOrEqualTo } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   isLessThanOrEqualTo(fromStringUnsafe("2"), fromStringUnsafe("3")),
 *   true
 * )
 * assert.deepStrictEqual(
 *   isLessThanOrEqualTo(fromStringUnsafe("3"), fromStringUnsafe("3")),
 *   true
 * )
 * assert.deepStrictEqual(
 *   isLessThanOrEqualTo(fromStringUnsafe("4"), fromStringUnsafe("3")),
 *   false
 * )
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const isLessThanOrEqualTo: {
  (that: BigDecimal): (self: BigDecimal) => boolean
  (self: BigDecimal, that: BigDecimal): boolean
} = order.isLessThanOrEqualTo(Order)

/**
 * Returns `true` if the first argument is greater than the second, otherwise `false`.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, isGreaterThan } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   isGreaterThan(fromStringUnsafe("2"), fromStringUnsafe("3")),
 *   false
 * )
 * assert.deepStrictEqual(
 *   isGreaterThan(fromStringUnsafe("3"), fromStringUnsafe("3")),
 *   false
 * )
 * assert.deepStrictEqual(
 *   isGreaterThan(fromStringUnsafe("4"), fromStringUnsafe("3")),
 *   true
 * )
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const isGreaterThan: {
  (that: BigDecimal): (self: BigDecimal) => boolean
  (self: BigDecimal, that: BigDecimal): boolean
} = order.isGreaterThan(Order)

/**
 * Checks if a given `BigDecimal` is greater than or equal to the provided one.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, isGreaterThanOrEqualTo } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   isGreaterThanOrEqualTo(fromStringUnsafe("2"), fromStringUnsafe("3")),
 *   false
 * )
 * assert.deepStrictEqual(
 *   isGreaterThanOrEqualTo(fromStringUnsafe("3"), fromStringUnsafe("3")),
 *   true
 * )
 * assert.deepStrictEqual(
 *   isGreaterThanOrEqualTo(fromStringUnsafe("4"), fromStringUnsafe("3")),
 *   true
 * )
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const isGreaterThanOrEqualTo: {
  (that: BigDecimal): (self: BigDecimal) => boolean
  (self: BigDecimal, that: BigDecimal): boolean
} = order.isGreaterThanOrEqualTo(Order)

/**
 * Checks if a `BigDecimal` is between a `minimum` and `maximum` value (inclusive).
 *
 * @example
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * const between = BigDecimal.between({
 *   minimum: BigDecimal.fromStringUnsafe("1"),
 *   maximum: BigDecimal.fromStringUnsafe("5")
 * })
 *
 * assert.deepStrictEqual(between(BigDecimal.fromStringUnsafe("3")), true)
 * assert.deepStrictEqual(between(BigDecimal.fromStringUnsafe("0")), false)
 * assert.deepStrictEqual(between(BigDecimal.fromStringUnsafe("6")), false)
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const between: {
  (options: {
    minimum: BigDecimal
    maximum: BigDecimal
  }): (self: BigDecimal) => boolean
  (self: BigDecimal, options: {
    minimum: BigDecimal
    maximum: BigDecimal
  }): boolean
} = order.isBetween(Order)

/**
 * Restricts the given `BigDecimal` to be within the range specified by the `minimum` and `maximum` values.
 *
 * - If the `BigDecimal` is less than the `minimum` value, the function returns the `minimum` value.
 * - If the `BigDecimal` is greater than the `maximum` value, the function returns the `maximum` value.
 * - Otherwise, it returns the original `BigDecimal`.
 *
 * @example
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * const clamp = BigDecimal.clamp({
 *   minimum: BigDecimal.fromStringUnsafe("1"),
 *   maximum: BigDecimal.fromStringUnsafe("5")
 * })
 *
 * assert.deepStrictEqual(
 *   clamp(BigDecimal.fromStringUnsafe("3")),
 *   BigDecimal.fromStringUnsafe("3")
 * )
 * assert.deepStrictEqual(
 *   clamp(BigDecimal.fromStringUnsafe("0")),
 *   BigDecimal.fromStringUnsafe("1")
 * )
 * assert.deepStrictEqual(
 *   clamp(BigDecimal.fromStringUnsafe("6")),
 *   BigDecimal.fromStringUnsafe("5")
 * )
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const clamp: {
  (options: {
    minimum: BigDecimal
    maximum: BigDecimal
  }): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, options: {
    minimum: BigDecimal
    maximum: BigDecimal
  }): BigDecimal
} = order.clamp(Order)

/**
 * Returns the minimum between two `BigDecimal`s.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, min } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   min(fromStringUnsafe("2"), fromStringUnsafe("3")),
 *   fromStringUnsafe("2")
 * )
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const min: {
  (that: BigDecimal): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, that: BigDecimal): BigDecimal
} = order.min(Order)

/**
 * Returns the maximum between two `BigDecimal`s.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, max } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   max(fromStringUnsafe("2"), fromStringUnsafe("3")),
 *   fromStringUnsafe("3")
 * )
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const max: {
  (that: BigDecimal): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, that: BigDecimal): BigDecimal
} = order.max(Order)

/**
 * Determines the sign of a given `BigDecimal`.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, sign } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(sign(fromStringUnsafe("-5")), -1)
 * assert.deepStrictEqual(sign(fromStringUnsafe("0")), 0)
 * assert.deepStrictEqual(sign(fromStringUnsafe("5")), 1)
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const sign = (n: BigDecimal): Ordering => n.value === bigint0 ? 0 : n.value < bigint0 ? -1 : 1

/**
 * Determines the absolute value of a given `BigDecimal`.
 *
 * @example
 * ```ts
 * import { abs, fromStringUnsafe } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(abs(fromStringUnsafe("-5")), fromStringUnsafe("5"))
 * assert.deepStrictEqual(abs(fromStringUnsafe("0")), fromStringUnsafe("0"))
 * assert.deepStrictEqual(abs(fromStringUnsafe("5")), fromStringUnsafe("5"))
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const abs = (n: BigDecimal): BigDecimal => n.value < bigint0 ? make(-n.value, n.scale) : n

/**
 * Provides a negate operation on `BigDecimal`s.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, negate } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(negate(fromStringUnsafe("3")), fromStringUnsafe("-3"))
 * assert.deepStrictEqual(negate(fromStringUnsafe("-6")), fromStringUnsafe("6"))
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const negate = (n: BigDecimal): BigDecimal => make(-n.value, n.scale)

/**
 * Returns the remainder left over when one operand is divided by a second operand.
 *
 * If the divisor is `0`, the result will be `Option.none()`.
 *
 * @example
 * ```ts
 * import { BigDecimal, Option } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.remainder(
 *     BigDecimal.fromStringUnsafe("2"),
 *     BigDecimal.fromStringUnsafe("2")
 *   ),
 *   Option.some(BigDecimal.fromStringUnsafe("0"))
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.remainder(
 *     BigDecimal.fromStringUnsafe("3"),
 *     BigDecimal.fromStringUnsafe("2")
 *   ),
 *   Option.some(BigDecimal.fromStringUnsafe("1"))
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.remainder(
 *     BigDecimal.fromStringUnsafe("-4"),
 *     BigDecimal.fromStringUnsafe("2")
 *   ),
 *   Option.some(BigDecimal.fromStringUnsafe("0"))
 * )
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const remainder: {
  (divisor: BigDecimal): (self: BigDecimal) => Option.Option<BigDecimal>
  (self: BigDecimal, divisor: BigDecimal): Option.Option<BigDecimal>
} = dual(2, (self: BigDecimal, divisor: BigDecimal): Option.Option<BigDecimal> => {
  if (divisor.value === bigint0) {
    return Option.none()
  }

  const max = Math.max(self.scale, divisor.scale)
  return Option.some(make(scale(self, max).value % scale(divisor, max).value, max))
})

/**
 * Returns the remainder left over when one operand is divided by a second operand.
 *
 * Throws a `RangeError` if the divisor is `0`.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, remainderUnsafe } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   remainderUnsafe(fromStringUnsafe("2"), fromStringUnsafe("2")),
 *   fromStringUnsafe("0")
 * )
 * assert.deepStrictEqual(
 *   remainderUnsafe(fromStringUnsafe("3"), fromStringUnsafe("2")),
 *   fromStringUnsafe("1")
 * )
 * assert.deepStrictEqual(
 *   remainderUnsafe(fromStringUnsafe("-4"), fromStringUnsafe("2")),
 *   fromStringUnsafe("0")
 * )
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const remainderUnsafe: {
  (divisor: BigDecimal): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, divisor: BigDecimal): BigDecimal
} = dual(2, (self: BigDecimal, divisor: BigDecimal): BigDecimal => {
  if (divisor.value === bigint0) {
    throw new RangeError("Division by zero")
  }

  const max = Math.max(self.scale, divisor.scale)
  return make(scale(self, max).value % scale(divisor, max).value, max)
})

/**
 * Provides an `Equivalence` instance for `BigDecimal` that determines equality between BigDecimal values.
 *
 * @example
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * const a = BigDecimal.fromNumberUnsafe(1.50)
 * const b = BigDecimal.fromNumberUnsafe(1.5)
 * const c = BigDecimal.fromNumberUnsafe(2.0)
 *
 * console.log(BigDecimal.Equivalence(a, b)) // true (1.50 === 1.5)
 * console.log(BigDecimal.Equivalence(a, c)) // false (1.50 !== 2.0)
 * ```
 *
 * @category instances
 * @since 2.0.0
 */
export const Equivalence: Equ.Equivalence<BigDecimal> = Equ.make((self, that) => {
  if (self.scale > that.scale) {
    return scale(that, self.scale).value === self.value
  }

  if (self.scale < that.scale) {
    return scale(self, that.scale).value === that.value
  }

  return self.value === that.value
})

/**
 * Checks if two `BigDecimal`s are equal.
 *
 * @example
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * const a = BigDecimal.fromNumberUnsafe(1.5)
 * const b = BigDecimal.fromNumberUnsafe(1.50)
 * const c = BigDecimal.fromNumberUnsafe(2.0)
 *
 * console.log(BigDecimal.equals(a, b)) // true
 * console.log(BigDecimal.equals(a, c)) // false
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const equals: {
  (that: BigDecimal): (self: BigDecimal) => boolean
  (self: BigDecimal, that: BigDecimal): boolean
} = dual(2, (self: BigDecimal, that: BigDecimal): boolean => Equivalence(self, that))

/**
 * Creates a `BigDecimal` from a `bigint` value.
 *
 * @example
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * const decimal = BigDecimal.fromBigInt(123n)
 * console.log(BigDecimal.format(decimal)) // "123"
 *
 * const largeBigInt = BigDecimal.fromBigInt(9007199254740991n)
 * console.log(BigDecimal.format(largeBigInt)) // "9007199254740991"
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const fromBigInt = (n: bigint): BigDecimal => make(n, 0)

/**
 * Creates a `BigDecimal` from a `number` value.
 *
 * It is not recommended to convert a floating point number to a decimal directly,
 * as the floating point representation may be unexpected.
 *
 * Throws a `RangeError` if the number is not finite (`NaN`, `+Infinity` or `-Infinity`).
 *
 * @example
 * ```ts
 * import { fromNumberUnsafe, make } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(fromNumberUnsafe(123), make(123n, 0))
 * assert.deepStrictEqual(fromNumberUnsafe(123.456), make(123456n, 3))
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const fromNumberUnsafe = (n: number): BigDecimal => {
  return Option.getOrThrowWith(fromNumber(n), () => new RangeError(`Number must be finite, got ${n}`))
}

/**
 * Creates a `BigDecimal` from a `number` value.
 *
 * It is not recommended to convert a floating point number to a decimal directly,
 * as the floating point representation may be unexpected.
 *
 * Returns `Option.none()` for `NaN`, `+Infinity` or `-Infinity`.
 *
 * @example
 * ```ts
 * import { BigDecimal, Option } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.fromNumber(123), Option.some(BigDecimal.make(123n, 0)))
 * assert.deepStrictEqual(
 *   BigDecimal.fromNumber(123.456),
 *   Option.some(BigDecimal.make(123456n, 3))
 * )
 * assert.deepStrictEqual(BigDecimal.fromNumber(Infinity), Option.none())
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const fromNumber = (n: number): Option.Option<BigDecimal> => {
  if (!Number.isFinite(n)) {
    return Option.none()
  }

  const string = `${n}`
  if (string.includes("e")) {
    return fromString(string)
  }

  const [lead, trail = ""] = string.split(".")
  return Option.some(make(BigInt(`${lead}${trail}`), trail.length))
}

/**
 * Parses a numerical `string` into a `BigDecimal`.
 *
 * @example
 * ```ts
 * import { BigDecimal, Option } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.fromString("123"), Option.some(BigDecimal.make(123n, 0)))
 * assert.deepStrictEqual(
 *   BigDecimal.fromString("123.456"),
 *   Option.some(BigDecimal.make(123456n, 3))
 * )
 * assert.deepStrictEqual(BigDecimal.fromString("123.abc"), Option.none())
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const fromString = (s: string): Option.Option<BigDecimal> => {
  if (s === "") {
    return Option.some(zero)
  }

  let base: string
  let exp: number
  const seperator = s.search(/[eE]/)
  if (seperator !== -1) {
    const trail = s.slice(seperator + 1)
    base = s.slice(0, seperator)
    exp = Number(trail)
    if (base === "" || !Number.isSafeInteger(exp) || !FINITE_INT_REGEXP.test(trail)) {
      return Option.none()
    }
  } else {
    base = s
    exp = 0
  }

  let digits: string
  let offset: number
  const dot = base.search(/\./)
  if (dot !== -1) {
    const lead = base.slice(0, dot)
    const trail = base.slice(dot + 1)
    digits = `${lead}${trail}`
    offset = trail.length
  } else {
    digits = base
    offset = 0
  }

  if (!FINITE_INT_REGEXP.test(digits)) {
    return Option.none()
  }

  const scale = offset - exp
  if (!Number.isSafeInteger(scale)) {
    return Option.none()
  }

  return Option.some(make(BigInt(digits), scale))
}

/**
 * Parses a numerical `string` into a `BigDecimal`.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, make } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(fromStringUnsafe("123"), make(123n, 0))
 * assert.deepStrictEqual(fromStringUnsafe("123.456"), make(123456n, 3))
 * assert.throws(() => fromStringUnsafe("123.abc"))
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const fromStringUnsafe = (s: string): BigDecimal => {
  return Option.getOrThrowWith(fromString(s), () => new Error(`Invalid numerical string: ${s}`))
}

/**
 * Formats a given `BigDecimal` as a `string`.
 *
 * If the scale of the `BigDecimal` is greater than or equal to 16, the `BigDecimal` will
 * be formatted in scientific notation.
 *
 * @example
 * ```ts
 * import { format, fromStringUnsafe } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(format(fromStringUnsafe("-5")), "-5")
 * assert.deepStrictEqual(format(fromStringUnsafe("123.456")), "123.456")
 * assert.deepStrictEqual(format(fromStringUnsafe("-0.00000123")), "-0.00000123")
 * ```
 *
 * @since 2.0.0
 * @category conversions
 */
export const format = (n: BigDecimal): string => {
  const normalized = normalize(n)
  if (Math.abs(normalized.scale) >= 16) {
    return toExponential(normalized)
  }

  const negative = normalized.value < bigint0
  const absolute = negative ? `${normalized.value}`.substring(1) : `${normalized.value}`

  let before: string
  let after: string

  if (normalized.scale >= absolute.length) {
    before = "0"
    after = "0".repeat(normalized.scale - absolute.length) + absolute
  } else {
    const location = absolute.length - normalized.scale
    if (location > absolute.length) {
      const zeros = location - absolute.length
      before = `${absolute}${"0".repeat(zeros)}`
      after = ""
    } else {
      after = absolute.slice(location)
      before = absolute.slice(0, location)
    }
  }

  const complete = after === "" ? before : `${before}.${after}`
  return negative ? `-${complete}` : complete
}

/**
 * Formats a given `BigDecimal` as a `string` in scientific notation.
 *
 * @example
 * ```ts
 * import { make, toExponential } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(toExponential(make(123456n, -5)), "1.23456e+10")
 * ```
 *
 * @since 4.0.0
 * @category conversions
 */
export const toExponential = (n: BigDecimal): string => {
  if (isZero(n)) {
    return "0e+0"
  }

  const normalized = normalize(n)
  const digits = `${abs(normalized).value}`
  const head = digits.slice(0, 1)
  const tail = digits.slice(1)

  let output = `${isNegative(normalized) ? "-" : ""}${head}`
  if (tail !== "") {
    output += `.${tail}`
  }

  const exp = tail.length - normalized.scale
  return `${output}e${exp >= 0 ? "+" : ""}${exp}`
}

/**
 * Converts a `BigDecimal` to a `number`.
 *
 * This function will produce incorrect results if the `BigDecimal` exceeds the 64-bit range of a `number`.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, toNumberUnsafe } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(toNumberUnsafe(fromStringUnsafe("123.456")), 123.456)
 * ```
 *
 * @since 2.0.0
 * @category conversions
 */
export const toNumberUnsafe = (n: BigDecimal): number => Number(format(n))

/**
 * Checks if a given `BigDecimal` is an integer.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, isInteger } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(isInteger(fromStringUnsafe("0")), true)
 * assert.deepStrictEqual(isInteger(fromStringUnsafe("1")), true)
 * assert.deepStrictEqual(isInteger(fromStringUnsafe("1.1")), false)
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const isInteger = (n: BigDecimal): boolean => normalize(n).scale <= 0

/**
 * Checks if a given `BigDecimal` is `0`.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, isZero } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(isZero(fromStringUnsafe("0")), true)
 * assert.deepStrictEqual(isZero(fromStringUnsafe("1")), false)
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const isZero = (n: BigDecimal): boolean => n.value === bigint0

/**
 * Checks if a given `BigDecimal` is negative.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, isNegative } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(isNegative(fromStringUnsafe("-1")), true)
 * assert.deepStrictEqual(isNegative(fromStringUnsafe("0")), false)
 * assert.deepStrictEqual(isNegative(fromStringUnsafe("1")), false)
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const isNegative = (n: BigDecimal): boolean => n.value < bigint0

/**
 * Checks if a given `BigDecimal` is positive.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, isPositive } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(isPositive(fromStringUnsafe("-1")), false)
 * assert.deepStrictEqual(isPositive(fromStringUnsafe("0")), false)
 * assert.deepStrictEqual(isPositive(fromStringUnsafe("1")), true)
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const isPositive = (n: BigDecimal): boolean => n.value > bigint0

const isBigDecimalArgs = (args: IArguments) => isBigDecimal(args[0])

/**
 * Rounding modes for `BigDecimal`.
 *
 * `ceil`: round towards positive infinity
 * `floor`: round towards negative infinity
 * `to-zero`: round towards zero
 * `from-zero`: round away from zero
 * `half-ceil`: round to the nearest neighbor; if equidistant round towards positive infinity
 * `half-floor`: round to the nearest neighbor; if equidistant round towards negative infinity
 * `half-to-zero`: round to the nearest neighbor; if equidistant round towards zero
 * `half-from-zero`: round to the nearest neighbor; if equidistant round away from zero
 * `half-even`: round to the nearest neighbor; if equidistant round to the neighbor with an even digit
 * `half-odd`: round to the nearest neighbor; if equidistant round to the neighbor with an odd digit
 *
 * @since 4.0.0
 * @category math
 */
export type RoundingMode =
  | "ceil"
  | "floor"
  | "to-zero"
  | "from-zero"
  | "half-ceil"
  | "half-floor"
  | "half-to-zero"
  | "half-from-zero"
  | "half-even"
  | "half-odd"

/**
 * Rounds a `BigDecimal` at the given scale with the specified rounding mode.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, round } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   round(fromStringUnsafe("145"), { mode: "from-zero", scale: -1 }),
 *   fromStringUnsafe("150")
 * )
 * assert.deepStrictEqual(
 *   round(fromStringUnsafe("-14.5")),
 *   fromStringUnsafe("-15")
 * )
 * ```
 *
 * @since 4.0.0
 * @category math
 */
export const round: {
  (options: { scale?: number; mode?: RoundingMode }): (self: BigDecimal) => BigDecimal
  (n: BigDecimal, options?: { scale?: number; mode?: RoundingMode }): BigDecimal
} = dual(isBigDecimalArgs, (self: BigDecimal, options?: { scale?: number; mode?: RoundingMode }): BigDecimal => {
  const mode = options?.mode ?? "half-from-zero"
  const scale = options?.scale ?? 0

  switch (mode) {
    case "ceil":
      return ceil(self, scale)

    case "floor":
      return floor(self, scale)

    case "to-zero":
      return truncate(self, scale)

    case "from-zero":
      return (isPositive(self) ? ceil(self, scale) : floor(self, scale))

    case "half-ceil":
      return floor(sum(self, make(5n, scale + 1)), scale)

    case "half-floor":
      return ceil(sum(self, make(-5n, scale + 1)), scale)

    case "half-to-zero":
      return isNegative(self)
        ? floor(sum(self, make(5n, scale + 1)), scale)
        : ceil(sum(self, make(-5n, scale + 1)), scale)

    case "half-from-zero":
      return isNegative(self)
        ? ceil(sum(self, make(-5n, scale + 1)), scale)
        : floor(sum(self, make(5n, scale + 1)), scale)
  }

  const halfCeil = floor(sum(self, make(5n, scale + 1)), scale)
  const halfFloor = ceil(sum(self, make(-5n, scale + 1)), scale)
  const digit = digitAt(halfCeil, scale)

  switch (mode) {
    case "half-even":
      return equals(halfCeil, halfFloor) ? halfCeil : (digit % 2n === 0n) ? halfCeil : halfFloor

    case "half-odd":
      return equals(halfCeil, halfFloor) ? halfCeil : (digit % 2n === 0n) ? halfFloor : halfCeil
  }
})

/**
 * Truncate a `BigDecimal` at the given scale. This is the same operation as rounding away from zero.
 *
 * @example
 * ```ts
 * import { fromStringUnsafe, truncate } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   truncate(fromStringUnsafe("145"), -1),
 *   fromStringUnsafe("140")
 * )
 * assert.deepStrictEqual(
 *   truncate(fromStringUnsafe("-14.5")),
 *   fromStringUnsafe("-14")
 * )
 * ```
 *
 * @since 4.0.0
 * @category math
 */
export const truncate: {
  (scale: number): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, scale?: number): BigDecimal
} = dual(isBigDecimalArgs, (self: BigDecimal, scale: number = 0): BigDecimal => {
  if (self.scale <= scale) {
    return self
  }

  // BigInt division truncates towards zero
  return make(self.value / (10n ** BigInt(self.scale - scale)), scale)
})

/**
 * Calculate the ceiling of a `BigDecimal` at the given scale.
 *
 * @example
 * ```ts
 * import { ceil, fromStringUnsafe } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   ceil(fromStringUnsafe("145"), -1),
 *   fromStringUnsafe("150")
 * )
 * assert.deepStrictEqual(ceil(fromStringUnsafe("-14.5")), fromStringUnsafe("-14"))
 * ```
 *
 * @since 4.0.0
 * @category math
 */
export const ceil: {
  (scale: number): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, scale?: number): BigDecimal
} = dual(isBigDecimalArgs, (self: BigDecimal, scale: number = 0): BigDecimal => {
  const truncated = truncate(self, scale)

  if (isPositive(self) && isLessThan(truncated, self)) {
    return sum(truncated, make(1n, scale))
  }

  return truncated
})

/**
 * Internal function used by `round` for `half-even` and `half-odd` rounding modes.
 *
 * Returns the digit at the position of the given `scale` within the `BigDecimal`.
 *
 * @internal
 */
export const digitAt: {
  (scale: number): (self: BigDecimal) => bigint
  (self: BigDecimal, scale: number): bigint
} = dual(2, (self: BigDecimal, scale: number): bigint => {
  if (self.scale < scale) {
    return 0n
  }

  const scaled = self.value / (10n ** BigInt(self.scale - scale))
  return scaled % 10n
})

/**
 * Calculate the floor of a `BigDecimal` at the given scale.
 *
 * @example
 * ```ts
 * import { floor, fromStringUnsafe } from "effect/BigDecimal"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   floor(fromStringUnsafe("145"), -1),
 *   fromStringUnsafe("140")
 * )
 * assert.deepStrictEqual(
 *   floor(fromStringUnsafe("-14.5")),
 *   fromStringUnsafe("-15")
 * )
 * ```
 *
 * @since 4.0.0
 * @category math
 */
export const floor: {
  (scale: number): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, scale?: number): BigDecimal
} = dual(isBigDecimalArgs, (self: BigDecimal, scale: number = 0): BigDecimal => {
  const truncated = truncate(self, scale)

  if (isNegative(self) && isGreaterThan(truncated, self)) {
    return sum(truncated, make(-1n, scale))
  }

  return truncated
})

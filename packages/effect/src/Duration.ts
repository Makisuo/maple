/**
 * This module provides utilities for working with durations of time. A `Duration`
 * is an immutable data type that represents a span of time with high precision,
 * supporting operations from nanoseconds to weeks.
 *
 * Durations support:
 * - **High precision**: Nanosecond-level accuracy using BigInt
 * - **Multiple formats**: Numbers (millis), BigInt (nanos), tuples, strings
 * - **Arithmetic operations**: Add, subtract, multiply, divide
 * - **Comparisons**: Equal, less than, greater than
 * - **Conversions**: Between different time units
 * - **Human-readable formatting**: Pretty printing and parsing
 *
 * @since 2.0.0
 */
import * as Combiner from "./Combiner.ts"
import * as Equal from "./Equal.ts"
import type * as Equ from "./Equivalence.ts"
import { dual, identity } from "./Function.ts"
import * as Hash from "./Hash.ts"
import type * as Inspectable from "./Inspectable.ts"
import { NodeInspectSymbol } from "./Inspectable.ts"
import * as Option from "./Option.ts"
import * as order from "./Order.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty, isNumber } from "./Predicate.ts"
import * as Reducer from "./Reducer.ts"

const TypeId = "~effect/time/Duration"

const bigint0 = BigInt(0)
const bigint24 = BigInt(24)
const bigint60 = BigInt(60)
const bigint1e3 = BigInt(1_000)
const bigint1e6 = BigInt(1_000_000)
const bigint1e9 = BigInt(1_000_000_000)

/**
 * Represents a span of time with high precision, supporting operations from
 * nanoseconds to weeks.
 *
 * @since 2.0.0
 * @category models
 */
export interface Duration extends Equal.Equal, Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId
  readonly value: DurationValue
}

/**
 * The internal representation of a `Duration` value.
 *
 * @since 2.0.0
 * @category models
 */
export type DurationValue =
  | { _tag: "Millis"; millis: number }
  | { _tag: "Nanos"; nanos: bigint }
  | { _tag: "Infinity" }
  | { _tag: "NegativeInfinity" }

/**
 * Valid time units that can be used in duration string representations.
 *
 * @since 2.0.0
 * @category models
 */
export type Unit =
  | "nano"
  | "nanos"
  | "micro"
  | "micros"
  | "milli"
  | "millis"
  | "second"
  | "seconds"
  | "minute"
  | "minutes"
  | "hour"
  | "hours"
  | "day"
  | "days"
  | "week"
  | "weeks"

/**
 * Valid input types that can be converted to a Duration.
 *
 * @since 2.0.0
 * @category models
 */
export type Input =
  | Duration
  | number // millis
  | bigint // nanos
  | readonly [seconds: number, nanos: number]
  | `${number} ${Unit}`
  | DurationObject

/**
 * An object with optional duration components that can be combined to create
 * a Duration. All fields are optional and additive.
 *
 * Compatible with Temporal.Duration-like objects.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * Duration.fromInputUnsafe({ seconds: 30 })
 * Duration.fromInputUnsafe({ days: 1 })
 * Duration.fromInputUnsafe({ seconds: 1, nanoseconds: 500 })
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export interface DurationObject {
  readonly weeks?: number | undefined
  readonly days?: number | undefined
  readonly hours?: number | undefined
  readonly minutes?: number | undefined
  readonly seconds?: number | undefined
  readonly milliseconds?: number | undefined
  readonly microseconds?: number | undefined
  readonly nanoseconds?: number | undefined
}

const DURATION_REGEXP = /^(-?\d+(?:\.\d+)?)\s+(nanos?|micros?|millis?|seconds?|minutes?|hours?|days?|weeks?)$/

/**
 * Decodes a `Duration.Input` into a `Duration`.
 *
 * If the input is not a valid `Duration.Input`, it throws an error.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const duration1 = Duration.fromInputUnsafe(1000) // 1000 milliseconds
 * const duration2 = Duration.fromInputUnsafe("5 seconds")
 * const duration3 = Duration.fromInputUnsafe([2, 500_000_000]) // 2 seconds and 500ms
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const fromInputUnsafe = (input: Input): Duration => {
  switch (typeof input) {
    case "number":
      return millis(input)
    case "bigint":
      return nanos(input)
    case "string": {
      const match = DURATION_REGEXP.exec(input)
      if (!match) break
      const [_, valueStr, unit] = match
      const value = Number(valueStr)
      switch (unit) {
        case "nano":
        case "nanos":
          return nanos(BigInt(valueStr))
        case "micro":
        case "micros":
          return micros(BigInt(valueStr))
        case "milli":
        case "millis":
          return millis(value)
        case "second":
        case "seconds":
          return seconds(value)
        case "minute":
        case "minutes":
          return minutes(value)
        case "hour":
        case "hours":
          return hours(value)
        case "day":
        case "days":
          return days(value)
        case "week":
        case "weeks":
          return weeks(value)
      }
      break
    }
    case "object": {
      if (input === null) break
      if (TypeId in input) return input as Duration
      if (Array.isArray(input)) {
        if (input.length !== 2 || !input.every(isNumber)) {
          return invalid(input)
        }
        if (Number.isNaN(input[0]) || Number.isNaN(input[1])) {
          return zero
        }
        if (input[0] === -Infinity || input[1] === -Infinity) {
          return negativeInfinity
        }
        if (input[0] === Infinity || input[1] === Infinity) {
          return infinity
        }
        return make(BigInt(Math.round(input[0] * 1_000_000_000)) + BigInt(Math.round(input[1])))
      }
      const obj = input as DurationObject
      let millis = 0
      // we can use truthy checks here, because 0 can be ignored
      if (obj.weeks) millis += obj.weeks * 604_800_000
      if (obj.days) millis += obj.days * 86_400_000
      if (obj.hours) millis += obj.hours * 3_600_000
      if (obj.minutes) millis += obj.minutes * 60_000
      if (obj.seconds) millis += obj.seconds * 1_000
      if (obj.milliseconds) millis += obj.milliseconds
      if (!obj.microseconds && !obj.nanoseconds) return make(millis)
      let nanos = BigInt(millis) * bigint1e6
      if (obj.microseconds) nanos += BigInt(obj.microseconds) * bigint1e3
      if (obj.nanoseconds) nanos += BigInt(obj.nanoseconds)
      return make(nanos)
    }
  }
  return invalid(input)
}

const invalid = (input: unknown): never => {
  throw new Error(`Invalid Input: ${input}`)
}

/**
 * Safely decodes a `Input` value into a `Duration`, returning
 * `Option.none()` if decoding fails.
 *
 * **Example**
 *
 * ```ts
 * import { Duration, Option } from "effect"
 *
 * Duration.fromInput(1000).pipe(Option.map(Duration.toSeconds)) // Some(1)
 *
 * Duration.fromInput("invalid" as any) // None
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromInput: (u: Input) => Option.Option<Duration> = Option.liftThrowable(
  fromInputUnsafe
)

const zeroDurationValue: DurationValue = { _tag: "Millis", millis: 0 }
const infinityDurationValue: DurationValue = { _tag: "Infinity" }
const negativeInfinityDurationValue: DurationValue = { _tag: "NegativeInfinity" }

const DurationProto: Omit<Duration, "value"> = {
  [TypeId]: TypeId,
  [Hash.symbol](this: Duration) {
    return Hash.structure(this.value)
  },
  [Equal.symbol](this: Duration, that: unknown): boolean {
    return isDuration(that) && equals(this, that)
  },
  toString(this: Duration) {
    switch (this.value._tag) {
      case "Infinity":
        return "Infinity"
      case "NegativeInfinity":
        return "-Infinity"
      case "Nanos":
        return `${this.value.nanos} nanos`
      case "Millis":
        return `${this.value.millis} millis`
    }
  },
  toJSON(this: Duration) {
    switch (this.value._tag) {
      case "Millis":
        return { _id: "Duration", _tag: "Millis", millis: this.value.millis }
      case "Nanos":
        return { _id: "Duration", _tag: "Nanos", nanos: String(this.value.nanos) }
      case "Infinity":
        return { _id: "Duration", _tag: "Infinity" }
      case "NegativeInfinity":
        return { _id: "Duration", _tag: "NegativeInfinity" }
    }
  },
  [NodeInspectSymbol]() {
    return this.toJSON()
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
} as const

const make = (input: number | bigint): Duration => {
  const duration = Object.create(DurationProto)
  if (typeof input === "number") {
    if (isNaN(input) || input === 0 || Object.is(input, -0)) {
      duration.value = zeroDurationValue
    } else if (!Number.isFinite(input)) {
      duration.value = input > 0 ? infinityDurationValue : negativeInfinityDurationValue
    } else if (!Number.isInteger(input)) {
      duration.value = { _tag: "Nanos", nanos: BigInt(Math.round(input * 1_000_000)) }
    } else {
      duration.value = { _tag: "Millis", millis: input }
    }
  } else if (input === bigint0) {
    duration.value = zeroDurationValue
  } else {
    duration.value = { _tag: "Nanos", nanos: input }
  }
  return duration
}

/**
 * Checks if a value is a Duration.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * console.log(Duration.isDuration(Duration.seconds(1))) // true
 * console.log(Duration.isDuration(1000)) // false
 * ```
 *
 * @since 2.0.0
 * @category guards
 */
export const isDuration = (u: unknown): u is Duration => hasProperty(u, TypeId)

/**
 * Checks if a Duration is finite (not infinite).
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * console.log(Duration.isFinite(Duration.seconds(5))) // true
 * console.log(Duration.isFinite(Duration.infinity)) // false
 * ```
 *
 * @since 2.0.0
 * @category guards
 */
export const isFinite = (self: Duration): boolean =>
  self.value._tag !== "Infinity" && self.value._tag !== "NegativeInfinity"

/**
 * Checks if a Duration is zero.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * console.log(Duration.isZero(Duration.zero)) // true
 * console.log(Duration.isZero(Duration.seconds(1))) // false
 * ```
 *
 * @since 3.5.0
 * @category guards
 */
export const isZero = (self: Duration): boolean => {
  switch (self.value._tag) {
    case "Millis":
      return self.value.millis === 0
    case "Nanos":
      return self.value.nanos === bigint0
    case "Infinity":
    case "NegativeInfinity":
      return false
  }
}

/**
 * Returns `true` if the duration is negative (strictly less than zero).
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * console.log(Duration.isNegative(Duration.seconds(-5))) // true
 * console.log(Duration.isNegative(Duration.zero)) // false
 * console.log(Duration.isNegative(Duration.negativeInfinity)) // true
 * ```
 *
 * @since 4.0.0
 * @category guards
 */
export const isNegative = (self: Duration): boolean => {
  switch (self.value._tag) {
    case "Millis":
      return self.value.millis < 0
    case "Nanos":
      return self.value.nanos < bigint0
    case "NegativeInfinity":
      return true
    case "Infinity":
      return false
  }
}

/**
 * Returns `true` if the duration is positive (strictly greater than zero).
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * console.log(Duration.isPositive(Duration.seconds(5))) // true
 * console.log(Duration.isPositive(Duration.zero)) // false
 * console.log(Duration.isPositive(Duration.infinity)) // true
 * ```
 *
 * @since 4.0.0
 * @category guards
 */
export const isPositive = (self: Duration): boolean => {
  switch (self.value._tag) {
    case "Millis":
      return self.value.millis > 0
    case "Nanos":
      return self.value.nanos > bigint0
    case "Infinity":
      return true
    case "NegativeInfinity":
      return false
  }
}

/**
 * Returns the absolute value of the duration.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * Duration.toMillis(Duration.abs(Duration.seconds(-5))) // 5000
 * Duration.abs(Duration.negativeInfinity) === Duration.infinity // true
 * ```
 *
 * @since 4.0.0
 * @category math
 */
export const abs = (self: Duration): Duration => {
  switch (self.value._tag) {
    case "Infinity":
    case "NegativeInfinity":
      return infinity
    case "Millis":
      return self.value.millis < 0 ? make(-self.value.millis) : self
    case "Nanos":
      return self.value.nanos < bigint0 ? make(-self.value.nanos) : self
  }
}

/**
 * Negates the duration.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * Duration.toMillis(Duration.negate(Duration.seconds(5))) // -5000
 * Duration.negate(Duration.infinity) === Duration.negativeInfinity // true
 * ```
 *
 * @since 4.0.0
 * @category math
 */
export const negate = (self: Duration): Duration => {
  switch (self.value._tag) {
    case "Infinity":
      return negativeInfinity
    case "NegativeInfinity":
      return infinity
    case "Millis":
      return self.value.millis === 0 ? self : make(-self.value.millis)
    case "Nanos":
      return self.value.nanos === bigint0 ? self : make(-self.value.nanos)
  }
}

/**
 * A Duration representing zero time.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * console.log(Duration.toMillis(Duration.zero)) // 0
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const zero: Duration = make(0)

/**
 * A Duration representing infinite time.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * console.log(Duration.toMillis(Duration.infinity)) // Infinity
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const infinity: Duration = make(Infinity)

/**
 * A Duration representing negative infinite time.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * console.log(Duration.toMillis(Duration.negativeInfinity)) // -Infinity
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const negativeInfinity: Duration = make(-Infinity)

/**
 * Creates a Duration from nanoseconds.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const duration = Duration.nanos(BigInt(500_000_000))
 * console.log(Duration.toMillis(duration)) // 500
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const nanos = (nanos: bigint): Duration => make(nanos)

/**
 * Creates a Duration from microseconds.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const duration = Duration.micros(BigInt(500_000))
 * console.log(Duration.toMillis(duration)) // 500
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const micros = (micros: bigint): Duration => make(micros * bigint1e3)

/**
 * Creates a Duration from milliseconds.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const duration = Duration.millis(1000)
 * console.log(Duration.toMillis(duration)) // 1000
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const millis = (millis: number): Duration => make(millis)

/**
 * Creates a Duration from seconds.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const duration = Duration.seconds(30)
 * console.log(Duration.toMillis(duration)) // 30000
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const seconds = (seconds: number): Duration => make(seconds * 1000)

/**
 * Creates a Duration from minutes.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const duration = Duration.minutes(5)
 * console.log(Duration.toMillis(duration)) // 300000
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const minutes = (minutes: number): Duration => make(minutes * 60_000)

/**
 * Creates a Duration from hours.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const duration = Duration.hours(2)
 * console.log(Duration.toMillis(duration)) // 7200000
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const hours = (hours: number): Duration => make(hours * 3_600_000)

/**
 * Creates a Duration from days.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const duration = Duration.days(1)
 * console.log(Duration.toMillis(duration)) // 86400000
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const days = (days: number): Duration => make(days * 86_400_000)

/**
 * Creates a Duration from weeks.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const duration = Duration.weeks(1)
 * console.log(Duration.toMillis(duration)) // 604800000
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const weeks = (weeks: number): Duration => make(weeks * 604_800_000)

/**
 * Converts a Duration to milliseconds.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * console.log(Duration.toMillis(Duration.seconds(5))) // 5000
 * console.log(Duration.toMillis(Duration.minutes(2))) // 120000
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const toMillis = (self: Duration): number =>
  match(self, {
    onMillis: identity,
    onNanos: (nanos) => Number(nanos) / 1_000_000,
    onInfinity: () => Infinity,
    onNegativeInfinity: () => -Infinity
  })

/**
 * Converts a Duration to seconds.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * console.log(Duration.toSeconds(Duration.millis(5000))) // 5
 * console.log(Duration.toSeconds(Duration.minutes(2))) // 120
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const toSeconds = (self: Duration): number =>
  match(self, {
    onMillis: (millis) => millis / 1_000,
    onNanos: (nanos) => Number(nanos) / 1_000_000_000,
    onInfinity: () => Infinity,
    onNegativeInfinity: () => -Infinity
  })

/**
 * Converts a Duration to minutes.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * console.log(Duration.toMinutes(Duration.seconds(120))) // 2
 * console.log(Duration.toMinutes(Duration.hours(1))) // 60
 * ```
 *
 * @since 3.8.0
 * @category getters
 */
export const toMinutes = (self: Duration): number =>
  match(self, {
    onMillis: (millis) => millis / 60_000,
    onNanos: (nanos) => Number(nanos) / 60_000_000_000,
    onInfinity: () => Infinity,
    onNegativeInfinity: () => -Infinity
  })

/**
 * Converts a Duration to hours.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * console.log(Duration.toHours(Duration.minutes(120))) // 2
 * console.log(Duration.toHours(Duration.days(1))) // 24
 * ```
 *
 * @since 3.8.0
 * @category getters
 */
export const toHours = (self: Duration): number =>
  match(self, {
    onMillis: (millis) => millis / 3_600_000,
    onNanos: (nanos) => Number(nanos) / 3_600_000_000_000,
    onInfinity: () => Infinity,
    onNegativeInfinity: () => -Infinity
  })

/**
 * Converts a Duration to days.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * console.log(Duration.toDays(Duration.hours(48))) // 2
 * console.log(Duration.toDays(Duration.weeks(1))) // 7
 * ```
 *
 * @since 3.8.0
 * @category getters
 */
export const toDays = (self: Duration): number =>
  match(self, {
    onMillis: (millis) => millis / 86_400_000,
    onNanos: (nanos) => Number(nanos) / 86_400_000_000_000,
    onInfinity: () => Infinity,
    onNegativeInfinity: () => -Infinity
  })

/**
 * Converts a Duration to weeks.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * console.log(Duration.toWeeks(Duration.days(14))) // 2
 * console.log(Duration.toWeeks(Duration.days(7))) // 1
 * ```
 *
 * @since 3.8.0
 * @category getters
 */
export const toWeeks = (self: Duration): number =>
  match(self, {
    onMillis: (millis) => millis / 604_800_000,
    onNanos: (nanos) => Number(nanos) / 604_800_000_000_000,
    onInfinity: () => Infinity,
    onNegativeInfinity: () => -Infinity
  })

/**
 * Get the duration in nanoseconds as a bigint.
 *
 * If the duration is infinite, it throws an error.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const duration = Duration.seconds(2)
 * const nanos = Duration.toNanosUnsafe(duration)
 * console.log(nanos) // 2000000000n
 *
 * // This will throw an error
 * try {
 *   Duration.toNanosUnsafe(Duration.infinity)
 * } catch (error) {
 *   console.log((error as Error).message) // "Cannot convert infinite duration to nanos"
 * }
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const toNanosUnsafe = (self: Duration): bigint => {
  switch (self.value._tag) {
    case "Infinity":
    case "NegativeInfinity":
      throw new Error("Cannot convert infinite duration to nanos")
    case "Nanos":
      return self.value.nanos
    case "Millis":
      return BigInt(Math.round(self.value.millis * 1_000_000))
  }
}

/**
 * Get the duration in nanoseconds as a bigint.
 *
 * If the duration is infinite, returns `Option.none()`.
 *
 * **Example**
 *
 * ```ts
 * import { Duration, Option } from "effect"
 *
 * Duration.toNanos(Duration.seconds(1)) // Some(1000000000n)
 *
 * Duration.toNanos(Duration.infinity) // None
 * Option.getOrUndefined(Duration.toNanos(Duration.infinity)) // undefined
 * ```
 *
 * @category getters
 * @since 4.0.0
 */
export const toNanos: (self: Duration) => Option.Option<bigint> = Option.liftThrowable(toNanosUnsafe)

/**
 * Converts a Duration to high-resolution time format [seconds, nanoseconds].
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const duration = Duration.millis(1500)
 * const hrtime = Duration.toHrTime(duration)
 * console.log(hrtime) // [1, 500000000]
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const toHrTime = (self: Duration): [seconds: number, nanos: number] => {
  switch (self.value._tag) {
    case "Infinity":
      return [Infinity, 0]
    case "NegativeInfinity":
      return [-Infinity, 0]
    case "Nanos": {
      const n = self.value.nanos
      const sign = n < bigint0 ? -BigInt(1) : BigInt(1)
      const a = n < bigint0 ? -n : n
      return [
        Number(sign * (a / bigint1e9)),
        Number(sign * (a % bigint1e9))
      ]
    }
    case "Millis": {
      const m = self.value.millis
      const sign = m < 0 ? -1 : 1
      const a = Math.abs(m)
      return [
        sign * Math.floor(a / 1000),
        sign * Math.round((a % 1000) * 1_000_000)
      ]
    }
  }
}

/**
 * Pattern matches on a Duration, providing different handlers for millis and nanos.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const result = Duration.match(Duration.seconds(5), {
 *   onMillis: (millis) => `${millis} milliseconds`,
 *   onNanos: (nanos) => `${nanos} nanoseconds`,
 *   onInfinity: () => "infinite"
 * })
 * console.log(result) // "5000 milliseconds"
 * ```
 *
 * @since 2.0.0
 * @category pattern matching
 */
export const match: {
  <A, B, C, D = C>(
    options: {
      readonly onMillis: (millis: number) => A
      readonly onNanos: (nanos: bigint) => B
      readonly onInfinity: () => C
      readonly onNegativeInfinity?: () => D
    }
  ): (self: Duration) => A | B | C | D
  <A, B, C, D = C>(
    self: Duration,
    options: {
      readonly onMillis: (millis: number) => A
      readonly onNanos: (nanos: bigint) => B
      readonly onInfinity: () => C
      readonly onNegativeInfinity?: () => D
    }
  ): A | B | C | D
} = dual(2, <A, B, C, D = C>(
  self: Duration,
  options: {
    readonly onMillis: (millis: number) => A
    readonly onNanos: (nanos: bigint) => B
    readonly onInfinity: () => C
    readonly onNegativeInfinity?: () => D
  }
): A | B | C | D => {
  switch (self.value._tag) {
    case "Millis":
      return options.onMillis(self.value.millis)
    case "Nanos":
      return options.onNanos(self.value.nanos)
    case "Infinity":
      return options.onInfinity()
    case "NegativeInfinity":
      return (options.onNegativeInfinity ?? options.onInfinity as unknown as () => D)()
  }
})

/**
 * Pattern matches on two `Duration`s, providing handlers that receive both values.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const sum = Duration.matchPair(Duration.seconds(3), Duration.seconds(2), {
 *   onMillis: (a, b) => a + b,
 *   onNanos: (a, b) => Number(a + b),
 *   onInfinity: () => Infinity
 * })
 * console.log(sum) // 5000
 * ```
 *
 * @since 2.0.0
 * @category pattern matching
 */
export const matchPair: {
  <A, B, C>(
    that: Duration,
    options: {
      readonly onMillis: (self: number, that: number) => A
      readonly onNanos: (self: bigint, that: bigint) => B
      readonly onInfinity: (self: Duration, that: Duration) => C
    }
  ): (self: Duration) => A | B | C
  <A, B, C>(
    self: Duration,
    that: Duration,
    options: {
      readonly onMillis: (self: number, that: number) => A
      readonly onNanos: (self: bigint, that: bigint) => B
      readonly onInfinity: (self: Duration, that: Duration) => C
    }
  ): A | B | C
} = dual(3, <A, B, C>(
  self: Duration,
  that: Duration,
  options: {
    readonly onMillis: (self: number, that: number) => A
    readonly onNanos: (self: bigint, that: bigint) => B
    readonly onInfinity: (self: Duration, that: Duration) => C
  }
): A | B | C => {
  if (
    self.value._tag === "Infinity" || self.value._tag === "NegativeInfinity" ||
    that.value._tag === "Infinity" || that.value._tag === "NegativeInfinity"
  ) return options.onInfinity(self, that)
  if (self.value._tag === "Millis") {
    return that.value._tag === "Millis"
      ? options.onMillis(self.value.millis, that.value.millis)
      : options.onNanos(toNanosUnsafe(self), that.value.nanos)
  } else {
    return options.onNanos(self.value.nanos, toNanosUnsafe(that))
  }
})

/**
 * Order instance for `Duration`, allowing comparison operations.
 *
 * `NegativeInfinity` < any finite value < `Infinity`.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const durations = [
 *   Duration.seconds(3),
 *   Duration.seconds(1),
 *   Duration.seconds(2)
 * ]
 * const sorted = durations.sort((a, b) => Duration.Order(a, b))
 * console.log(sorted.map(Duration.toSeconds)) // [1, 2, 3]
 * ```
 *
 * @category instances
 * @since 2.0.0
 */
export const Order: order.Order<Duration> = order.make((self, that) =>
  matchPair(self, that, {
    onMillis: (self, that) => (self < that ? -1 : self > that ? 1 : 0),
    onNanos: (self, that) => (self < that ? -1 : self > that ? 1 : 0),
    onInfinity: (self, that) => {
      if (self.value._tag === that.value._tag) return 0
      if (self.value._tag === "Infinity") return 1
      if (self.value._tag === "NegativeInfinity") return -1
      // self is finite
      if (that.value._tag === "Infinity") return -1
      // that is NegativeInfinity
      return 1
    }
  })
)

/**
 * Checks if a `Duration` is between a `minimum` and `maximum` value.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const isInRange = Duration.between(Duration.seconds(3), {
 *   minimum: Duration.seconds(2),
 *   maximum: Duration.seconds(5)
 * })
 * console.log(isInRange) // true
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const between: {
  (options: { minimum: Duration; maximum: Duration }): (self: Duration) => boolean
  (self: Duration, options: { minimum: Duration; maximum: Duration }): boolean
} = order.isBetween(Order)

/**
 * Equivalence instance for `Duration`, allowing equality comparisons.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const isEqual = Duration.Equivalence(Duration.seconds(5), Duration.millis(5000))
 * console.log(isEqual) // true
 * ```
 *
 * @category instances
 * @since 2.0.0
 */
export const Equivalence: Equ.Equivalence<Duration> = (self, that) =>
  matchPair(self, that, {
    onMillis: (self, that) => self === that,
    onNanos: (self, that) => self === that,
    onInfinity: (self, that) => self.value._tag === that.value._tag
  })

/**
 * Returns the smaller of two Durations.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const shorter = Duration.min(Duration.seconds(5), Duration.seconds(3))
 * console.log(Duration.toSeconds(shorter)) // 3
 * ```
 *
 * @since 2.0.0
 * @category order
 */
export const min: {
  (that: Duration): (self: Duration) => Duration
  (self: Duration, that: Duration): Duration
} = order.min(Order)

/**
 * Returns the larger of two Durations.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const longer = Duration.max(Duration.seconds(5), Duration.seconds(3))
 * console.log(Duration.toSeconds(longer)) // 5
 * ```
 *
 * @since 2.0.0
 * @category order
 */
export const max: {
  (that: Duration): (self: Duration) => Duration
  (self: Duration, that: Duration): Duration
} = order.max(Order)

/**
 * Clamps a Duration between a minimum and maximum value.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const clamped = Duration.clamp(Duration.seconds(10), {
 *   minimum: Duration.seconds(2),
 *   maximum: Duration.seconds(5)
 * })
 * console.log(Duration.toSeconds(clamped)) // 5
 * ```
 *
 * @since 2.0.0
 * @category order
 */
export const clamp: {
  (options: { minimum: Duration; maximum: Duration }): (self: Duration) => Duration
  (self: Duration, options: { minimum: Duration; maximum: Duration }): Duration
} = order.clamp(Order)

/**
 * Divides a Duration by a number, returning `Option.none()` if division is invalid.
 *
 * **Example**
 *
 * ```ts
 * import { Duration, Option } from "effect"
 *
 * const d = Duration.divide(Duration.seconds(10), 2)
 * console.log(Option.map(d, Duration.toSeconds)) // Some(5)
 *
 * Duration.divide(Duration.seconds(10), 0) // None
 * ```
 *
 * @since 4.0.0
 * @category math
 */
export const divide: {
  (by: number): (self: Duration) => Option.Option<Duration>
  (self: Duration, by: number): Option.Option<Duration>
} = dual(
  2,
  (self: Duration, by: number): Option.Option<Duration> => {
    if (!Number.isFinite(by)) return Option.none()
    if (by === 0 || Object.is(by, -0)) return Option.none()
    return match(self, {
      onMillis: (millis) => Option.some(make(millis / by)),
      onNanos: (nanos) => {
        try {
          return Option.some(make(nanos / BigInt(by)))
        } catch {
          return Option.none()
        }
      },
      onInfinity: () => Option.some(by > 0 ? infinity : negativeInfinity),
      onNegativeInfinity: () => Option.some(by > 0 ? negativeInfinity : infinity)
    })
  }
)

/**
 * Divides a Duration by a number, potentially returning infinity or zero.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const half = Duration.divideUnsafe(Duration.seconds(10), 2)
 * console.log(Duration.toSeconds(half)) // 5
 *
 * const infinite = Duration.divideUnsafe(Duration.seconds(10), 0)
 * console.log(Duration.toMillis(infinite)) // Infinity
 * ```
 *
 * @since 2.4.19
 * @category math
 */
export const divideUnsafe: {
  (by: number): (self: Duration) => Duration
  (self: Duration, by: number): Duration
} = dual(
  2,
  (self: Duration, by: number): Duration => {
    if (!Number.isFinite(by)) return zero
    return match(self, {
      onMillis: (millis) => make(millis / by),
      onNanos: (nanos) => {
        if (Object.is(by, 0) || Object.is(by, -0)) {
          if (nanos === bigint0) return zero
          // match IEEE 754: same sign → +infinity, different sign → -infinity
          const positiveNanos = nanos > bigint0
          const positiveZero = Object.is(by, 0)
          return (positiveNanos === positiveZero) ? infinity : negativeInfinity
        }
        try {
          return make(nanos / BigInt(by))
        } catch {
          return zero
        }
      },
      onInfinity: () => by > 0 ? infinity : by < 0 ? negativeInfinity : zero,
      onNegativeInfinity: () => by > 0 ? negativeInfinity : by < 0 ? infinity : zero
    })
  }
)

/**
 * Multiplies a Duration by a number.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const doubled = Duration.times(Duration.seconds(5), 2)
 * console.log(Duration.toSeconds(doubled)) // 10
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const times: {
  (times: number): (self: Duration) => Duration
  (self: Duration, times: number): Duration
} = dual(
  2,
  (self: Duration, times: number): Duration =>
    match(self, {
      onMillis: (millis) => make(millis * times),
      onNanos: (nanos) => make(nanos * BigInt(times)),
      onInfinity: () => times > 0 ? infinity : times < 0 ? negativeInfinity : zero,
      onNegativeInfinity: () => times > 0 ? negativeInfinity : times < 0 ? infinity : zero
    })
)

/**
 * Subtracts one Duration from another. The result can be negative.
 *
 * **Infinity Subtraction Rules**
 * - infinity - infinity = 0
 * - infinity - negativeInfinity = infinity
 * - infinity - finite = infinity
 * - negativeInfinity - negativeInfinity = 0
 * - negativeInfinity - infinity = negativeInfinity
 * - negativeInfinity - finite = negativeInfinity
 * - finite - infinity = negativeInfinity
 * - finite - negativeInfinity = infinity
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const result = Duration.subtract(Duration.seconds(10), Duration.seconds(3))
 * console.log(Duration.toSeconds(result)) // 7
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const subtract: {
  (that: Duration): (self: Duration) => Duration
  (self: Duration, that: Duration): Duration
} = dual(
  2,
  (self: Duration, that: Duration): Duration =>
    matchPair(self, that, {
      onMillis: (self, that) => make(self - that),
      onNanos: (self, that) => make(self - that),
      onInfinity: (self, that) => {
        const s = self.value._tag
        const t = that.value._tag
        if (s === "Infinity") return t === "Infinity" ? zero : infinity
        if (s === "NegativeInfinity") return t === "NegativeInfinity" ? zero : negativeInfinity
        return t === "Infinity" ? negativeInfinity : infinity
      }
    })
)

/**
 * Adds two Durations together.
 *
 * **Infinity Addition Rules**
 * - infinity + infinity = infinity
 * - infinity + negativeInfinity = zero
 * - infinity + finite = infinity
 * - negativeInfinity + negativeInfinity = negativeInfinity
 * - negativeInfinity + finite = negativeInfinity
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const total = Duration.sum(Duration.seconds(5), Duration.seconds(3))
 * console.log(Duration.toSeconds(total)) // 8
 * ```
 *
 * @since 2.0.0
 * @category math
 */
export const sum: {
  (that: Duration): (self: Duration) => Duration
  (self: Duration, that: Duration): Duration
} = dual(
  2,
  (self: Duration, that: Duration): Duration =>
    matchPair(self, that, {
      onMillis: (self, that) => make(self + that),
      onNanos: (self, that) => make(self + that),
      onInfinity: (self, that) => {
        const s = self.value._tag
        const t = that.value._tag
        if (s === "Infinity" && t === "NegativeInfinity") return zero
        if (s === "NegativeInfinity" && t === "Infinity") return zero
        if (s === "Infinity" || t === "Infinity") return infinity
        if (s === "NegativeInfinity" || t === "NegativeInfinity") return negativeInfinity
        // unreachable, but satisfy TS
        return zero
      }
    })
)

/**
 * Checks if the first Duration is less than the second.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const isLess = Duration.isLessThan(Duration.seconds(3), Duration.seconds(5))
 * console.log(isLess) // true
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const isLessThan: {
  (that: Duration): (self: Duration) => boolean
  (self: Duration, that: Duration): boolean
} = order.isLessThan(Order)

/**
 * Checks if the first Duration is less than or equal to the second.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const isLessOrEqual = Duration.isLessThanOrEqualTo(
 *   Duration.seconds(5),
 *   Duration.seconds(5)
 * )
 * console.log(isLessOrEqual) // true
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const isLessThanOrEqualTo: {
  (that: Duration): (self: Duration) => boolean
  (self: Duration, that: Duration): boolean
} = order.isLessThanOrEqualTo(Order)

/**
 * Checks if the first Duration is greater than the second.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const isGreater = Duration.isGreaterThan(Duration.seconds(5), Duration.seconds(3))
 * console.log(isGreater) // true
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const isGreaterThan: {
  (that: Duration): (self: Duration) => boolean
  (self: Duration, that: Duration): boolean
} = order.isGreaterThan(Order)

/**
 * Checks if the first Duration is greater than or equal to the second.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const isGreaterOrEqual = Duration.isGreaterThanOrEqualTo(
 *   Duration.seconds(5),
 *   Duration.seconds(5)
 * )
 * console.log(isGreaterOrEqual) // true
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const isGreaterThanOrEqualTo: {
  (that: Duration): (self: Duration) => boolean
  (self: Duration, that: Duration): boolean
} = order.isGreaterThanOrEqualTo(Order)

/**
 * Checks if two Durations are equal.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * const isEqual = Duration.equals(Duration.seconds(5), Duration.millis(5000))
 * console.log(isEqual) // true
 * ```
 *
 * @since 2.0.0
 * @category predicates
 */
export const equals: {
  (that: Duration): (self: Duration) => boolean
  (self: Duration, that: Duration): boolean
} = dual(2, (self: Duration, that: Duration): boolean => Equivalence(self, that))

/**
 * Converts a `Duration` to its parts.
 *
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * // Create a complex duration by adding multiple parts
 * const duration = Duration.sum(
 *   Duration.sum(
 *     Duration.sum(Duration.days(1), Duration.hours(2)),
 *     Duration.sum(Duration.minutes(30), Duration.seconds(45))
 *   ),
 *   Duration.millis(123)
 * )
 * const components = Duration.parts(duration)
 * console.log(components)
 * // {
 * //   days: 1,
 * //   hours: 2,
 * //   minutes: 30,
 * //   seconds: 45,
 * //   millis: 123,
 * //   nanos: 0
 * // }
 *
 * const complex = Duration.sum(Duration.hours(25), Duration.minutes(90))
 * const complexParts = Duration.parts(complex)
 * console.log(complexParts)
 * // {
 * //   days: 1,
 * //   hours: 2,
 * //   minutes: 30,
 * //   seconds: 0,
 * //   millis: 0,
 * //   nanos: 0
 * // }
 * ```
 *
 * @since 3.8.0
 * @category conversions
 */
export const parts = (self: Duration): {
  days: number
  hours: number
  minutes: number
  seconds: number
  millis: number
  nanos: number
} => {
  if (self.value._tag === "Infinity") {
    return {
      days: Infinity,
      hours: Infinity,
      minutes: Infinity,
      seconds: Infinity,
      millis: Infinity,
      nanos: Infinity
    }
  }
  if (self.value._tag === "NegativeInfinity") {
    return {
      days: -Infinity,
      hours: -Infinity,
      minutes: -Infinity,
      seconds: -Infinity,
      millis: -Infinity,
      nanos: -Infinity
    }
  }

  const n = toNanosUnsafe(self)
  const neg = n < bigint0
  const a = neg ? -n : n
  const ms = a / bigint1e6
  const sec = ms / bigint1e3
  const min = sec / bigint60
  const hr = min / bigint60
  const d = hr / bigint24
  const sign = neg ? -1 : 1

  return {
    days: sign * Number(d),
    hours: sign * Number(hr % bigint24),
    minutes: sign * Number(min % bigint60),
    seconds: sign * Number(sec % bigint60),
    millis: sign * Number(ms % bigint1e3),
    nanos: sign * Number(a % bigint1e6)
  }
}

/**
 * Converts a `Duration` to a human readable string.
 *
 * @since 2.0.0
 * @category conversions
 * @example
 * ```ts
 * import { Duration } from "effect"
 *
 * Duration.format(Duration.millis(1000)) // "1s"
 * Duration.format(Duration.millis(1001)) // "1s 1ms"
 * ```
 */
export const format = (self: Duration): string => {
  if (self.value._tag === "Infinity") {
    return "Infinity"
  }
  if (self.value._tag === "NegativeInfinity") {
    return "-Infinity"
  }
  if (isZero(self)) {
    return "0"
  }
  if (isNegative(self)) {
    return "-" + format(abs(self))
  }

  const fragments = parts(self)
  const pieces = []
  if (fragments.days !== 0) {
    pieces.push(`${fragments.days}d`)
  }

  if (fragments.hours !== 0) {
    pieces.push(`${fragments.hours}h`)
  }

  if (fragments.minutes !== 0) {
    pieces.push(`${fragments.minutes}m`)
  }

  if (fragments.seconds !== 0) {
    pieces.push(`${fragments.seconds}s`)
  }

  if (fragments.millis !== 0) {
    pieces.push(`${fragments.millis}ms`)
  }

  if (fragments.nanos !== 0) {
    pieces.push(`${fragments.nanos}ns`)
  }

  return pieces.join(" ")
}

/**
 * A `Reducer` for summing `Duration`s.
 *
 * @since 4.0.0
 */
export const ReducerSum: Reducer.Reducer<Duration> = Reducer.make(sum, zero)

/**
 * A `Combiner` that returns the maximum `Duration`.
 *
 * @since 4.0.0
 */
export const CombinerMax: Combiner.Combiner<Duration> = Combiner.max(Order)

/**
 * A `Combiner` that returns the minimum `Duration`.
 *
 * @since 4.0.0
 */
export const CombinerMin: Combiner.Combiner<Duration> = Combiner.min(Order)

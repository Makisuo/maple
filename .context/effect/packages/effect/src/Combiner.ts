/**
 * A module for combining two values of the same type into one.
 *
 * A `Combiner<A>` wraps a single binary function `(self: A, that: A) => A`.
 * It describes *how* two values merge but carries no initial/empty value
 * (for that, see {@link Reducer} which extends `Combiner` with an
 * `initialValue`).
 *
 * ## Mental model
 *
 * - **Combiner** – an object with a `combine(self, that)` method that returns
 *   a value of the same type.
 * - **Argument order** – `self` is the "left" / accumulator side, `that` is
 *   the "right" / incoming side.
 * - **No identity element** – unlike a monoid, a `Combiner` does not require
 *   a neutral element. Use {@link Reducer} when you need one.
 * - **Purity** – all combiners produced by this module are pure; they never
 *   mutate their arguments.
 * - **Composability** – combiners can be lifted into `Option`, `Struct`,
 *   `Tuple`, and other container types via helpers in those modules.
 *
 * ## Common tasks
 *
 * - Create a combiner from any binary function → {@link make}
 * - Swap argument order → {@link flip}
 * - Pick the smaller / larger of two values → {@link min} / {@link max}
 * - Always keep the first or last value → {@link first} / {@link last}
 * - Ignore both values and return a fixed result → {@link constant}
 * - Insert a separator between combined values → {@link intercalate}
 *
 * ## Gotchas
 *
 * - `min` and `max` require an `Order<A>`, not a raw comparator. Import from
 *   e.g. `Number.Order` or `String.Order`.
 * - `intercalate` is curried: call it with the separator first, then pass the
 *   base combiner.
 * - A `Reducer` (which adds `initialValue`) is also a valid `Combiner` — you
 *   can pass a `Reducer` anywhere a `Combiner` is expected.
 *
 * ## Quickstart
 *
 * **Example** (combining strings with a separator)
 *
 * ```ts
 * import { Combiner, String } from "effect"
 *
 * const csv = Combiner.intercalate(",")(String.ReducerConcat)
 *
 * console.log(csv.combine("a", "b"))
 * // Output: "a,b"
 *
 * console.log(csv.combine(csv.combine("a", "b"), "c"))
 * // Output: "a,b,c"
 * ```
 *
 * ## See also
 *
 * - {@link make} – the primary constructor
 * - {@link Combiner} – the core interface
 *
 * @since 4.0.0
 */
import type * as Order from "./Order.ts"

/**
 * Represents a strategy for combining two values of the same type `A`.
 *
 * A `Combiner` contains a single `combine` method that takes two values and
 * returns a merged result. It does not include an identity/empty value; use
 * `Reducer` when you need one.
 *
 * When to use:
 * - You need to describe how two values of the same type merge.
 * - You want to pass a reusable combining strategy to library functions like
 *   `Struct.makeCombiner` or `Option.makeCombinerFailFast`.
 * - You are building a `Reducer` and need to define the combining step first.
 *
 * **Example** (number addition combiner)
 *
 * ```ts
 * import { Combiner } from "effect"
 *
 * const Sum = Combiner.make<number>((self, that) => self + that)
 *
 * console.log(Sum.combine(3, 4))
 * // Output: 7
 * ```
 *
 * @see {@link make} – create a `Combiner` from a function
 *
 * @category model
 * @since 4.0.0
 */
export interface Combiner<A> {
  /**
   * Combines two values into a new value.
   */
  readonly combine: (self: A, that: A) => A
}

/**
 * Creates a `Combiner` from a binary function.
 *
 * When to use:
 * - You have a custom combining operation that is not covered by the built-in
 *   constructors (`min`, `max`, `first`, `last`, `constant`).
 *
 * Behavior:
 * - Returns a new `Combiner` whose `combine` method delegates to the provided
 *   function.
 * - Pure – the returned combiner does not mutate its arguments.
 *
 * **Example** (multiplying numbers)
 *
 * ```ts
 * import { Combiner } from "effect"
 *
 * const Product = Combiner.make<number>((self, that) => self * that)
 *
 * console.log(Product.combine(3, 5))
 * // Output: 15
 * ```
 *
 * @see {@link Combiner} – the interface this creates
 *
 * @since 4.0.0
 */
export function make<A>(combine: (self: A, that: A) => A): Combiner<A> {
  return { combine }
}

/**
 * Reverses the argument order of a combiner's `combine` method.
 *
 * When to use:
 * - You need the "right" value to act as the accumulator side.
 * - You want to reverse the natural direction of a non-commutative combiner
 *   (e.g. string concatenation).
 *
 * Behavior:
 * - Returns a new `Combiner` where `combine(self, that)` calls the original
 *   combiner as `combine(that, self)`.
 * - Does not mutate the input combiner.
 *
 * **Example** (reversing string concatenation)
 *
 * ```ts
 * import { Combiner, String } from "effect"
 *
 * const Prepend = Combiner.flip(String.ReducerConcat)
 *
 * console.log(Prepend.combine("a", "b"))
 * // Output: "ba"
 * ```
 *
 * @see {@link make}
 *
 * @since 4.0.0
 */
export function flip<A>(combiner: Combiner<A>): Combiner<A> {
  return make((self, that) => combiner.combine(that, self))
}

/**
 * Creates a `Combiner` that returns the smaller of two values according to
 * the provided `Order`.
 *
 * When to use:
 * - You want to accumulate the minimum value across a collection.
 * - You are building a `Reducer` that tracks the running minimum.
 *
 * Behavior:
 * - Compares using the given `Order`. When values are equal, returns `that`
 *   (the second argument).
 * - Pure – does not mutate either argument.
 *
 * **Example** (minimum of two numbers)
 *
 * ```ts
 * import { Combiner, Number } from "effect"
 *
 * const Min = Combiner.min(Number.Order)
 *
 * console.log(Min.combine(3, 1))
 * // Output: 1
 *
 * console.log(Min.combine(1, 3))
 * // Output: 1
 * ```
 *
 * @see {@link max}
 *
 * @since 4.0.0
 */
export function min<A>(order: Order.Order<A>): Combiner<A> {
  return make((self, that) => order(self, that) === -1 ? self : that)
}

/**
 * Creates a `Combiner` that returns the larger of two values according to
 * the provided `Order`.
 *
 * When to use:
 * - You want to accumulate the maximum value across a collection.
 * - You are building a `Reducer` that tracks the running maximum.
 *
 * Behavior:
 * - Compares using the given `Order`. When values are equal, returns `that`
 *   (the second argument).
 * - Pure – does not mutate either argument.
 *
 * **Example** (maximum of two numbers)
 *
 * ```ts
 * import { Combiner, Number } from "effect"
 *
 * const Max = Combiner.max(Number.Order)
 *
 * console.log(Max.combine(3, 1))
 * // Output: 3
 *
 * console.log(Max.combine(1, 3))
 * // Output: 3
 * ```
 *
 * @see {@link min}
 *
 * @since 4.0.0
 */
export function max<A>(order: Order.Order<A>): Combiner<A> {
  return make((self, that) => order(self, that) === 1 ? self : that)
}

/**
 * Creates a `Combiner` that always returns the first (left) argument.
 *
 * When to use:
 * - You want "first write wins" semantics when merging values.
 * - You need a combiner but the combining logic should be a no-op that keeps
 *   the existing value.
 *
 * Behavior:
 * - `combine(self, that)` returns `self`, ignoring `that`.
 * - Pure – the second argument is discarded, not mutated.
 *
 * **Example** (keeping the first value)
 *
 * ```ts
 * import { Combiner } from "effect"
 *
 * const First = Combiner.first<number>()
 *
 * console.log(First.combine(1, 2))
 * // Output: 1
 * ```
 *
 * @see {@link last}
 *
 * @since 4.0.0
 */
export function first<A>(): Combiner<A> {
  return make((self, _) => self)
}

/**
 * Creates a `Combiner` that always returns the last (right) argument.
 *
 * When to use:
 * - You want "last write wins" semantics when merging values.
 * - You need a combiner that replaces the accumulator with each new value.
 *
 * Behavior:
 * - `combine(self, that)` returns `that`, ignoring `self`.
 * - Pure – the first argument is discarded, not mutated.
 *
 * **Example** (keeping the last value)
 *
 * ```ts
 * import { Combiner } from "effect"
 *
 * const Last = Combiner.last<number>()
 *
 * console.log(Last.combine(1, 2))
 * // Output: 2
 * ```
 *
 * @see {@link first}
 *
 * @since 4.0.0
 */
export function last<A>(): Combiner<A> {
  return make((_, that) => that)
}

/**
 * Creates a `Combiner` that ignores both arguments and always returns the
 * given constant value.
 *
 * When to use:
 * - You need a combiner that produces a fixed result regardless of input.
 * - You are providing a combiner to a generic API but the combined value is
 *   predetermined.
 *
 * Behavior:
 * - `combine(self, that)` returns the constant `a`, ignoring both arguments.
 * - Pure – no mutation occurs.
 *
 * **Example** (always returning zero)
 *
 * ```ts
 * import { Combiner } from "effect"
 *
 * const Zero = Combiner.constant(0)
 *
 * console.log(Zero.combine(42, 99))
 * // Output: 0
 * ```
 *
 * @see {@link first}
 * @see {@link last}
 *
 * @since 4.0.0
 */
export function constant<A>(a: A): Combiner<A> {
  return make(() => a)
}

/**
 * Wraps a `Combiner` so that a separator value is inserted between every
 * pair of combined elements.
 *
 * When to use:
 * - You are building delimited strings (CSV, paths, etc.) by repeated
 *   combination.
 * - You need to inject a fixed separator between accumulated values.
 *
 * Behavior:
 * - `intercalate(middle)(combiner).combine(self, that)` is equivalent to
 *   `combiner.combine(self, combiner.combine(middle, that))`.
 * - Curried: first provide the separator, then the base combiner.
 * - Does not mutate the input combiner; returns a new one.
 *
 * **Example** (joining strings with a separator)
 *
 * ```ts
 * import { Combiner, String } from "effect"
 *
 * const commaSep = Combiner.intercalate(",")(String.ReducerConcat)
 *
 * console.log(commaSep.combine("a", "b"))
 * // Output: "a,b"
 * ```
 *
 * @see {@link make}
 *
 * @since 4.0.0
 */
export function intercalate<A>(middle: A) {
  return (combiner: Combiner<A>): Combiner<A> =>
    make((self, that) => combiner.combine(self, combiner.combine(middle, that)))
}

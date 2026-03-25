/**
 * This module provides the `Order` type class for defining total orderings on types.
 * An `Order` is a comparison function that returns `-1` (less than), `0` (equal), or `1` (greater than).
 *
 * Mental model:
 * - An `Order<A>` is a pure function `(a: A, b: A) => Ordering` that compares two values
 * - The result `-1` means the first value is less than the second
 * - The result `0` means the values are equal according to this ordering
 * - The result `1` means the first value is greater than the second
 * - Orders must satisfy total ordering laws: totality (either `x <= y` or `y <= x`), antisymmetry (if `x <= y` and `y <= x` then `x == y`), and transitivity (if `x <= y` and `y <= z` then `x <= z`)
 * - Orders can be composed using {@link combine} and {@link combineAll} to create multi-criteria comparisons
 * - Orders can be transformed using {@link mapInput} to compare values by extracting a comparable property
 * - Built-in orders exist for common types: {@link Number}, {@link String}, {@link Boolean}, {@link BigInt}, {@link Date}
 *
 * Common tasks:
 * - Creating custom orders → {@link make}
 * - Using built-in orders → {@link Number}, {@link String}, {@link Boolean}, {@link BigInt}, {@link Date}
 * - Combining multiple orders → {@link combine}, {@link combineAll}
 * - Transforming orders → {@link mapInput}
 * - Comparing values → {@link isLessThan}, {@link isGreaterThan}, {@link isLessThanOrEqualTo}, {@link isGreaterThanOrEqualTo}
 * - Finding min/max → {@link min}, {@link max}
 * - Clamping values → {@link clamp}, {@link isBetween}
 * - Ordering collections → {@link Array}, {@link Tuple}, {@link Struct}
 *
 * Gotchas:
 * - `Order.Number` treats all `NaN` values as equal and less than any other number
 * - `Order.make` uses reference equality (`===`) as a shortcut: if `self === that`, it returns `0` without calling the comparison function
 * - `Order.Array` compares arrays element-by-element, then by length if all elements are equal; `Order.all` only compares elements up to the shorter array's length
 * - `Order.Tuple` requires a fixed-length tuple with matching order types; `Order.Array` works with variable-length arrays
 * - `Order.min` and `Order.max` return the first argument when values are equal
 *
 * Quickstart:
 *
 * **Example** (Basic Usage)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const result = Order.Number(5, 10)
 * console.log(result) // -1 (5 is less than 10)
 *
 * const isLessThan = Order.isLessThan(Order.Number)(5, 10)
 * console.log(isLessThan) // true
 * ```
 *
 * See also:
 * - {@link Ordering} - The result type of comparisons
 * - {@link Reducer} - For combining orders in collections
 *
 * @since 2.0.0
 */
import { dual } from "./Function.ts"
import type { TypeLambda } from "./HKT.ts"
import type { Ordering } from "./Ordering.ts"
import * as Reducer from "./Reducer.ts"

/**
 * Represents a total ordering for values of type `A`.
 *
 * When to use this:
 * - When you need to define how values of a type should be compared
 * - When implementing sorting, searching, or ordered data structures
 * - When composing multiple comparison criteria
 *
 * Behavior:
 * - Pure function: does not mutate inputs or have side effects
 * - Returns `-1` if the first value is less than the second
 * - Returns `0` if the values are equal according to this ordering
 * - Returns `1` if the first value is greater than the second
 * - Must satisfy total ordering laws (totality, antisymmetry, transitivity)
 *
 * **Example** (Custom Order)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const byAge: Order.Order<{ name: string; age: number }> = (self, that) => {
 *   if (self.age < that.age) return -1
 *   if (self.age > that.age) return 1
 *   return 0
 * }
 *
 * const person1 = { name: "Alice", age: 30 }
 * const person2 = { name: "Bob", age: 25 }
 * console.log(byAge(person1, person2)) // 1
 * ```
 *
 * See also:
 * - {@link make} - Create an order from a comparison function
 * - {@link Ordering} - The result type of comparisons
 *
 * @category type class
 * @since 2.0.0
 */
export interface Order<in A> {
  (self: A, that: A): Ordering
}

/**
 * Type lambda for the `Order` type class, used internally for higher-kinded type operations.
 *
 * When to use this:
 * - When working with type-level operations that require higher-kinded types
 * - When implementing generic type classes that work with orders
 *
 * Behavior:
 * - Type-level only: no runtime representation
 * - Used internally by the Effect type system
 *
 * @category type lambdas
 * @since 2.0.0
 */
export interface OrderTypeLambda extends TypeLambda {
  readonly type: Order<this["Target"]>
}

/**
 * Creates a new `Order` instance from a comparison function.
 *
 * When to use this:
 * - When creating a custom order for a type that doesn't have a built-in order
 * - When you need fine-grained control over comparison logic
 * - When implementing orders for complex types
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Uses reference equality (`===`) as a shortcut: if `self === that`, returns `0` without calling the comparison function
 * - The comparison function should return `-1`, `0`, or `1` based on the comparison result
 * - The returned order satisfies total ordering laws if the comparison function does
 *
 * **Example** (Creating an Order)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const byAge = Order.make<{ name: string; age: number }>((self, that) => {
 *   if (self.age < that.age) return -1
 *   if (self.age > that.age) return 1
 *   return 0
 * })
 *
 * console.log(byAge({ name: "Alice", age: 30 }, { name: "Bob", age: 25 })) // 1
 * console.log(byAge({ name: "Alice", age: 25 }, { name: "Bob", age: 30 })) // -1
 * ```
 *
 * See also:
 * - {@link mapInput} - Transform an order by mapping the input type
 * - {@link combine} - Combine multiple orders
 *
 * @category constructors
 * @since 2.0.0
 */
export function make<A>(
  compare: (self: A, that: A) => -1 | 0 | 1
): Order<A> {
  return (self, that) => self === that ? 0 : compare(self, that)
}

/**
 * An `Order` instance for strings that compares them lexicographically using JavaScript's `<` operator.
 *
 * When to use this:
 * - When comparing strings alphabetically
 * - When sorting string collections
 * - As a base for creating orders on types containing strings
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Uses lexicographic (dictionary) ordering
 * - Empty string is less than any non-empty string
 * - Comparison is case-sensitive
 *
 * **Example** (String Ordering)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * console.log(Order.String("apple", "banana")) // -1
 * console.log(Order.String("banana", "apple")) // 1
 * console.log(Order.String("apple", "apple")) // 0
 * ```
 *
 * See also:
 * - {@link mapInput} - Use this order to compare objects by a string property
 * - {@link Struct} - Combine with other orders for struct comparison
 *
 * @category instances
 * @since 4.0.0
 */
export const String: Order<string> = make((self, that) => self < that ? -1 : 1)

/**
 * An `Order` instance for numbers that compares them numerically.
 *
 * When to use this:
 * - When comparing numbers for sorting or searching
 * - As a base for creating orders on types containing numbers
 * - When implementing numeric comparisons in data structures
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - `0` is considered equal to `-0`
 * - All `NaN` values are considered equal to each other
 * - Any `NaN` is considered less than any non-NaN number
 * - Uses standard numeric comparison for all other values
 *
 * **Example** (Number Ordering)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * console.log(Order.Number(1, 1)) // 0
 * console.log(Order.Number(1, 2)) // -1
 * console.log(Order.Number(2, 1)) // 1
 *
 * console.log(Order.Number(0, -0)) // 0
 * console.log(Order.Number(NaN, 1)) // -1
 * ```
 *
 * See also:
 * - {@link mapInput} - Use this order to compare objects by a number property
 * - {@link BigInt} - For bigint comparisons
 *
 * @category instances
 * @since 4.0.0
 */
export const Number: Order<number> = make((self, that) => {
  if (globalThis.Number.isNaN(self) && globalThis.Number.isNaN(that)) return 0
  if (globalThis.Number.isNaN(self)) return -1 // NaN < any number
  if (globalThis.Number.isNaN(that)) return 1 // any number > NaN
  return self < that ? -1 : 1
})

/**
 * An `Order` instance for booleans where `false` is considered less than `true`.
 *
 * When to use this:
 * - When comparing booleans for sorting or searching
 * - As a base for creating orders on types containing booleans
 * - When implementing boolean-based comparisons
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - `false` is less than `true`
 * - Equal values return `0`
 *
 * **Example** (Boolean Ordering)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * console.log(Order.Boolean(false, true)) // -1
 * console.log(Order.Boolean(true, false)) // 1
 * console.log(Order.Boolean(true, true)) // 0
 * ```
 *
 * See also:
 * - {@link mapInput} - Use this order to compare objects by a boolean property
 *
 * @category instances
 * @since 4.0.0
 */
export const Boolean: Order<boolean> = make((self, that) => self < that ? -1 : 1)

/**
 * An `Order` instance for bigints that compares them numerically.
 *
 * When to use this:
 * - When comparing bigint values for sorting or searching
 * - As a base for creating orders on types containing bigints
 * - When working with large integers that exceed number precision
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Uses standard numeric comparison for bigint values
 * - Handles arbitrarily large integers
 *
 * **Example** (BigInt Ordering)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * console.log(Order.BigInt(1n, 2n)) // -1
 * console.log(Order.BigInt(2n, 1n)) // 1
 * console.log(Order.BigInt(1n, 1n)) // 0
 * ```
 *
 * See also:
 * - {@link Number} - For regular number comparisons
 * - {@link mapInput} - Use this order to compare objects by a bigint property
 *
 * @category instances
 * @since 4.0.0
 */
export const BigInt: Order<bigint> = make((self, that) => self < that ? -1 : 1)

/**
 * Creates a new `Order` that reverses the comparison order of the input `Order`.
 *
 * When to use this:
 * - When you need descending order instead of ascending
 * - When reversing an existing order without modifying the original
 * - When creating orders that compare in the opposite direction
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Returns a new order that swaps the arguments before comparison
 * - If the original order returns `-1`, the flipped order returns `1`, and vice versa
 * - Equal comparisons remain `0`
 *
 * **Example** (Reversing Order)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const flip = Order.flip(Order.Number)
 *
 * console.log(flip(1, 2)) // 1
 * console.log(flip(2, 1)) // -1
 * console.log(flip(1, 1)) // 0
 * ```
 *
 * See also:
 * - {@link combine} - Combine orders for multi-criteria comparison
 *
 * @category combinators
 * @since 2.0.0
 */
export function flip<A>(O: Order<A>): Order<A> {
  return make((self, that) => O(that, self))
}

/**
 * Combines two `Order` instances to create a new `Order` that first compares using the first `Order`,
 * and if the values are equal, then compares using the second `Order`.
 *
 * When to use this:
 * - When you need multi-criteria comparison (e.g., sort by age, then by name)
 * - When creating composite orders from simpler orders
 * - When implementing lexicographic ordering
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - First applies the first order; if the result is non-zero, returns that result
 * - If the first order returns `0` (equal), applies the second order
 * - Returns the first non-zero result, or `0` if both orders return `0`
 *
 * **Example** (Combining Orders)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const byAge = Order.mapInput(
 *   Order.Number,
 *   (person: { name: string; age: number }) => person.age
 * )
 * const byName = Order.mapInput(
 *   Order.String,
 *   (person: { name: string; age: number }) => person.name
 * )
 * const byAgeAndName = Order.combine(byAge, byName)
 *
 * const person1 = { name: "Alice", age: 30 }
 * const person2 = { name: "Bob", age: 30 }
 * const person3 = { name: "Charlie", age: 25 }
 *
 * console.log(byAgeAndName(person1, person2)) // -1 (Same age, Alice < Bob)
 * console.log(byAgeAndName(person1, person3)) // 1 (Alice (30) > Charlie (25))
 * ```
 *
 * See also:
 * - {@link combineAll} - Combine multiple orders from a collection
 * - {@link mapInput} - Transform orders to work with different types
 *
 * @category combining
 * @since 2.0.0
 */
export const combine: {
  <A>(that: Order<A>): (self: Order<A>) => Order<A>
  <A>(self: Order<A>, that: Order<A>): Order<A>
} = dual(2, <A>(self: Order<A>, that: Order<A>): Order<A> =>
  make((a1, a2) => {
    const out = self(a1, a2)
    if (out !== 0) {
      return out
    }
    return that(a1, a2)
  }))

/**
 * Creates an `Order` that considers all values as equal.
 *
 * When to use this:
 * - When you need an order that doesn't distinguish between values
 * - As a default or fallback order when no meaningful comparison exists
 * - When implementing optional ordering where equality is sufficient
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Always returns `0` regardless of input values
 * - Useful as a neutral element in order composition
 *
 * **Example** (Always Equal Order)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const alwaysEqualOrder = Order.alwaysEqual<number>()
 *
 * console.log(alwaysEqualOrder(1, 2)) // 0
 * console.log(alwaysEqualOrder(2, 1)) // 0
 * console.log(alwaysEqualOrder(1, 1)) // 0
 * ```
 *
 * See also:
 * - {@link combine} - Combine with other orders
 *
 * @category constructors
 * @since 4.0.0
 */
export function alwaysEqual<A>(): Order<A> {
  return make(() => 0)
}

/**
 * Combines all `Order` instances in the provided collection into a single `Order`.
 * The resulting `Order` compares using each `Order` in sequence until a non-zero result is found.
 *
 * When to use this:
 * - When you have a variable number of orders to combine
 * - When combining orders from a collection or array
 * - When implementing dynamic multi-criteria sorting
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Applies orders in iteration order
 * - Returns the first non-zero result from any order
 * - Returns `0` only if all orders return `0`
 * - Short-circuits on the first non-zero result
 *
 * **Example** (Combining Multiple Orders)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const byAge = Order.mapInput(
 *   Order.Number,
 *   (person: { name: string; age: number }) => person.age
 * )
 * const byName = Order.mapInput(
 *   Order.String,
 *   (person: { name: string; age: number }) => person.name
 * )
 *
 * const combinedOrder = Order.combineAll([byAge, byName])
 *
 * const person1 = { name: "Alice", age: 30 }
 * const person2 = { name: "Bob", age: 30 }
 *
 * console.log(combinedOrder(person1, person2)) // -1 (Same age, Alice < Bob)
 * ```
 *
 * See also:
 * - {@link combine} - Combine two orders
 * - {@link makeReducer} - Create a reducer for combining orders
 *
 * @category combining
 * @since 2.0.0
 */
export function combineAll<A>(collection: Iterable<Order<A>>): Order<A> {
  return make((a1, a2) => {
    let out: Ordering = 0
    for (const O of collection) {
      out = O(a1, a2)
      if (out !== 0) {
        return out
      }
    }
    return out
  })
}

/**
 * Transforms an `Order` on type `A` into an `Order` on type `B` by providing a function that
 * maps values of type `B` to values of type `A`.
 *
 * When to use this:
 * - When you have an order for a property type and want to compare objects by that property
 * - When extracting a comparable value from a complex type
 * - When creating orders for types that contain comparable values
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Applies the mapping function to both values before comparison
 * - The mapping function should be pure and not have side effects
 * - Preserves the ordering properties of the original order
 *
 * **Example** (Mapping Input)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const byLength = Order.mapInput(Order.Number, (s: string) => s.length)
 *
 * console.log(byLength("a", "bb")) // -1
 * console.log(byLength("bb", "a")) // 1
 * console.log(byLength("aa", "bb")) // 0
 * ```
 *
 * See also:
 * - {@link combine} - Combine mapped orders for multi-criteria comparison
 * - {@link Struct} - Create orders for structs with multiple fields
 *
 * @category mapping
 * @since 2.0.0
 */
export const mapInput: {
  <B, A>(f: (b: B) => A): (self: Order<A>) => Order<B>
  <A, B>(self: Order<A>, f: (b: B) => A): Order<B>
} = dual(
  2,
  <A, B>(self: Order<A>, f: (b: B) => A): Order<B> => make((b1, b2) => self(f(b1), f(b2)))
)

/**
 * An `Order` instance for `Date` objects that compares them chronologically by their timestamp.
 *
 * When to use this:
 * - When comparing dates for sorting or searching
 * - As a base for creating orders on types containing dates
 * - When implementing time-based comparisons
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Compares dates by their underlying timestamp (milliseconds since epoch)
 * - Earlier dates are less than later dates
 * - Invalid dates are compared as if they were valid (uses `getTime()` result)
 *
 * **Example** (Date Ordering)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const date1 = new Date("2023-01-01")
 * const date2 = new Date("2023-01-02")
 *
 * console.log(Order.Date(date1, date2)) // -1
 * console.log(Order.Date(date2, date1)) // 1
 * console.log(Order.Date(date1, date1)) // 0
 * ```
 *
 * See also:
 * - {@link mapInput} - Use this order to compare objects by a date property
 *
 * @category instances
 * @since 2.0.0
 */
export const Date: Order<Date> = mapInput(Number, (date) => date.getTime())

/**
 * Creates an `Order` for a tuple type based on orders for each element.
 *
 * When to use this:
 * - When comparing tuples with different types for each position
 * - When you need type-safe tuple ordering
 * - When working with fixed-length heterogeneous collections
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Compares tuples element-by-element using the corresponding order
 * - Stops at the first non-zero comparison result
 * - Requires tuples to have the same length as the order collection
 * - Returns `0` if all elements are equal
 *
 * **Example** (Tuple Ordering)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const tupleOrder = Order.Tuple([Order.Number, Order.String])
 *
 * console.log(tupleOrder([1, "a"], [2, "b"])) // -1
 * console.log(tupleOrder([1, "b"], [1, "a"])) // 1
 * console.log(tupleOrder([1, "a"], [1, "a"])) // 0
 * ```
 *
 * See also:
 * - {@link Array} - Compare arrays with length consideration
 *
 * @category combinators
 * @since 4.0.0
 */
export function Tuple<const Elements extends ReadonlyArray<Order<any>>>(
  elements: Elements
): Order<{ readonly [I in keyof Elements]: [Elements[I]] extends [Order<infer A>] ? A : never }> {
  return make((self, that) => {
    const len = elements.length
    for (let i = 0; i < len; i++) {
      const o = elements[i](self[i], that[i])
      if (o !== 0) {
        return o
      }
    }
    return 0
  })
}

/**
 * @since 4.0.0
 */
function Array_<A>(O: Order<A>): Order<ReadonlyArray<A>> {
  return make((self, that) => {
    const aLen = self.length
    const bLen = that.length
    const len = Math.min(aLen, bLen)
    for (let i = 0; i < len; i++) {
      const o = O(self[i], that[i])
      if (o !== 0) {
        return o
      }
    }
    return Number(aLen, bLen)
  })
}

export {
  /**
   * Creates an `Order` for arrays by applying the given `Order` to each element, then comparing by length if all elements are equal.
   *
   * When to use this:
   * - When comparing arrays of the same element type
   * - When you want shorter arrays to be considered less than longer arrays
   * - When sorting collections of arrays
   *
   * Behavior:
   * - Pure function: does not mutate inputs
   * - Compares arrays element-by-element using the provided order
   * - Stops at the first non-zero comparison result
   * - If all elements are equal, shorter arrays are less than longer arrays
   * - Returns `0` only if arrays have the same length and all elements are equal
   *
   * **Example** (Array Element Ordering)
   *
   * ```ts
   * import { Order } from "effect"
   *
   * const arrayOrder = Order.Array(Order.Number)
   *
   * console.log(arrayOrder([1, 2], [1, 3])) // -1
   * console.log(arrayOrder([1, 2], [1, 2, 3])) // -1 (shorter array is less)
   * console.log(arrayOrder([1, 2, 3], [1, 2])) // 1 (longer array is greater)
   * console.log(arrayOrder([1, 2], [1, 2])) // 0
   * ```
   *
   * See also:
   * - {@link Tuple} - Type-safe tuple ordering
   *
   * @category combinators
   * @since 4.0.0
   */
  Array_ as Array
}

/**
 * Creates an `Order` for structs by applying the given `Order`s to each property in sequence.
 *
 * When to use this:
 * - When comparing objects with multiple properties
 * - When you need multi-field comparison for structs
 * - When creating orders for complex data types
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Compares structs field-by-field in the order of keys in the fields object
 * - Stops at the first non-zero comparison result
 * - Returns `0` only if all fields are equal
 * - Field order matters: earlier fields take precedence
 *
 * **Example** (Struct Ordering)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const personOrder = Order.Struct({
 *   name: Order.String,
 *   age: Order.Number
 * })
 *
 * const person1 = { name: "Alice", age: 30 }
 * const person2 = { name: "Bob", age: 25 }
 * const person3 = { name: "Alice", age: 25 }
 *
 * console.log(personOrder(person1, person2)) // -1 (Alice < Bob)
 * console.log(personOrder(person1, person3)) // 1 (same name, 30 > 25)
 * console.log(personOrder(person1, person1)) // 0
 * ```
 *
 * See also:
 * - {@link combine} - Combine orders manually
 * - {@link mapInput} - Extract and compare by a single property
 *
 * @category combinators
 * @since 4.0.0
 */
export function Struct<const R extends { readonly [x: string]: Order<any> }>(
  fields: R
): Order<{ [K in keyof R]: [R[K]] extends [Order<infer A>] ? A : never }> {
  const keys = Object.keys(fields)
  return make((self, that) => {
    for (const key of keys) {
      const o = fields[key](self[key], that[key])
      if (o !== 0) {
        return o
      }
    }
    return 0
  })
}

/**
 * Tests whether one value is strictly less than another according to the given order.
 *
 * When to use this:
 * - When you need a boolean predicate instead of an ordering result
 * - When checking if a value is less than another in conditional logic
 * - When implementing range checks or comparisons
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Returns `true` if the order returns `-1` (first value is less than second)
 * - Returns `false` for equal or greater values
 * - Supports curried and uncurried call styles
 *
 * **Example** (Less Than)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const isLessThanNumber = Order.isLessThan(Order.Number)
 *
 * console.log(isLessThanNumber(1, 2)) // true
 * console.log(isLessThanNumber(2, 1)) // false
 * console.log(isLessThanNumber(1, 1)) // false
 * ```
 *
 * See also:
 * - {@link isLessThanOrEqualTo} - Non-strict less than or equal
 * - {@link isGreaterThan} - Strict greater than
 *
 * @category predicates
 * @since 2.0.0
 */
export const isLessThan = <A>(O: Order<A>): {
  (that: A): (self: A) => boolean
  (self: A, that: A): boolean
} => dual(2, (self: A, that: A) => O(self, that) === -1)

/**
 * Tests whether one value is strictly greater than another according to the given order.
 *
 * When to use this:
 * - When you need a boolean predicate instead of an ordering result
 * - When checking if a value is greater than another in conditional logic
 * - When implementing range checks or comparisons
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Returns `true` if the order returns `1` (first value is greater than second)
 * - Returns `false` for equal or lesser values
 * - Supports curried and uncurried call styles
 *
 * **Example** (Greater Than)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const isGreaterThanNumber = Order.isGreaterThan(Order.Number)
 *
 * console.log(isGreaterThanNumber(2, 1)) // true
 * console.log(isGreaterThanNumber(1, 2)) // false
 * console.log(isGreaterThanNumber(1, 1)) // false
 * ```
 *
 * See also:
 * - {@link isGreaterThanOrEqualTo} - Non-strict greater than or equal
 * - {@link isLessThan} - Strict less than
 *
 * @category predicates
 * @since 2.0.0
 */
export const isGreaterThan = <A>(O: Order<A>): {
  (that: A): (self: A) => boolean
  (self: A, that: A): boolean
} => dual(2, (self: A, that: A) => O(self, that) === 1)

/**
 * Tests whether one value is less than or equal to another according to the given order.
 *
 * When to use this:
 * - When you need a boolean predicate for non-strict comparison
 * - When checking if a value is within a range (inclusive lower bound)
 * - When implementing inclusive comparisons
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Returns `true` if the order returns `-1` or `0` (less than or equal)
 * - Returns `false` only if the order returns `1` (greater than)
 * - Supports curried and uncurried call styles
 *
 * **Example** (Less Than Or Equal)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const isLessThanOrEqualToNumber = Order.isLessThanOrEqualTo(Order.Number)
 *
 * console.log(isLessThanOrEqualToNumber(1, 2)) // true
 * console.log(isLessThanOrEqualToNumber(1, 1)) // true
 * console.log(isLessThanOrEqualToNumber(2, 1)) // false
 * ```
 *
 * See also:
 * - {@link isLessThan} - Strict less than
 * - {@link isGreaterThan} - Strict greater than
 *
 * @category predicates
 * @since 2.0.0
 */
export const isLessThanOrEqualTo = <A>(O: Order<A>): {
  (that: A): (self: A) => boolean
  (self: A, that: A): boolean
} => dual(2, (self: A, that: A) => O(self, that) !== 1)

/**
 * Tests whether one value is greater than or equal to another according to the given order.
 *
 * When to use this:
 * - When you need a boolean predicate for non-strict comparison
 * - When checking if a value is within a range (inclusive upper bound)
 * - When implementing inclusive comparisons
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Returns `true` if the order returns `1` or `0` (greater than or equal)
 * - Returns `false` only if the order returns `-1` (less than)
 * - Supports curried and uncurried call styles
 *
 * **Example** (Greater Than Or Equal)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const isGreaterThanOrEqualToNumber = Order.isGreaterThanOrEqualTo(Order.Number)
 *
 * console.log(isGreaterThanOrEqualToNumber(2, 1)) // true
 * console.log(isGreaterThanOrEqualToNumber(1, 1)) // true
 * console.log(isGreaterThanOrEqualToNumber(1, 2)) // false
 * ```
 *
 * See also:
 * - {@link isGreaterThan} - Strict greater than
 * - {@link isLessThanOrEqualTo} - Less than or equal
 *
 * @category predicates
 * @since 2.0.0
 */
export const isGreaterThanOrEqualTo = <A>(O: Order<A>): {
  (that: A): (self: A) => boolean
  (self: A, that: A): boolean
} => dual(2, (self: A, that: A) => O(self, that) !== -1)

/**
 * Returns the minimum of two values according to the given order. If they are equal, returns the first argument.
 *
 * When to use this:
 * - When you need to find the smaller of two values
 * - When implementing min/max operations
 * - When selecting values based on ordering
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Returns the value that compares as less than or equal to the other
 * - If values are equal, returns the first argument
 * - Supports curried and uncurried call styles
 *
 * **Example** (Minimum Value)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const minNumber = Order.min(Order.Number)
 *
 * console.log(minNumber(1, 2)) // 1
 * console.log(minNumber(2, 1)) // 1
 * console.log(minNumber(1, 1)) // 1
 * ```
 *
 * See also:
 * - {@link max} - Maximum of two values
 * - {@link clamp} - Clamp a value between min and max
 *
 * @category comparisons
 * @since 2.0.0
 */
export const min = <A>(O: Order<A>): {
  (that: A): (self: A) => A
  (self: A, that: A): A
} => dual(2, (self: A, that: A) => self === that || O(self, that) < 1 ? self : that)

/**
 * Returns the maximum of two values according to the given order. If they are equal, returns the first argument.
 *
 * When to use this:
 * - When you need to find the larger of two values
 * - When implementing min/max operations
 * - When selecting values based on ordering
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Returns the value that compares as greater than or equal to the other
 * - If values are equal, returns the first argument
 * - Supports curried and uncurried call styles
 *
 * **Example** (Maximum Value)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const maxNumber = Order.max(Order.Number)
 *
 * console.log(maxNumber(1, 2)) // 2
 * console.log(maxNumber(2, 1)) // 2
 * console.log(maxNumber(1, 1)) // 1
 * ```
 *
 * See also:
 * - {@link min} - Minimum of two values
 * - {@link clamp} - Clamp a value between min and max
 *
 * @category comparisons
 * @since 2.0.0
 */
export const max = <A>(O: Order<A>): {
  (that: A): (self: A) => A
  (self: A, that: A): A
} => dual(2, (self: A, that: A) => self === that || O(self, that) > -1 ? self : that)

/**
 * Clamps a value between a minimum and a maximum according to the given order.
 *
 * When to use this:
 * - When you need to restrict a value to a specific range
 * - When implementing bounds checking and normalization
 * - When ensuring values stay within valid ranges
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Returns the value if it's between minimum and maximum (inclusive)
 * - Returns minimum if the value is less than minimum
 * - Returns maximum if the value is greater than maximum
 * - Supports curried and uncurried call styles
 * - Requires that minimum <= maximum according to the order
 *
 * **Example** (Clamping Values)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const clamp = Order.clamp(Order.Number)({ minimum: 1, maximum: 5 })
 *
 * console.log(clamp(3)) // 3
 * console.log(clamp(0)) // 1
 * console.log(clamp(6)) // 5
 * ```
 *
 * See also:
 * - {@link min} - Minimum of two values
 * - {@link max} - Maximum of two values
 * - {@link isBetween} - Check if a value is within a range
 *
 * @category comparisons
 * @since 2.0.0
 */
export const clamp = <A>(O: Order<A>): {
  (options: {
    minimum: A
    maximum: A
  }): (self: A) => A
  (self: A, options: {
    minimum: A
    maximum: A
  }): A
} =>
  dual(
    2,
    (self: A, options: {
      minimum: A
      maximum: A
    }): A => min(O)(options.maximum, max(O)(options.minimum, self))
  )

/**
 * Tests whether a value is between a minimum and a maximum (inclusive) according to the given order.
 *
 * When to use this:
 * - When validating that a value is within a valid range
 * - When implementing range checks for bounds validation
 * - When filtering or selecting values within a range
 *
 * Behavior:
 * - Pure function: does not mutate inputs
 * - Returns `true` if the value is greater than or equal to minimum and less than or equal to maximum
 * - Returns `false` if the value is outside the range
 * - Supports curried and uncurried call styles
 * - Both bounds are inclusive
 *
 * **Example** (Checking Range)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const betweenNumber = Order.isBetween(Order.Number)
 *
 * console.log(betweenNumber(5, { minimum: 1, maximum: 10 })) // true
 * console.log(betweenNumber(1, { minimum: 1, maximum: 10 })) // true
 * console.log(betweenNumber(10, { minimum: 1, maximum: 10 })) // true
 * console.log(betweenNumber(0, { minimum: 1, maximum: 10 })) // false
 * console.log(betweenNumber(11, { minimum: 1, maximum: 10 })) // false
 * ```
 *
 * See also:
 * - {@link clamp} - Clamp a value to a range
 * - {@link isLessThanOrEqualTo} - Less than or equal check
 * - {@link isGreaterThanOrEqualTo} - Greater than or equal check
 *
 * @category predicates
 * @since 4.0.0
 */
export const isBetween = <A>(O: Order<A>): {
  (options: {
    minimum: A
    maximum: A
  }): (self: A) => boolean
  (self: A, options: {
    minimum: A
    maximum: A
  }): boolean
} =>
  dual(
    2,
    (self: A, options: {
      minimum: A
      maximum: A
    }): boolean => !isLessThan(O)(self, options.minimum) && !isGreaterThan(O)(self, options.maximum)
  )

/**
 * Creates a `Reducer` for combining `Order` instances, useful for aggregating orders in collections.
 *
 * When to use this:
 * - When you need to combine multiple orders from a collection using reducer patterns
 * - When implementing fold operations over collections of orders
 * - When working with reducers that operate on orders
 *
 * Behavior:
 * - Returns a reducer that combines orders using {@link combine}
 * - Uses {@link alwaysEqual} as the identity element (returns `0` for empty collections)
 * - Uses {@link combineAll} for combining collections of orders
 * - The reducer can be used with fold operations on collections
 *
 * **Example** (Creating a Reducer)
 *
 * ```ts
 * import { Order } from "effect"
 *
 * const reducer = Order.makeReducer<number>()
 * const orders = [Order.Number, Order.flip(Order.Number)]
 *
 * const combined = reducer.combineAll(orders)
 * console.log(combined(1, 2)) // -1 (uses first order)
 * ```
 *
 * See also:
 * - {@link combine} - Combine two orders
 * - {@link combineAll} - Combine multiple orders
 * - {@link Reducer} - Reducer type for collection operations
 *
 * @category utilities
 * @since 4.0.0
 */
export function makeReducer<A>() {
  return Reducer.make<Order<A>>(
    combine,
    () => 0,
    combineAll
  )
}

/**
 * Utilities for creating, accessing, transforming, and comparing fixed-length
 * arrays (tuples). Every function produces a new tuple — inputs are never
 * mutated.
 *
 * ## Mental model
 *
 * - **Tuple**: A fixed-length readonly array where each position can have a
 *   different type (e.g., `readonly [string, number, boolean]`).
 * - **Index-based access**: Elements are accessed by numeric index, and the
 *   type system tracks the type at each position.
 * - **Dual API**: Most functions accept arguments in both data-first
 *   (`Tuple.get(t, 0)`) and data-last (`pipe(t, Tuple.get(0))`) style.
 * - **Immutability**: All operations return a new tuple; the original is
 *   never modified.
 * - **Lambda**: A type-level function interface (from {@link Struct}) used by
 *   {@link map}, {@link mapPick}, and {@link mapOmit} so the compiler can
 *   track how element types change.
 *
 * ## Common tasks
 *
 * - Create a tuple → {@link make}
 * - Access an element by index → {@link get}
 * - Select / remove elements by index → {@link pick}, {@link omit}
 * - Append elements → {@link appendElement}, {@link appendElements}
 * - Transform selected elements → {@link evolve}
 * - Swap element positions → {@link renameIndices}
 * - Map all elements with a typed lambda → {@link map}, {@link mapPick},
 *   {@link mapOmit}
 * - Compare tuples → {@link makeEquivalence}, {@link makeOrder}
 * - Combine / reduce tuples → {@link makeCombiner}, {@link makeReducer}
 * - Check tuple length at runtime → {@link isTupleOf},
 *   {@link isTupleOfAtLeast}
 *
 * ## Gotchas
 *
 * - {@link pick} and {@link omit} use numeric indices, not string keys.
 * - {@link renameIndices} takes an array of stringified source indices
 *   (e.g., `["2", "1", "0"]`), not arbitrary names.
 * - {@link map}, {@link mapPick}, {@link mapOmit} require a Lambda value
 *   created with `Struct.lambda`; a plain function won't type-check.
 * - {@link isTupleOf} and {@link isTupleOfAtLeast} only check length, not
 *   element types.
 *
 * ## Quickstart
 *
 * **Example** (Creating and transforming a tuple)
 *
 * ```ts
 * import { pipe, Tuple } from "effect"
 *
 * const point = Tuple.make(10, 20, "red")
 *
 * const result = pipe(
 *   point,
 *   Tuple.evolve([
 *     (x) => x * 2,
 *     (y) => y * 2
 *   ])
 * )
 *
 * console.log(result) // [20, 40, "red"]
 * ```
 *
 * ## See also
 *
 * - {@link Struct} – similar utilities for objects with named keys
 * - {@link Array} – operations on variable-length arrays
 *
 * @since 2.0.0
 */
import * as Combiner from "./Combiner.ts"
import * as Equivalence from "./Equivalence.ts"
import { dual } from "./Function.ts"
import * as order from "./Order.ts"
import * as Reducer from "./Reducer.ts"
import type { Apply, Lambda } from "./Struct.ts"

/**
 * Creates a tuple from the provided arguments.
 *
 * - Use instead of `[a, b, c] as const` to get a properly typed tuple
 *   without a manual cast.
 * - Returns the exact tuple type with each element's literal type preserved.
 *
 * **Example** (Creating a tuple)
 *
 * ```ts
 * import { Tuple } from "effect"
 *
 * const point = Tuple.make(10, 20, "red")
 * console.log(point) // [10, 20, "red"]
 * ```
 *
 * @see {@link get} – access a single element by index
 * @see {@link appendElement} – append an element to a tuple
 *
 * @category Constructors
 * @since 2.0.0
 */
export const make = <Elements extends ReadonlyArray<unknown>>(...elements: Elements): Elements => elements

type Indices<T extends ReadonlyArray<unknown>> = Exclude<Partial<T>["length"], T["length"]>

/**
 * Retrieves the element at the specified index from a tuple.
 *
 * - Use in a pipeline when you need to extract a single element.
 * - The index is constrained to valid tuple positions at the type level.
 * - Does not mutate the input.
 *
 * **Example** (Extracting an element by index)
 *
 * ```ts
 * import { pipe, Tuple } from "effect"
 *
 * const last = pipe(Tuple.make(1, true, "hello"), Tuple.get(2))
 * console.log(last) // "hello"
 * ```
 *
 * @see {@link make} – create a tuple
 * @see {@link pick} – extract multiple elements into a new tuple
 *
 * @category Getters
 * @since 4.0.0
 */
export const get: {
  <const T extends ReadonlyArray<unknown>, I extends Indices<T> & keyof T>(index: I): (self: T) => T[I]
  <const T extends ReadonlyArray<unknown>, I extends Indices<T> & keyof T>(self: T, index: I): T[I]
} = dual(2, <T extends ReadonlyArray<unknown>, I extends keyof T>(self: T, index: I): T[I] => self[index])

type _BuildTuple<
  T extends ReadonlyArray<unknown>,
  K,
  Acc extends ReadonlyArray<unknown> = [],
  I extends ReadonlyArray<unknown> = [] // current index counter
> = I["length"] extends T["length"] ? Acc
  : _BuildTuple<
    T,
    K,
    // If current index is in K, keep the element; otherwise skip it
    I["length"] extends K ? [...Acc, T[I["length"]]] : Acc,
    [...I, unknown]
  >

type PickTuple<T extends ReadonlyArray<unknown>, K> = _BuildTuple<T, K>

/**
 * Creates a new tuple containing only the elements at the specified indices.
 *
 * - Use to select a subset of elements from a tuple by position.
 * - The result order matches the order of the provided indices.
 * - Does not mutate the input; returns a fresh tuple.
 *
 * **Example** (Selecting elements by index)
 *
 * ```ts
 * import { Tuple } from "effect"
 *
 * const result = Tuple.pick(["a", "b", "c", "d"], [0, 2, 3])
 * console.log(result) // ["a", "c", "d"]
 * ```
 *
 * @see {@link omit} – the inverse (exclude indices instead)
 * @see {@link get} – extract a single element
 *
 * @category Utilities
 * @since 4.0.0
 */
export const pick: {
  <const T extends ReadonlyArray<unknown>, const I extends ReadonlyArray<Indices<T>>>(
    indices: I
  ): (self: T) => PickTuple<T, I[number]>
  <const T extends ReadonlyArray<unknown>, const I extends ReadonlyArray<Indices<T>>>(
    self: T,
    indices: I
  ): PickTuple<T, I[number]>
} = dual(
  2,
  <const T extends ReadonlyArray<unknown>>(
    self: T,
    indices: ReadonlyArray<number>
  ) => {
    return indices.map((i) => self[i])
  }
)

type OmitTuple<T extends ReadonlyArray<unknown>, K> = _BuildTuple<T, Exclude<Indices<T>, K>>

/**
 * Creates a new tuple with the elements at the specified indices removed.
 *
 * - Use to drop elements from a tuple by position.
 * - Elements not at the specified indices are kept in their original order.
 * - Does not mutate the input; returns a fresh tuple.
 *
 * **Example** (Removing elements by index)
 *
 * ```ts
 * import { Tuple } from "effect"
 *
 * const result = Tuple.omit(["a", "b", "c", "d"], [1, 3])
 * console.log(result) // ["a", "c"]
 * ```
 *
 * @see {@link pick} – the inverse (keep only specified indices)
 *
 * @category Utilities
 * @since 4.0.0
 */
export const omit: {
  <const T extends ReadonlyArray<unknown>, const I extends ReadonlyArray<Indices<T>>>(
    indices: I
  ): (self: T) => OmitTuple<T, I[number]>
  <const T extends ReadonlyArray<unknown>, const I extends ReadonlyArray<Indices<T>>>(
    self: T,
    indices: I
  ): OmitTuple<T, I[number]>
} = dual(
  2,
  <const T extends ReadonlyArray<unknown>>(
    self: T,
    indices: ReadonlyArray<number>
  ) => {
    const toDrop = new Set<number>(indices)
    return self.filter((_, i) => !toDrop.has(i))
  }
)

/**
 * Appends a single element to the end of a tuple.
 *
 * - The result type is `[...T, E]`, preserving all existing element types.
 * - Does not mutate the input; returns a fresh tuple.
 *
 * **Example** (Appending an element)
 *
 * ```ts
 * import { pipe, Tuple } from "effect"
 *
 * const result = pipe(Tuple.make(1, 2), Tuple.appendElement("end"))
 * console.log(result) // [1, 2, "end"]
 * ```
 *
 * @see {@link appendElements} – append multiple elements (another tuple)
 *
 * @category Concatenating
 * @since 2.0.0
 */
export const appendElement: {
  <const E>(element: E): <const T extends ReadonlyArray<unknown>>(self: T) => [...T, E]
  <const T extends ReadonlyArray<unknown>, const E>(self: T, element: E): [...T, E]
} = dual(2, <T extends ReadonlyArray<unknown>, E>(self: T, element: E): [...T, E] => [...self, element])

/**
 * Concatenates two tuples into a single tuple.
 *
 * - The result type is `[...T1, ...T2]`, preserving all element types from
 *   both tuples.
 * - Does not mutate either input; returns a fresh tuple.
 *
 * **Example** (Concatenating tuples)
 *
 * ```ts
 * import { pipe, Tuple } from "effect"
 *
 * const result = pipe(Tuple.make(1, 2), Tuple.appendElements(["a", "b"] as const))
 * console.log(result) // [1, 2, "a", "b"]
 * ```
 *
 * @see {@link appendElement} – append a single element
 *
 * @category Concatenating
 * @since 2.0.0
 */
export const appendElements: {
  <const T2 extends ReadonlyArray<unknown>>(
    that: T2
  ): <const T1 extends ReadonlyArray<unknown>>(self: T1) => [...T1, ...T2]
  <const T1 extends ReadonlyArray<unknown>, const T2 extends ReadonlyArray<unknown>>(self: T1, that: T2): [...T1, ...T2]
} = dual(
  2,
  <T1 extends ReadonlyArray<unknown>, T2 extends ReadonlyArray<unknown>>(
    self: T1,
    that: T2
  ): [...T1, ...T2] => [...self, ...that]
)

type Evolver<T> = { readonly [I in keyof T]?: ((a: T[I]) => unknown) | undefined }

type Evolved<T, E> = { [I in keyof T]: I extends keyof E ? (E[I] extends (...a: any) => infer R ? R : T[I]) : T[I] }

/**
 * Transforms elements of a tuple by providing an array of transform functions.
 * Each function applies to the element at the same position. Positions beyond
 * the array's length are copied unchanged.
 *
 * - Use when you want to update the first N elements while keeping the rest.
 * - Does not mutate the input; returns a fresh tuple.
 * - Each transform function receives the current value and can return a
 *   different type.
 *
 * **Example** (Transforming selected elements)
 *
 * ```ts
 * import { pipe, Tuple } from "effect"
 *
 * const result = pipe(
 *   Tuple.make("hello", 42, true),
 *   Tuple.evolve([
 *     (s) => s.toUpperCase(),
 *     (n) => n * 2
 *   ])
 * )
 * console.log(result) // ["HELLO", 84, true]
 * ```
 *
 * @see {@link map} – apply the same transformation to all elements
 * @see {@link renameIndices} – swap element positions
 *
 * @category Mapping
 * @since 4.0.0
 */
export const evolve: {
  <const T extends ReadonlyArray<unknown>, const E extends Evolver<T>>(evolver: E): (self: T) => Evolved<T, E>
  <const T extends ReadonlyArray<unknown>, const E extends Evolver<T>>(self: T, evolver: E): Evolved<T, E>
} = dual(
  2,
  <const T extends ReadonlyArray<unknown>, const E extends Evolver<T>>(self: T, evolver: E) => {
    return self.map((e, i) => (evolver[i] !== undefined ? evolver[i](e) : e))
  }
)

/**
 * Rearranges elements of a tuple by providing an array of stringified source
 * indices. Each position in the array specifies which index to read from
 * (e.g., `["2", "1", "0"]` reverses a 3-element tuple).
 *
 * - Does not mutate the input; returns a fresh tuple.
 *
 * **Example** (Swapping elements)
 *
 * ```ts
 * import { pipe, Tuple } from "effect"
 *
 * const result = pipe(
 *   Tuple.make("a", "b", "c"),
 *   Tuple.renameIndices(["2", "1", "0"])
 * )
 * console.log(result) // ["c", "b", "a"]
 * ```
 *
 * @see {@link evolve} – transform element values instead of positions
 *
 * @category Index utilities
 * @since 4.0.0
 */
export const renameIndices: {
  <const T extends ReadonlyArray<unknown>, const M extends { readonly [I in keyof T]?: `${keyof T & string}` }>(
    mapping: M
  ): (self: T) => { [I in keyof T]: I extends keyof M ? M[I] extends keyof T ? T[M[I]] : T[I] : T[I] }
  <const T extends ReadonlyArray<unknown>, const M extends { readonly [I in keyof T]?: `${keyof T & string}` }>(
    self: T,
    mapping: M
  ): { [I in keyof T]: I extends keyof M ? M[I] extends keyof T ? T[M[I]] : T[I] : T[I] }
} = dual(
  2,
  <const T extends ReadonlyArray<unknown>, const M extends { readonly [I in keyof T]?: `${keyof T & string}` }>(
    self: T,
    mapping: M
  ) => {
    return self.map((e, i) => mapping[i] !== undefined ? self[mapping[i]] : e)
  }
)

/**
 * Applies a `Struct.Lambda` transformation to every element in a tuple.
 *
 * - Use when you want to apply the same function to every element.
 * - The lambda must be created with `Struct.lambda` so the compiler can
 *   track the output types per element.
 * - Does not mutate the input; returns a fresh tuple.
 *
 * **Example** (Wrapping every element in an array)
 *
 * ```ts
 * import { pipe, Struct, Tuple } from "effect"
 *
 * interface AsArray extends Struct.Lambda {
 *   <A>(self: A): Array<A>
 *   readonly "~lambda.out": Array<this["~lambda.in"]>
 * }
 *
 * const asArray = Struct.lambda<AsArray>((a) => [a])
 * const result = pipe(Tuple.make(1, "hello", true), Tuple.map(asArray))
 * console.log(result) // [[1], ["hello"], [true]]
 * ```
 *
 * @see {@link mapPick} – apply a lambda only to selected indices
 * @see {@link mapOmit} – apply a lambda to all indices except selected ones
 * @see {@link evolve} – apply different functions to different indices
 *
 * @category Mapping
 * @since 4.0.0
 */
export const map: {
  <L extends Lambda>(
    lambda: L
  ): <const T extends ReadonlyArray<unknown>>(
    self: T
  ) => { [K in keyof T]: Apply<L, T[K]> }
  <const T extends ReadonlyArray<unknown>, L extends Lambda>(
    self: T,
    lambda: L
  ): { [K in keyof T]: Apply<L, T[K]> }
} = dual(
  2,
  <const T extends ReadonlyArray<unknown>, L extends Function>(self: T, lambda: L) => {
    return self.map((e) => lambda(e))
  }
)

/**
 * Applies a `Struct.Lambda` transformation only to the elements at the
 * specified indices; all other elements are copied unchanged.
 *
 * - Use when you want to apply the same transformation to a subset of
 *   positions.
 * - Does not mutate the input; returns a fresh tuple.
 *
 * **Example** (Wrapping only selected elements in arrays)
 *
 * ```ts
 * import { pipe, Struct, Tuple } from "effect"
 *
 * interface AsArray extends Struct.Lambda {
 *   <A>(self: A): Array<A>
 *   readonly "~lambda.out": Array<this["~lambda.in"]>
 * }
 *
 * const asArray = Struct.lambda<AsArray>((a) => [a])
 * const result = pipe(
 *   Tuple.make(1, "hello", true),
 *   Tuple.mapPick([0, 2], asArray)
 * )
 * console.log(result) // [[1], "hello", [true]]
 * ```
 *
 * @see {@link map} – apply a lambda to all elements
 * @see {@link mapOmit} – apply a lambda to all elements except selected ones
 *
 * @category Mapping
 * @since 4.0.0
 */
export const mapPick: {
  <const T extends ReadonlyArray<unknown>, const I extends ReadonlyArray<Indices<T>>, L extends Lambda>(
    indices: I,
    lambda: L
  ): (
    self: T
  ) => { [K in keyof T]: K extends `${I[number]}` ? Apply<L, T[K]> : T[K] }
  <const T extends ReadonlyArray<unknown>, const I extends ReadonlyArray<Indices<T>>, L extends Lambda>(
    self: T,
    indices: I,
    lambda: L
  ): { [K in keyof T]: K extends `${I[number]}` ? Apply<L, T[K]> : T[K] }
} = dual(
  3,
  <const T extends ReadonlyArray<unknown>, L extends Function>(
    self: T,
    indices: ReadonlyArray<number>,
    lambda: L
  ) => {
    const toPick = new Set<number>(indices)
    return self.map((e, i) => (toPick.has(i) ? lambda(e) : e))
  }
)

/**
 * Applies a `Struct.Lambda` transformation to all elements except those at the
 * specified indices; the excluded elements are copied unchanged.
 *
 * - Use when most elements should be transformed but a few should be
 *   preserved.
 * - Does not mutate the input; returns a fresh tuple.
 *
 * **Example** (Wrapping all elements except one in arrays)
 *
 * ```ts
 * import { pipe, Struct, Tuple } from "effect"
 *
 * interface AsArray extends Struct.Lambda {
 *   <A>(self: A): Array<A>
 *   readonly "~lambda.out": Array<this["~lambda.in"]>
 * }
 *
 * const asArray = Struct.lambda<AsArray>((a) => [a])
 * const result = pipe(
 *   Tuple.make(1, "hello", true),
 *   Tuple.mapOmit([1], asArray)
 * )
 * console.log(result) // [[1], "hello", [true]]
 * ```
 *
 * @see {@link map} – apply a lambda to all elements
 * @see {@link mapPick} – apply a lambda only to selected indices
 *
 * @category Mapping
 * @since 4.0.0
 */
export const mapOmit: {
  <const T extends ReadonlyArray<unknown>, const I extends ReadonlyArray<Indices<T>>, L extends Lambda>(
    indices: I,
    lambda: L
  ): (
    self: T
  ) => { [K in keyof T]: K extends `${I[number]}` ? T[K] : Apply<L, T[K]> }
  <const T extends ReadonlyArray<unknown>, const I extends ReadonlyArray<Indices<T>>, L extends Lambda>(
    self: T,
    indices: I,
    lambda: L
  ): { [K in keyof T]: K extends `${I[number]}` ? T[K] : Apply<L, T[K]> }
} = dual(
  3,
  <const T extends ReadonlyArray<unknown>, L extends Function>(
    self: T,
    indices: ReadonlyArray<number>,
    lambda: L
  ) => {
    const toOmit = new Set<number>(indices)
    return self.map((e, i) => (toOmit.has(i) ? e : lambda(e)))
  }
)

/**
 * Creates an `Equivalence` for tuples by comparing corresponding elements
 * using the provided per-position `Equivalence`s. Two tuples are equivalent
 * when all their corresponding elements are equivalent.
 *
 * Alias of `Equivalence.Tuple`.
 *
 * - Use when you need to compare tuples element-by-element.
 *
 * **Example** (Comparing tuples for equivalence)
 *
 * ```ts
 * import { Equivalence, Tuple } from "effect"
 *
 * const eq = Tuple.makeEquivalence([
 *   Equivalence.strictEqual<string>(),
 *   Equivalence.strictEqual<number>()
 * ])
 *
 * console.log(eq(["Alice", 30], ["Alice", 30])) // true
 * console.log(eq(["Alice", 30], ["Bob", 30]))   // false
 * ```
 *
 * @see {@link makeOrder} – create an `Order` for tuples
 *
 * @category Equivalence
 * @since 2.0.0
 */
export const makeEquivalence = Equivalence.Tuple

/**
 * Creates an `Order` for tuples by comparing corresponding elements using the
 * provided per-position `Order`s. Elements are compared left-to-right; the
 * first non-zero comparison determines the result.
 *
 * Alias of `Order.Tuple`.
 *
 * - Use to sort or compare tuples lexicographically by element position.
 *
 * **Example** (Ordering tuples)
 *
 * ```ts
 * import { Number, String, Tuple } from "effect"
 *
 * const ord = Tuple.makeOrder([String.Order, Number.Order])
 *
 * console.log(ord(["Alice", 30], ["Bob", 25]))   // -1
 * console.log(ord(["Alice", 30], ["Alice", 30])) // 0
 * ```
 *
 * @see {@link makeEquivalence} – create an `Equivalence` for tuples
 *
 * @category Ordering
 * @since 2.0.0
 */
export const makeOrder = order.Tuple

export {
  /**
   * Checks if an array has exactly `N` elements, narrowing the type to a
   * fixed-length tuple.
   *
   * Re-export of `Predicate.isTupleOf`.
   *
   * - Use to guard against unexpected array lengths at runtime.
   * - Only checks `.length`; does not validate element types.
   * - Narrows the type to `TupleOf<N, T>` in the truthy branch.
   *
   * **Example** (Checking exact length)
   *
   * ```ts
   * import { Tuple } from "effect"
   *
   * const arr: Array<number> = [1, 2, 3]
   * if (Tuple.isTupleOf(arr, 3)) {
   *   console.log(arr)
   *   // ^? [number, number, number]
   * }
   * ```
   *
   * @see {@link isTupleOfAtLeast} – check for a minimum length
   *
   * @category Guards
   * @since 3.3.0
   */
  isTupleOf,
  /**
   * Checks if an array has at least `N` elements, narrowing the type to a
   * tuple with a minimum length.
   *
   * Re-export of `Predicate.isTupleOfAtLeast`.
   *
   * - Use to guard that an array has at least the expected number of elements.
   * - Only checks `.length`; does not validate element types.
   * - Narrows the type to `TupleOfAtLeast<N, T>` in the truthy branch.
   *
   * **Example** (Checking minimum length)
   *
   * ```ts
   * import { Tuple } from "effect"
   *
   * const arr: Array<number> = [1, 2, 3, 4]
   * if (Tuple.isTupleOfAtLeast(arr, 3)) {
   *   console.log(arr)
   *   // ^? [number, number, number, ...number[]]
   * }
   * ```
   *
   * @see {@link isTupleOf} – check for an exact length
   *
   * @category Guards
   * @since 3.3.0
   */
  isTupleOfAtLeast
} from "./Predicate.ts"

/**
 * Creates a `Combiner` for a tuple shape by providing a `Combiner` for each
 * position. When two tuples are combined, each element is merged using its
 * corresponding combiner.
 *
 * - Use when you need to merge two tuples of the same shape (e.g., summing
 *   counters, concatenating strings).
 * - Does not mutate the inputs; returns a fresh tuple.
 *
 * **Example** (Combining tuple elements)
 *
 * ```ts
 * import { Number, String, Tuple } from "effect"
 *
 * const C = Tuple.makeCombiner<readonly [number, string]>([
 *   Number.ReducerSum,
 *   String.ReducerConcat
 * ])
 *
 * const result = C.combine([1, "hello"], [2, " world"])
 * console.log(result) // [3, "hello world"]
 * ```
 *
 * @see {@link makeReducer} – like `makeCombiner` but with an initial value
 *
 * @since 4.0.0
 */
export function makeCombiner<A extends ReadonlyArray<unknown>>(
  combiners: { readonly [K in keyof A]: Combiner.Combiner<A[K]> }
): Combiner.Combiner<A> {
  return Combiner.make((self, that) => {
    const out = []
    for (let i = 0; i < self.length; i++) {
      out.push(combiners[i].combine(self[i], that[i]))
    }
    return out as any
  })
}

/**
 * Creates a `Reducer` for a tuple shape by providing a `Reducer` for each
 * position. The initial value is derived from each position's
 * `Reducer.initialValue`. When reducing a collection of tuples, each element
 * is combined independently.
 *
 * - Use to fold a collection of tuples into a single summary tuple.
 * - Does not mutate the inputs; returns a fresh tuple.
 *
 * **Example** (Reducing a collection of tuples)
 *
 * ```ts
 * import { Number, String, Tuple } from "effect"
 *
 * const R = Tuple.makeReducer<readonly [number, string]>([
 *   Number.ReducerSum,
 *   String.ReducerConcat
 * ])
 *
 * const result = R.combineAll([
 *   [1, "a"],
 *   [2, "b"],
 *   [3, "c"]
 * ])
 * console.log(result) // [6, "abc"]
 * ```
 *
 * @see {@link makeCombiner} – like `makeReducer` but without an initial value
 *
 * @since 4.0.0
 */
export function makeReducer<A extends ReadonlyArray<unknown>>(
  reducers: { readonly [K in keyof A]: Reducer.Reducer<A[K]> }
): Reducer.Reducer<A> {
  const combine = makeCombiner(reducers).combine
  const initialValue = []
  for (let i = 0; i < reducers.length; i++) {
    initialValue.push(reducers[i].initialValue)
  }
  return Reducer.make(combine, initialValue as unknown as A)
}

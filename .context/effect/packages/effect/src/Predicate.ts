/**
 * Predicate and Refinement helpers for runtime checks, filtering, and type narrowing.
 * This module provides small, pure functions you can combine to decide whether a
 * value matches a condition and, when using refinements, narrow TypeScript types.
 *
 * Mental model:
 * - A `Predicate<A>` is just `(a: A) => boolean`.
 * - A `Refinement<A, B>` is a predicate that narrows `A` to `B` when true.
 * - Guards like `isString` are predicates/refinements for common runtime types.
 * - Combinators like `and`/`or` build new predicates from existing ones.
 * - `Tuple` and `Struct` lift element/property predicates to compound values.
 *
 * Common tasks:
 * - Reuse an existing predicate on a different input shape -> {@link mapInput}
 * - Combine checks -> {@link and}, {@link or}, {@link not}, {@link xor}
 * - Build tuple/object checks -> {@link Tuple}, {@link Struct}
 * - Narrow `unknown` to a concrete type -> {@link Refinement}, {@link compose}
 * - Check runtime types -> {@link isString}, {@link isNumber}, {@link isObject}
 *
 * Gotchas:
 * - `isTruthy` uses JavaScript truthiness; `0`, "", and `false` are false.
 * - `isObject` excludes arrays; use {@link isObjectOrArray} for both.
 * - `isIterable` treats strings as iterable.
 * - `isPromise`/`isPromiseLike` are structural checks (then/catch), not `instanceof`.
 * - `isTupleOf` and `isTupleOfAtLeast` only check length, not element types.
 *
 * **Example** (Filter by a predicate)
 *
 * ```ts
 * import * as Predicate from "effect/Predicate"
 *
 * const isPositive = (n: number) => n > 0
 * const data = [2, -1, 3]
 *
 * console.log(data.filter(isPositive))
 * ```
 *
 * See also: {@link Predicate}, {@link Refinement}, {@link and}, {@link or}, {@link mapInput}
 *
 * @since 2.0.0
 */
import { dual } from "./Function.ts"
import type { TypeLambda } from "./HKT.ts"
import type { TupleOf, TupleOfAtLeast } from "./Types.ts"

/**
 * A function that decides whether a value of type `A` satisfies a condition.
 *
 * When to use:
 * - You want a reusable boolean check for `A`.
 * - You plan to combine checks with {@link and}/{@link or}.
 * - You want a simple filter predicate for arrays or iterables.
 *
 * Behavior:
 * - Pure function; does not mutate input.
 * - Returns `true` or `false`; never throws by itself.
 * - Does not narrow types unless you use {@link Refinement}.
 *
 * **Example** (Define a predicate)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const isPositive: Predicate.Predicate<number> = (n) => n > 0
 *
 * console.log(isPositive(1))
 * ```
 *
 * See also: {@link Refinement}, {@link mapInput}, {@link and}
 *
 * @category models
 * @since 2.0.0
 */
export interface Predicate<in A> {
  (a: A): boolean
}

/**
 * Type-level lambda for higher-kinded usage of {@link Predicate}.
 *
 * When to use:
 * - You are defining APIs that abstract over predicates with HKTs.
 * - You need a `TypeLambda` instance for predicate-based type classes.
 *
 * Behavior:
 * - Type-only; no runtime value is created.
 * - Does not affect emitted JavaScript.
 *
 * **Example** (Type-level usage)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * type P = Predicate.Predicate<number>
 * type TL = Predicate.PredicateTypeLambda
 * ```
 *
 * See also: {@link Predicate}
 *
 * @category type lambdas
 * @since 2.0.0
 */
export interface PredicateTypeLambda extends TypeLambda {
  readonly type: Predicate<this["Target"]>
}

/**
 * A predicate that also narrows the input type when it returns `true`.
 *
 * When to use:
 * - You want a runtime check that refines `A` to `B` for TypeScript.
 * - You want to compose multiple type guards with {@link compose}.
 * - You need to guard `unknown` values safely.
 *
 * Behavior:
 * - Pure function; does not mutate input.
 * - Returns a type predicate (`a is B`).
 * - Use with `if`/`filter` to narrow types.
 *
 * **Example** (Narrow unknown)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const isString: Predicate.Refinement<unknown, string> = (u): u is string => typeof u === "string"
 *
 * const data: unknown = "hello"
 * if (isString(data)) {
 *   console.log(data.toUpperCase())
 * }
 * ```
 *
 * See also: {@link Predicate}, {@link compose}, {@link isString}
 *
 * @category models
 * @since 2.0.0
 */
export interface Refinement<in A, out B extends A> {
  (a: A): a is B
}

/**
 * Type-level utilities for working with {@link Predicate} types.
 *
 * When to use:
 * - You need to extract input types from predicate signatures.
 * - You want to write generic helpers over predicate types.
 *
 * Behavior:
 * - Type-only; no runtime value is created.
 * - The namespace is erased at runtime.
 *
 * **Example** (Extract predicate input)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * type IsString = Predicate.Predicate<string>
 * type Input = Predicate.Predicate.In<IsString>
 * ```
 *
 * See also: {@link Predicate}, {@link Refinement}
 *
 * @since 3.6.0
 * @category type-level
 */
export declare namespace Predicate {
  /**
   * Extracts the input type `A` from a `Predicate<A>`.
   *
   * When to use:
   * - You want to infer the input type from a predicate type.
   * - You are defining generic utilities over predicates.
   *
   * Behavior:
   * - Type-only; no runtime value is created.
   * - Resolves to `never` if the type does not match `Predicate`.
   *
   * **Example** (Infer input)
   *
   * ```ts
   * import { Predicate } from "effect"
   *
   * type P = Predicate.Predicate<number>
   * type Input = Predicate.Predicate.In<P>
   * ```
   *
   * See also: {@link Predicate.Any}, {@link Refinement.In}
   *
   * @since 3.6.0
   * @category type-level
   */
  export type In<T extends Any> = [T] extends [Predicate<infer _A>] ? _A : never

  /**
   * A utility type representing any predicate type.
   *
   * When to use:
   * - You need a constraint for "any predicate" in generic code.
   *
   * Behavior:
   * - Type-only; no runtime value is created.
   *
   * **Example** (Generic constraint)
   *
   * ```ts
   * import { Predicate } from "effect"
   *
   * type AnyPredicate = Predicate.Predicate.Any
   * ```
   *
   * See also: {@link Predicate.In}
   *
   * @since 3.6.0
   * @category type-level
   */
  export type Any = Predicate<any>
}

/**
 * Type-level utilities for working with {@link Refinement} types.
 *
 * When to use:
 * - You need to extract input/output types from refinement signatures.
 * - You want to write generic helpers over refinements.
 *
 * Behavior:
 * - Type-only; no runtime value is created.
 * - The namespace is erased at runtime.
 *
 * **Example** (Extract refinement types)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * type IsString = Predicate.Refinement<unknown, string>
 * type Input = Predicate.Refinement.In<IsString>
 * type Output = Predicate.Refinement.Out<IsString>
 * ```
 *
 * See also: {@link Refinement}, {@link Predicate}
 *
 * @since 3.6.0
 * @category type-level
 */
export declare namespace Refinement {
  /**
   * Extracts the input type `A` from a `Refinement<A, B>`.
   *
   * When to use:
   * - You want to infer the input type from a refinement type.
   *
   * Behavior:
   * - Type-only; no runtime value is created.
   * - Resolves to `never` if the type does not match `Refinement`.
   *
   * **Example** (Infer input)
   *
   * ```ts
   * import { Predicate } from "effect"
   *
   * type R = Predicate.Refinement<unknown, string>
   * type Input = Predicate.Refinement.In<R>
   * ```
   *
   * See also: {@link Refinement.Out}, {@link Predicate.In}
   *
   * @since 3.6.0
   * @category type-level
   */

  export type In<T extends Any> = [T] extends [Refinement<infer _A, infer _>] ? _A : never

  /**
   * Extracts the output type `B` from a `Refinement<A, B>`.
   *
   * When to use:
   * - You want to infer the narrowed type from a refinement type.
   *
   * Behavior:
   * - Type-only; no runtime value is created.
   * - Resolves to `never` if the type does not match `Refinement`.
   *
   * **Example** (Infer output)
   *
   * ```ts
   * import { Predicate } from "effect"
   *
   * type R = Predicate.Refinement<unknown, string>
   * type Output = Predicate.Refinement.Out<R>
   * ```
   *
   * See also: {@link Refinement.In}
   *
   * @since 3.6.0
   * @category type-level
   */
  export type Out<T extends Any> = [T] extends [Refinement<infer _, infer _B>] ? _B : never

  /**
   * A utility type representing any refinement type.
   *
   * When to use:
   * - You need a constraint for "any refinement" in generic code.
   *
   * Behavior:
   * - Type-only; no runtime value is created.
   *
   * **Example** (Generic constraint)
   *
   * ```ts
   * import { Predicate } from "effect"
   *
   * type AnyRefinement = Predicate.Refinement.Any
   * ```
   *
   * See also: {@link Refinement.In}, {@link Refinement.Out}
   *
   * @since 3.6.0
   * @category type-level
   */
  export type Any = Refinement<any, any>
}

/**
 * Transforms the input of a predicate using a mapping function.
 *
 * When to use:
 * - You have a predicate on `A` and want one on `B` via `B -> A`.
 * - You want to check derived values (lengths, projections, etc.).
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Returns a new predicate that applies `f` before `self`.
 * - No short-circuit beyond what `self` does.
 *
 * **Example** (Check string length)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const isLongerThan2 = Predicate.mapInput((s: string) => s.length)(
 *   (n: number) => n > 2
 * )
 *
 * console.log(isLongerThan2("hello"))
 * ```
 *
 * See also: {@link Predicate}, {@link and}, {@link not}
 *
 * @category combinators
 * @since 2.0.0
 */
export const mapInput: {
  <B, A>(f: (b: B) => A): (self: Predicate<A>) => Predicate<B>
  <A, B>(self: Predicate<A>, f: (b: B) => A): Predicate<B>
} = dual(2, <A, B>(self: Predicate<A>, f: (b: B) => A): Predicate<B> => (b) => self(f(b)))

/**
 * Checks whether a readonly array has exactly `n` elements.
 *
 * When to use:
 * - You need a runtime check for tuple length.
 * - You want to narrow `ReadonlyArray<T>` to `TupleOf<N, T>`.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Only checks length, not element types.
 * - Returns a refinement on the array type.
 *
 * **Example** (Exact length)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const isPair = Predicate.isTupleOf(2)
 *
 * console.log(isPair([1, 2]))
 * ```
 *
 * See also: {@link isTupleOfAtLeast}, {@link Tuple}
 *
 * @category guards
 * @since 3.3.0
 */
export const isTupleOf: {
  <N extends number>(n: N): <T>(self: ReadonlyArray<T>) => self is TupleOf<N, T>
  <T, N extends number>(self: ReadonlyArray<T>, n: N): self is TupleOf<N, T>
} = dual(2, <T, N extends number>(self: ReadonlyArray<T>, n: N): self is TupleOf<N, T> => self.length === n)

/**
 * Checks whether a readonly array has at least `n` elements.
 *
 * When to use:
 * - You need a runtime check for tuple-like minimum length.
 * - You want to narrow `ReadonlyArray<T>` to `TupleOfAtLeast<N, T>`.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Only checks length, not element types.
 * - Returns a refinement on the array type.
 *
 * **Example** (Minimum length)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const hasAtLeast2 = Predicate.isTupleOfAtLeast(2)
 *
 * console.log(hasAtLeast2([1, 2, 3]))
 * ```
 *
 * See also: {@link isTupleOf}, {@link Tuple}
 *
 * @category guards
 * @since 3.3.0
 */
export const isTupleOfAtLeast: {
  <N extends number>(n: N): <T>(self: ReadonlyArray<T>) => self is TupleOfAtLeast<N, T>
  <T, N extends number>(self: ReadonlyArray<T>, n: N): self is TupleOfAtLeast<N, T>
} = dual(2, <T, N extends number>(self: ReadonlyArray<T>, n: N): self is TupleOfAtLeast<N, T> => self.length >= n)

/**
 * Checks whether a value is truthy.
 *
 * When to use:
 * - You want a predicate that mirrors JavaScript truthiness.
 * - You need to filter out falsy values like `0`, "", and `false`.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `!!input` under the hood.
 * - Treats `0`, "", `false`, `null`, and `undefined` as false.
 *
 * **Example** (Filter truthy)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const values = [0, 1, "", "ok", false]
 * const truthy = values.filter(Predicate.isTruthy)
 *
 * console.log(truthy)
 * ```
 *
 * See also: {@link isNullish}, {@link isNotNullish}
 *
 * @category guards
 * @since 2.0.0
 */
export function isTruthy(input: unknown): boolean {
  return !!input
}

/**
 * Checks whether a value is a `Set`.
 *
 * When to use:
 * - You need a runtime guard for `Set` values.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `instanceof Set`.
 *
 * **Example** (Guard a Set)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = new Set([1, 2])
 *
 * if (Predicate.isSet(data)) {
 *   console.log(data.size)
 * }
 * ```
 *
 * See also: {@link isMap}, {@link isIterable}
 *
 * @category guards
 * @since 2.0.0
 */
export function isSet(input: unknown): input is Set<unknown> {
  return input instanceof Set
}

/**
 * Checks whether a value is a `Map`.
 *
 * When to use:
 * - You need a runtime guard for `Map` values.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `instanceof Map`.
 *
 * **Example** (Guard a Map)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = new Map([["a", 1]])
 *
 * if (Predicate.isMap(data)) {
 *   console.log(data.size)
 * }
 * ```
 *
 * See also: {@link isSet}, {@link isIterable}
 *
 * @category guards
 * @since 2.0.0
 */
export function isMap(input: unknown): input is Map<unknown, unknown> {
  return input instanceof Map
}

/**
 * Checks whether a value is a `string`.
 *
 * When to use:
 * - You need to guard an `unknown` value as a string.
 * - You want to narrow in `if` statements.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `typeof input === "string"`.
 *
 * **Example** (Guard string)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = "hi"
 *
 * if (Predicate.isString(data)) {
 *   console.log(data.toUpperCase())
 * }
 * ```
 *
 * See also: {@link isNumber}, {@link isBoolean}, {@link Refinement}
 *
 * @category guards
 * @since 2.0.0
 */
export function isString(input: unknown): input is string {
  return typeof input === "string"
}

/**
 * Checks whether a value is a `number`.
 *
 * When to use:
 * - You need to guard an `unknown` value as a number.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `typeof input === "number"`.
 * - Does not exclude `NaN` or `Infinity`.
 *
 * **Example** (Guard number)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = 42
 *
 * if (Predicate.isNumber(data)) {
 *   console.log(data + 1)
 * }
 * ```
 *
 * See also: {@link isBigInt}, {@link isString}
 *
 * @category guards
 * @since 2.0.0
 */
export function isNumber(input: unknown): input is number {
  return typeof input === "number"
}

/**
 * Checks whether a value is a `boolean`.
 *
 * When to use:
 * - You need to guard an `unknown` value as a boolean.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `typeof input === "boolean"`.
 *
 * **Example** (Guard boolean)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = true
 *
 * if (Predicate.isBoolean(data)) {
 *   console.log(data ? "yes" : "no")
 * }
 * ```
 *
 * See also: {@link isString}, {@link isNumber}
 *
 * @category guards
 * @since 2.0.0
 */
export function isBoolean(input: unknown): input is boolean {
  return typeof input === "boolean"
}

/**
 * Checks whether a value is a `bigint`.
 *
 * When to use:
 * - You need to guard an `unknown` value as a bigint.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `typeof input === "bigint"`.
 *
 * **Example** (Guard bigint)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = 1n
 *
 * if (Predicate.isBigInt(data)) {
 *   console.log(data + 2n)
 * }
 * ```
 *
 * See also: {@link isNumber}
 *
 * @category guards
 * @since 2.0.0
 */
export function isBigInt(input: unknown): input is bigint {
  return typeof input === "bigint"
}

/**
 * Checks whether a value is a `symbol`.
 *
 * When to use:
 * - You need to guard an `unknown` value as a symbol.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `typeof input === "symbol"`.
 *
 * **Example** (Guard symbol)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = Symbol.for("id")
 *
 * if (Predicate.isSymbol(data)) {
 *   console.log(data.description)
 * }
 * ```
 *
 * See also: {@link isPropertyKey}
 *
 * @category guards
 * @since 2.0.0
 */
export function isSymbol(input: unknown): input is symbol {
  return typeof input === "symbol"
}

/**
 * Checks whether a value is a valid `PropertyKey` (string, number, or symbol).
 *
 * When to use:
 * - You need to guard unknown keys before indexing.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses {@link isString}, {@link isNumber}, and {@link isSymbol}.
 *
 * **Example** (Guard property key)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const key: unknown = "name"
 * const obj: Record<PropertyKey, unknown> = { name: "Ada" }
 *
 * if (Predicate.isPropertyKey(key) && key in obj) {
 *   console.log(obj[key])
 * }
 * ```
 *
 * See also: {@link isString}, {@link isNumber}, {@link isSymbol}
 *
 * @category guards
 * @since 4.0.0
 */
export function isPropertyKey(u: unknown): u is PropertyKey {
  return isString(u) || isNumber(u) || isSymbol(u)
}

/**
 * Checks whether a value is a `function`.
 *
 * When to use:
 * - You need to guard an `unknown` value as callable.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `typeof input === "function"`.
 *
 * **Example** (Guard function)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = () => 1
 *
 * if (Predicate.isFunction(data)) {
 *   console.log(data())
 * }
 * ```
 *
 * See also: {@link isObjectKeyword}
 *
 * @category guards
 * @since 2.0.0
 */
export function isFunction(input: unknown): input is Function {
  return typeof input === "function"
}

/**
 * Checks whether a value is `undefined`.
 *
 * When to use:
 * - You need a guard for optional values.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `input === undefined`.
 *
 * **Example** (Guard undefined)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = undefined
 *
 * console.log(Predicate.isUndefined(data))
 * ```
 *
 * See also: {@link isNotUndefined}, {@link isNullish}
 *
 * @category guards
 * @since 2.0.0
 */
export function isUndefined(input: unknown): input is undefined {
  return input === undefined
}

/**
 * Checks whether a value is not `undefined`.
 *
 * When to use:
 * - You want to filter out `undefined` while preserving other falsy values.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Returns a refinement that excludes `undefined`.
 *
 * **Example** (Filter undefined)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const values = [1, undefined, 2]
 * const defined = values.filter(Predicate.isNotUndefined)
 *
 * console.log(defined)
 * ```
 *
 * See also: {@link isUndefined}, {@link isNotNullish}
 *
 * @category guards
 * @since 2.0.0
 */
export function isNotUndefined<A>(input: A): input is Exclude<A, undefined> {
  return input !== undefined
}

/**
 * Checks whether a value is `null`.
 *
 * When to use:
 * - You need a guard for nullable values.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `input === null`.
 *
 * **Example** (Guard null)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = null
 *
 * console.log(Predicate.isNull(data))
 * ```
 *
 * See also: {@link isNotNull}, {@link isNullish}
 *
 * @category guards
 * @since 2.0.0
 */
export function isNull(input: unknown): input is null {
  return input === null
}

/**
 * Checks whether a value is not `null`.
 *
 * When to use:
 * - You want to filter out `null` while preserving other falsy values.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Returns a refinement that excludes `null`.
 *
 * **Example** (Filter null)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const values = [1, null, 2]
 * const nonNull = values.filter(Predicate.isNotNull)
 *
 * console.log(nonNull)
 * ```
 *
 * See also: {@link isNull}, {@link isNotNullish}
 *
 * @category guards
 * @since 2.0.0
 */
export function isNotNull<A>(input: A): input is Exclude<A, null> {
  return input !== null
}

/**
 * Checks whether a value is `null` or `undefined`.
 *
 * When to use:
 * - You want to guard nullish values explicitly.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `input === null || input === undefined`.
 *
 * **Example** (Guard nullish)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const values = [0, null, "", undefined]
 * const nullish = values.filter(Predicate.isNullish)
 *
 * console.log(nullish)
 * ```
 *
 * See also: {@link isNotNullish}, {@link isUndefined}, {@link isNull}
 *
 * @category guards
 * @since 4.0.0
 */
export function isNullish<A>(input: A): input is Extract<A, null | undefined> {
  return input === null || input === undefined
}

/**
 * Checks whether a value is not `null` and not `undefined`.
 *
 * When to use:
 * - You want to filter out nullish values but keep other falsy ones.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `input != null`.
 *
 * **Example** (Filter non-nullish)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const values = [0, null, "", undefined]
 * const present = values.filter(Predicate.isNotNullish)
 *
 * console.log(present)
 * ```
 *
 * See also: {@link isNullish}, {@link isNotNull}, {@link isNotUndefined}
 *
 * @category guards
 * @since 4.0.0
 */
export function isNotNullish<A>(input: A): input is NonNullable<A> {
  return input != null
}

/**
 * A guard that always returns `false`.
 *
 * When to use:
 * - You need a predicate that never accepts, e.g. in default branches.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Always returns `false`.
 *
 * **Example** (Never matches)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * console.log(Predicate.isNever("anything"))
 * ```
 *
 * See also: {@link isUnknown}
 *
 * @category guards
 * @since 2.0.0
 */
export function isNever(_: unknown): _ is never {
  return false
}

/**
 * A guard that always returns `true`.
 *
 * When to use:
 * - You need a predicate that always accepts, e.g. as a placeholder.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Always returns `true`.
 *
 * **Example** (Always matches)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * console.log(Predicate.isUnknown(123))
 * ```
 *
 * See also: {@link isNever}
 *
 * @category guards
 * @since 2.0.0
 */
export function isUnknown(_: unknown): _ is unknown {
  return true
}

/**
 * Checks whether a value is an object or an array (non-null object).
 *
 * When to use:
 * - You want to accept plain objects and arrays, but not `null`.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `typeof input === "object" && input !== null`.
 * - Includes arrays.
 *
 * **Example** (Object or array)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * console.log(Predicate.isObjectOrArray([]))
 * ```
 *
 * See also: {@link isObject}, {@link isObjectKeyword}
 *
 * @category guards
 * @since 4.0.0
 */
export function isObjectOrArray(input: unknown): input is { [x: PropertyKey]: unknown } | Array<unknown> {
  return typeof input === "object" && input !== null
}

/**
 * Checks whether a value is a plain object (not an array, not `null`).
 *
 * When to use:
 * - You need to accept objects but exclude arrays.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `typeof input === "object" && input !== null && !Array.isArray(input)`.
 *
 * **Example** (Guard object)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * console.log(Predicate.isObject({ a: 1 }))
 * console.log(Predicate.isObject([1, 2]))
 * ```
 *
 * See also: {@link isObjectOrArray}, {@link isReadonlyObject}
 *
 * @category guards
 * @since 4.0.0
 */
export function isObject(input: unknown): input is { [x: PropertyKey]: unknown } {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

/**
 * Checks whether a value is a readonly object.
 *
 * When to use:
 * - You need a guard for object-like values and do not care about mutability.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Delegates to {@link isObject}.
 *
 * **Example** (Readonly object)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = { a: 1 }
 *
 * console.log(Predicate.isReadonlyObject(data))
 * ```
 *
 * See also: {@link isObject}
 *
 * @category guards
 * @since 4.0.0
 */
export function isReadonlyObject(input: unknown): input is { readonly [x: PropertyKey]: unknown } {
  return isObject(input)
}

/**
 * Checks whether a value is an `object` in the JavaScript sense (objects, arrays, functions).
 *
 * When to use:
 * - You want to accept arrays and functions as well as objects.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Returns `true` for arrays and functions, `false` for `null`.
 *
 * **Example** (Object keyword)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * console.log(Predicate.isObjectKeyword(() => 1))
 * console.log(Predicate.isObjectKeyword(null))
 * ```
 *
 * See also: {@link isObject}, {@link isObjectOrArray}
 *
 * @category guards
 * @since 2.0.0
 */
export function isObjectKeyword(input: unknown): input is object {
  return (typeof input === "object" && input !== null) || isFunction(input)
}

/**
 * Checks whether a value has a given property key.
 *
 * When to use:
 * - You need to guard property access on `unknown` values.
 * - You want a simple structural guard for objects.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses the `in` operator and {@link isObjectKeyword}.
 * - Does not check property value types.
 *
 * **Example** (Guard property)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const hasName = Predicate.hasProperty("name")
 * const data: unknown = { name: "Ada" }
 *
 * if (hasName(data)) {
 *   console.log(data.name)
 * }
 * ```
 *
 * See also: {@link isTagged}, {@link isObjectKeyword}
 *
 * @category guards
 * @since 2.0.0
 */
export const hasProperty: {
  <P extends PropertyKey>(property: P): (self: unknown) => self is { [K in P]: unknown }
  <P extends PropertyKey>(self: unknown, property: P): self is { [K in P]: unknown }
} = dual(
  2,
  <P extends PropertyKey>(self: unknown, property: P): self is { [K in P]: unknown } =>
    isObjectKeyword(self) && (property in self)
)

/**
 * Checks whether a value has a `_tag` property equal to the given tag.
 *
 * When to use:
 * - You model tagged unions with a `_tag` field.
 * - You want a quick, structural guard for tagged values.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses {@link hasProperty} and strict equality on `_tag`.
 *
 * **Example** (Guard tagged)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const isOk = Predicate.isTagged("Ok")
 *
 * console.log(isOk({ _tag: "Ok", value: 1 }))
 * ```
 *
 * See also: {@link hasProperty}
 *
 * @category guards
 * @since 2.0.0
 */
export const isTagged: {
  <K extends string>(tag: K): (self: unknown) => self is { _tag: K }
  <K extends string>(self: unknown, tag: K): self is { _tag: K }
} = dual(
  2,
  <K extends string>(self: unknown, tag: K): self is { _tag: K } => hasProperty(self, "_tag") && self["_tag"] === tag
)

/**
 * Checks whether a value is an `Error`.
 *
 * When to use:
 * - You need to guard errors caught from unknown sources.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `instanceof Error`.
 *
 * **Example** (Guard error)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = new Error("boom")
 *
 * console.log(Predicate.isError(data))
 * ```
 *
 * See also: {@link isUnknown}
 *
 * @category guards
 * @since 2.0.0
 */
export function isError(input: unknown): input is Error {
  return input instanceof Error
}

/**
 * Checks whether a value is a `Uint8Array`.
 *
 * When to use:
 * - You need to guard binary data at runtime.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `instanceof Uint8Array`.
 *
 * **Example** (Guard Uint8Array)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = new Uint8Array([1, 2])
 *
 * console.log(Predicate.isUint8Array(data))
 * ```
 *
 * See also: {@link isIterable}, {@link isSet}
 *
 * @category guards
 * @since 2.0.0
 */
export function isUint8Array(input: unknown): input is Uint8Array {
  return input instanceof Uint8Array
}

/**
 * Checks whether a value is a `Date`.
 *
 * When to use:
 * - You need to guard dates at runtime.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `instanceof Date`.
 *
 * **Example** (Guard Date)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = new Date()
 *
 * console.log(Predicate.isDate(data))
 * ```
 *
 * See also: {@link isRegExp}
 *
 * @category guards
 * @since 2.0.0
 */
export function isDate(input: unknown): input is Date {
  return input instanceof Date
}

/**
 * Checks whether a value is iterable.
 *
 * When to use:
 * - You need a guard before iterating an unknown value.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Accepts strings as iterable.
 * - Uses {@link hasProperty} for `Symbol.iterator`.
 *
 * **Example** (Guard iterable)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = [1, 2, 3]
 *
 * console.log(Predicate.isIterable(data))
 * ```
 *
 * See also: {@link isSet}, {@link isMap}
 *
 * @category guards
 * @since 2.0.0
 */
export function isIterable(input: unknown): input is Iterable<unknown> {
  return hasProperty(input, Symbol.iterator) || isString(input)
}

/**
 * Checks whether a value is a `Promise`-like object with `then` and `catch`.
 *
 * When to use:
 * - You need to detect promise instances across realms.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Structural check for `then` and `catch` functions.
 *
 * **Example** (Guard promise)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = Promise.resolve(1)
 *
 * console.log(Predicate.isPromise(data))
 * ```
 *
 * See also: {@link isPromiseLike}
 *
 * @category guards
 * @since 2.0.0
 */
export function isPromise(input: unknown): input is Promise<unknown> {
  return hasProperty(input, "then") && "catch" in input && isFunction(input.then) && isFunction(input.catch)
}

/**
 * Checks whether a value is `PromiseLike` (has a `then` method).
 *
 * When to use:
 * - You only need `then` to interop with promise-like values.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Structural check for a callable `then`.
 *
 * **Example** (Guard promise-like)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = { then: () => {} }
 *
 * console.log(Predicate.isPromiseLike(data))
 * ```
 *
 * See also: {@link isPromise}
 *
 * @category guards
 * @since 2.0.0
 */
export function isPromiseLike(input: unknown): input is PromiseLike<unknown> {
  return hasProperty(input, "then") && isFunction(input.then)
}

/**
 * Checks whether a value is a `RegExp`.
 *
 * When to use:
 * - You need a runtime guard for regular expressions.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Uses `instanceof RegExp`.
 *
 * **Example** (Guard RegExp)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const data: unknown = /abc/
 *
 * console.log(Predicate.isRegExp(data))
 * ```
 *
 * See also: {@link isDate}
 *
 * @category guards
 * @since 3.9.0
 */
export function isRegExp(input: unknown): input is RegExp {
  return input instanceof RegExp
}

/**
 * Composes two predicates or refinements into one.
 *
 * When to use:
 * - You want to chain two refinements for progressive narrowing.
 * - You want a predicate that applies two checks in sequence.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - For refinements, the output type is narrowed by both.
 * - Short-circuits on the first `false`.
 *
 * **Example** (Compose refinements)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const isNumber: Predicate.Refinement<unknown, number> = (u): u is number => typeof u === "number"
 * const isInteger: Predicate.Refinement<number, number> = (n): n is number => Number.isInteger(n)
 *
 * const isIntegerNumber = Predicate.compose(isNumber, isInteger)
 *
 * console.log(isIntegerNumber(1))
 * ```
 *
 * See also: {@link and}, {@link Refinement}
 *
 * @category combinators
 * @since 2.0.0
 */
export const compose: {
  <A, B extends A, C extends B>(bc: Refinement<B, C>): (ab: Refinement<A, B>) => Refinement<A, C>
  <A, B extends A>(bc: Predicate<NoInfer<B>>): (ab: Refinement<A, B>) => Refinement<A, B>
  <A, B extends A, C extends B>(ab: Refinement<A, B>, bc: Refinement<B, C>): Refinement<A, C>
  <A, B extends A>(ab: Refinement<A, B>, bc: Predicate<NoInfer<B>>): Refinement<A, B>
} = dual(
  2,
  <A, B extends A, C extends B>(ab: Refinement<A, B>, bc: Refinement<B, C>): Refinement<A, C> => (a): a is C =>
    ab(a) && bc(a)
)

/**
 * Creates a predicate for tuples by applying predicates to each element.
 *
 * When to use:
 * - You want to validate tuple positions independently.
 * - You want to lift element predicates into a tuple predicate.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Returns a refinement if any element predicate is a refinement.
 * - Stops at the first failing element.
 *
 * **Example** (Tuple predicate)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const tupleCheck = Predicate.Tuple([(n: number) => n > 0, Predicate.isString])
 *
 * console.log(tupleCheck([1, "ok"]))
 * ```
 *
 * See also: {@link Struct}, {@link isTupleOf}
 *
 * @category combinators
 * @since 4.0.0
 */
export function Tuple<const T extends ReadonlyArray<Predicate.Any>>(
  elements: T
): [Extract<T[number], Refinement.Any>] extends [never] ? Predicate<{ readonly [I in keyof T]: Predicate.In<T[I]> }>
  : Refinement<
    { readonly [I in keyof T]: T[I] extends Refinement.Any ? Refinement.In<T[I]> : Predicate.In<T[I]> },
    { readonly [I in keyof T]: T[I] extends Refinement.Any ? Refinement.Out<T[I]> : Predicate.In<T[I]> }
  >
{
  return ((as: Array<unknown>) => {
    for (let i = 0; i < elements.length; i++) {
      if (elements[i](as[i]) === false) {
        return false
      }
    }
    return true
  }) as any
}

/**
 * Creates a predicate for objects by applying predicates to named properties.
 *
 * When to use:
 * - You want to validate a record shape at runtime.
 * - You want to lift property predicates into an object predicate.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Returns a refinement if any field predicate is a refinement.
 * - Checks only the specified keys; extra keys are ignored.
 *
 * **Example** (Struct predicate)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const userCheck = Predicate.Struct({
 *   id: Predicate.isNumber,
 *   name: Predicate.isString
 * })
 *
 * console.log(userCheck({ id: 1, name: "Ada" }))
 * ```
 *
 * See also: {@link Tuple}, {@link hasProperty}
 *
 * @category combinators
 * @since 4.0.0
 */
export function Struct<R extends Record<string, Predicate.Any>>(
  fields: R
): [Extract<R[keyof R], Refinement.Any>] extends [never] ? Predicate<{ readonly [K in keyof R]: Predicate.In<R[K]> }> :
  Refinement<
    { readonly [K in keyof R]: R[K] extends Refinement.Any ? Refinement.In<R[K]> : Predicate.In<R[K]> },
    { readonly [K in keyof R]: R[K] extends Refinement.Any ? Refinement.Out<R[K]> : Predicate.In<R[K]> }
  >
{
  const keys = Object.keys(fields)
  return ((a: Record<string, unknown>) => {
    for (const key of keys) {
      if (!fields[key](a[key] as never)) {
        return false
      }
    }
    return true
  }) as any
}

/**
 * Negates a predicate.
 *
 * When to use:
 * - You want the inverse of an existing predicate.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Returns a new predicate that flips the boolean result.
 *
 * **Example** (Negate)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const isNotString = Predicate.not(Predicate.isString)
 *
 * console.log(isNotString(1))
 * ```
 *
 * See also: {@link and}, {@link or}, {@link xor}
 *
 * @category combinators
 * @since 2.0.0
 */
export function not<A>(self: Predicate<A>): Predicate<A> {
  return (a) => !self(a)
}

/**
 * Creates a predicate that returns `true` if either predicate is `true`.
 *
 * When to use:
 * - You want to accept values that satisfy at least one condition.
 * - You want to combine refinements with union narrowing.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Short-circuits on the first `true`.
 * - For refinements, the output type is a union.
 *
 * **Example** (Either condition)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const isStringOrNumber = Predicate.or(Predicate.isString, Predicate.isNumber)
 *
 * console.log(isStringOrNumber("a"))
 * ```
 *
 * See also: {@link and}, {@link xor}
 *
 * @category combinators
 * @since 2.0.0
 */
export const or: {
  <A, C extends A>(that: Refinement<A, C>): <B extends A>(self: Refinement<A, B>) => Refinement<A, B | C>
  <A, B extends A, C extends A>(self: Refinement<A, B>, that: Refinement<A, C>): Refinement<A, B | C>
  <A>(that: Predicate<A>): (self: Predicate<A>) => Predicate<A>
  <A>(self: Predicate<A>, that: Predicate<A>): Predicate<A>
} = dual(2, <A>(self: Predicate<A>, that: Predicate<A>): Predicate<A> => (a) => self(a) || that(a))

/**
 * Creates a predicate that returns `true` only if both predicates are `true`.
 *
 * When to use:
 * - You want to accept values that satisfy multiple conditions.
 * - You want to combine refinements with intersection narrowing.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Short-circuits on the first `false`.
 * - For refinements, the output type is an intersection.
 *
 * **Example** (Both conditions)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const hasAAndB = Predicate.and(
 *   Predicate.hasProperty("a"),
 *   Predicate.hasProperty("b")
 * )
 *
 * const input: unknown = JSON.parse(`{"a":1,"b":"ok"}`)
 * if (hasAAndB(input)) {
 *   // input has both properties at this point
 *   const a = input.a
 *   const b = input.b
 * }
 * ```
 *
 * See also: {@link or}, {@link not}
 *
 * @category combinators
 * @since 2.0.0
 */
export const and: {
  <A, C extends A>(that: Refinement<A, C>): <B extends A>(self: Refinement<A, B>) => Refinement<A, B & C>
  <A, B extends A, C extends A>(self: Refinement<A, B>, that: Refinement<A, C>): Refinement<A, B & C>
  <A>(that: Predicate<A>): (self: Predicate<A>) => Predicate<A>
  <A>(self: Predicate<A>, that: Predicate<A>): Predicate<A>
} = dual(2, <A>(self: Predicate<A>, that: Predicate<A>): Predicate<A> => (a) => self(a) && that(a))

/**
 * Creates a predicate that returns `true` if exactly one predicate is `true`.
 *
 * When to use:
 * - You want an exclusive-or between two conditions.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Returns `true` when results differ.
 *
 * **Example** (Exclusive or)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const isEven = (n: number) => n % 2 === 0
 * const isPositive = (n: number) => n > 0
 * const either = Predicate.xor(isEven, isPositive)
 *
 * console.log(either(-2))
 * ```
 *
 * See also: {@link or}, {@link and}
 *
 * @category combinators
 * @since 2.0.0
 */
export const xor: {
  <A>(that: Predicate<A>): (self: Predicate<A>) => Predicate<A>
  <A>(self: Predicate<A>, that: Predicate<A>): Predicate<A>
} = dual(2, <A>(self: Predicate<A>, that: Predicate<A>): Predicate<A> => (a) => self(a) !== that(a))

/**
 * Creates a predicate that returns `true` when both predicates agree.
 *
 * When to use:
 * - You want to check equivalence of two predicates.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Returns `true` when both results are equal.
 *
 * **Example** (Equivalence)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const isEven = (n: number) => n % 2 === 0
 * const same = Predicate.eqv(isEven, isEven)
 *
 * console.log(same(3))
 * ```
 *
 * See also: {@link xor}
 *
 * @category combinators
 * @since 2.0.0
 */
export const eqv: {
  <A>(that: Predicate<A>): (self: Predicate<A>) => Predicate<A>
  <A>(self: Predicate<A>, that: Predicate<A>): Predicate<A>
} = dual(2, <A>(self: Predicate<A>, that: Predicate<A>): Predicate<A> => (a) => self(a) === that(a))

/**
 * Creates a predicate representing logical implication: if `antecedent`, then `consequent`.
 *
 * When to use:
 * - You want a rule that only applies when a precondition holds.
 * - You model constraints like "if A then B".
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Returns `true` when the antecedent is `false`.
 *
 * **Example** (Implication)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const isAdult = (age: number) => age >= 18
 * const canVote = (age: number) => age >= 18
 * const implies = Predicate.implies(isAdult, canVote)
 *
 * console.log(implies(16))
 * ```
 *
 * See also: {@link and}, {@link or}
 *
 * @category combinators
 * @since 2.0.0
 */
export const implies: {
  <A>(consequent: Predicate<A>): (antecedent: Predicate<A>) => Predicate<A>
  <A>(antecedent: Predicate<A>, consequent: Predicate<A>): Predicate<A>
} = dual(
  2,
  <A>(antecedent: Predicate<A>, consequent: Predicate<A>): Predicate<A> => (a) => antecedent(a) ? consequent(a) : true
)

/**
 * Creates a predicate that returns `true` when neither predicate is `true`.
 *
 * When to use:
 * - You want the logical NOR of two conditions.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Returns the negation of {@link or}.
 *
 * **Example** (NOR)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const neither = Predicate.nor(Predicate.isString, Predicate.isNumber)
 *
 * console.log(neither(true))
 * ```
 *
 * See also: {@link or}, {@link not}
 *
 * @category combinators
 * @since 2.0.0
 */
export const nor: {
  <A>(that: Predicate<A>): (self: Predicate<A>) => Predicate<A>
  <A>(self: Predicate<A>, that: Predicate<A>): Predicate<A>
} = dual(
  2,
  <A>(self: Predicate<A>, that: Predicate<A>): Predicate<A> => (a) => !(self(a) || that(a))
)

/**
 * Creates a predicate that returns `true` unless both predicates are `true`.
 *
 * When to use:
 * - You want the logical NAND of two conditions.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Returns the negation of {@link and}.
 *
 * **Example** (NAND)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const notBoth = Predicate.nand(Predicate.isString, Predicate.isNumber)
 *
 * console.log(notBoth("a"))
 * ```
 *
 * See also: {@link and}, {@link not}
 *
 * @category combinators
 * @since 2.0.0
 */
export const nand: {
  <A>(that: Predicate<A>): (self: Predicate<A>) => Predicate<A>
  <A>(self: Predicate<A>, that: Predicate<A>): Predicate<A>
} = dual(
  2,
  <A>(self: Predicate<A>, that: Predicate<A>): Predicate<A> => (a) => !(self(a) && that(a))
)

/**
 * Creates a predicate that returns `true` if all predicates in the collection return `true`.
 *
 * When to use:
 * - You have a dynamic list of predicates to apply.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Short-circuits on the first `false`.
 * - Iterates the collection each time the predicate is called.
 *
 * **Example** (All checks)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const allChecks = Predicate.every([Predicate.isNumber, (n: number) => n > 0])
 *
 * console.log(allChecks(2))
 * ```
 *
 * See also: {@link some}, {@link and}
 *
 * @category elements
 * @since 2.0.0
 */
export function every<A>(collection: Iterable<Predicate<A>>): Predicate<A> {
  return (a) => {
    for (const p of collection) {
      if (!p(a)) {
        return false
      }
    }
    return true
  }
}

/**
 * Creates a predicate that returns `true` if any predicate in the collection returns `true`.
 *
 * When to use:
 * - You have a dynamic list of predicates and only need one to pass.
 *
 * Behavior:
 * - Pure; does not mutate input.
 * - Short-circuits on the first `true`.
 * - Iterates the collection each time the predicate is called.
 *
 * **Example** (Any check)
 *
 * ```ts
 * import { Predicate } from "effect"
 *
 * const anyCheck = Predicate.some([Predicate.isString, Predicate.isNumber])
 *
 * console.log(anyCheck("ok"))
 * ```
 *
 * See also: {@link every}, {@link or}
 *
 * @category elements
 * @since 2.0.0
 */
export function some<A>(collection: Iterable<Predicate<A>>): Predicate<A> {
  return (a) => {
    for (const p of collection) {
      if (p(a)) {
        return true
      }
    }
    return false
  }
}

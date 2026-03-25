/**
 * Type-level utility types for TypeScript.
 *
 * This module provides generic type aliases used throughout the Effect
 * ecosystem. Everything here is compile-time only — there are no runtime
 * values. Use these types to manipulate object shapes, tagged unions, tuples,
 * and variance markers at the type level.
 *
 * ## Mental model
 *
 * - **Tagged union**: a union of objects each having a discriminating
 *   `_tag: string` field. {@link Tags}, {@link ExtractTag}, and
 *   {@link ExcludeTag} operate on these.
 * - **Reason**: a nested error pattern where an error has a `reason` field
 *   containing a tagged union of sub-errors. {@link ReasonOf},
 *   {@link ReasonTags}, {@link ExtractReason}, and {@link ExcludeReason} work
 *   with this pattern.
 * - **Variance markers**: {@link Covariant}, {@link Contravariant}, and
 *   {@link Invariant} are function-type aliases encoding variance for phantom
 *   type parameters.
 * - **Simplify**: {@link Simplify} flattens intersection types (`A & B`) into
 *   a single object type for cleaner IDE tooltips.
 * - **Concurrency**: {@link Concurrency} is a union type
 *   (`number | "unbounded" | "inherit"`) used across Effect APIs that accept
 *   concurrency options.
 * - **Marker types**: {@link unassigned} and {@link unhandled} are branded
 *   interfaces used internally to represent missing or unhandled type
 *   parameters.
 *
 * ## Common tasks
 *
 * - Flatten an intersection for readability → {@link Simplify}
 * - Check type equality at compile time → {@link Equals} / {@link EqualsWith}
 * - Merge two object types → {@link MergeLeft} / {@link MergeRight}
 * - Work with tagged unions → {@link Tags} / {@link ExtractTag} / {@link ExcludeTag}
 * - Work with nested reason errors → {@link ReasonOf} / {@link ExtractReason}
 * - Create fixed-length tuples → {@link TupleOf} / {@link TupleOfAtLeast}
 * - Strip `readonly` modifiers → {@link Mutable} / {@link DeepMutable}
 * - Encode variance in phantom types → {@link Covariant} / {@link Contravariant} / {@link Invariant}
 * - Check if a type is a union → {@link IsUnion}
 *
 * ## Gotchas
 *
 * - {@link TupleOf} with a non-literal `number` (e.g. `TupleOf<number, string>`)
 *   degrades to `Array<string>`.
 * - {@link MergeRecord} is an alias for {@link MergeLeft}; prefer
 *   {@link MergeLeft} or {@link MergeRight} for clarity.
 * - {@link NoInfer} uses the `[A][A extends any ? 0 : never]` trick, not the
 *   built-in `NoInfer` from TypeScript 5.4+.
 * - {@link DeepMutable} recurses into `Map`, `Set`, arrays, and objects but
 *   stops at primitives and functions.
 *
 * @since 4.0.0
 */

/**
 * @category tuples
 * @since 2.0.0
 */
type TupleOf_<T, N extends number, R extends Array<unknown>> = `${N}` extends `-${number}` ? never
  : R["length"] extends N ? R
  : TupleOf_<T, N, [T, ...R]>

/**
 * Constructs a tuple type with exactly `N` elements of type `T`.
 *
 * - Use when you need a fixed-length array type.
 * - Use instead of manually writing `[T, T, T, ...]` for longer tuples.
 *
 * Behavior:
 * - If `N` is a literal number, produces a tuple of that exact length.
 * - If `N` is the general `number` type (non-literal), degrades to `Array<T>`.
 * - Negative numbers produce `never`.
 *
 * **Example** (Fixed-length tuple)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * // Exactly 3 numbers
 * const triple: Types.TupleOf<3, number> = [1, 2, 3]
 *
 * // @ts-expect-error - too few elements
 * const tooFew: Types.TupleOf<3, number> = [1, 2]
 *
 * // @ts-expect-error - too many elements
 * const tooMany: Types.TupleOf<3, number> = [1, 2, 3, 4]
 * ```
 *
 * @see {@link TupleOfAtLeast}
 *
 * @category tuples
 * @since 3.3.0
 */
export type TupleOf<N extends number, T> = N extends N ? number extends N ? Array<T> : TupleOf_<T, N, []> : never

/**
 * Constructs a tuple type with at least `N` elements of type `T`.
 *
 * - Use when you need a minimum-length array type that still allows additional
 *   elements.
 * - Useful for variadic function signatures that require a minimum arity.
 *
 * Behavior:
 * - Produces a tuple with `N` fixed positions followed by `...Array<T>`.
 *
 * **Example** (Minimum-length tuple)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * // At least 2 strings
 * const ok1: Types.TupleOfAtLeast<2, string> = ["a", "b"]
 * const ok2: Types.TupleOfAtLeast<2, string> = ["a", "b", "c", "d"]
 *
 * // @ts-expect-error - too few elements
 * const bad: Types.TupleOfAtLeast<2, string> = ["a"]
 * ```
 *
 * @see {@link TupleOf}
 *
 * @category tuples
 * @since 3.3.0
 */
export type TupleOfAtLeast<N extends number, T> = [...TupleOf<N, T>, ...Array<T>]

/**
 * Extracts the `_tag` string literal types from a union.
 *
 * - Use to get all discriminant values from a tagged union type.
 * - Members without a `_tag` field are ignored (produce `never`).
 *
 * **Example** (Extracting tags)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type MyError =
 *   | { readonly _tag: "NotFound"; readonly id: string }
 *   | { readonly _tag: "Timeout"; readonly ms: number }
 *   | string
 *
 * type Result = Types.Tags<MyError>
 * // "NotFound" | "Timeout"
 * ```
 *
 * @see {@link ExtractTag}
 * @see {@link ExcludeTag}
 *
 * @category types
 * @since 2.0.0
 */
export type Tags<E> = E extends { readonly _tag: string } ? E["_tag"] : never

/**
 * Excludes members of a tagged union by their `_tag` value.
 *
 * - Use to narrow a union by removing a specific variant.
 * - Non-tagged members of the union are preserved.
 *
 * **Example** (Removing a variant)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type MyError =
 *   | { readonly _tag: "NotFound"; readonly id: string }
 *   | { readonly _tag: "Timeout"; readonly ms: number }
 *   | string
 *
 * type WithoutTimeout = Types.ExcludeTag<MyError, "Timeout">
 * // { readonly _tag: "NotFound"; readonly id: string } | string
 * ```
 *
 * @see {@link ExtractTag}
 * @see {@link Tags}
 *
 * @category types
 * @since 2.0.0
 */
export type ExcludeTag<E, K extends string> = Exclude<E, { readonly _tag: K }>

/**
 * Extracts a specific member of a tagged union by its `_tag` value.
 *
 * - Use to narrow a union down to a single variant.
 * - Returns `never` if no member matches the tag.
 *
 * **Example** (Extracting a variant)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type MyError =
 *   | { readonly _tag: "NotFound"; readonly id: string }
 *   | { readonly _tag: "Timeout"; readonly ms: number }
 *
 * type TimeoutError = Types.ExtractTag<MyError, "Timeout">
 * // { readonly _tag: "Timeout"; readonly ms: number }
 * ```
 *
 * @see {@link ExcludeTag}
 * @see {@link Tags}
 *
 * @category types
 * @since 2.0.0
 */
export type ExtractTag<E, K extends string> = E extends { readonly _tag: infer T } ? K extends T ? E : never : never

/**
 * Transforms a union type into an intersection type.
 *
 * - Use to combine all members of a union into a single type with all
 *   their properties.
 * - Useful in advanced generic code where you need to merge union variants.
 *
 * Behavior:
 * - Uses distributive conditional types and contra-variant inference.
 * - If the union members are incompatible (e.g. `string | number`), the
 *   result is `never`.
 *
 * **Example** (Union to intersection)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type Union = { a: string } | { b: number }
 * type Result = Types.UnionToIntersection<Union>
 * // { a: string } & { b: number }
 * ```
 *
 * @see {@link IsUnion}
 *
 * @since 2.0.0
 * @category types
 */
export type UnionToIntersection<T> = (T extends any ? (x: T) => any : never) extends (x: infer R) => any ? R
  : never

/**
 * Flattens an intersection type into a single object type for readability.
 *
 * - Use to clean up IDE tooltips that show `A & B & C` instead of a merged
 *   object.
 * - Does not change the type semantically, only its display.
 *
 * **Example** (Simplifying an intersection)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * // Without Simplify: IDE shows { a: number } & { b: string }
 * // With Simplify: IDE shows { a: number; b: string }
 * type Clean = Types.Simplify<{ a: number } & { b: string }>
 * ```
 *
 * @see {@link MergeLeft}
 * @see {@link MergeRight}
 *
 * @since 2.0.0
 * @category types
 */
export type Simplify<A> = {
  [K in keyof A]: A[K]
} extends infer B ? B : never

/**
 * Determines if two types are exactly equal at the type level.
 *
 * - Use in conditional types or type-level tests to assert type equality.
 * - Resolves to `true` if `X` and `Y` are identical, `false` otherwise.
 *
 * Behavior:
 * - Uses the `<T>() => T extends X ? 1 : 2` trick for exact equality,
 *   distinguishing between `any`, `unknown`, `never`, and other types.
 *
 * **Example** (Type equality check)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type Yes = Types.Equals<{ a: number }, { a: number }> // true
 * type No = Types.Equals<{ a: number }, { a: string }> // false
 * type AnyCheck = Types.Equals<any, string> // false
 * ```
 *
 * @see {@link EqualsWith}
 *
 * @since 2.0.0
 * @category models
 */
export type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <
  T
>() => T extends Y ? 1 : 2 ? true
  : false

/**
 * Determines if two types are equal, returning custom types for each case.
 *
 * - Use when you need a type-level if/else based on type equality.
 * - Returns `Y` when `A` and `B` are equal, `N` otherwise.
 *
 * **Example** (Conditional type based on equality)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type R1 = Types.EqualsWith<string, string, "same", "diff"> // "same"
 * type R2 = Types.EqualsWith<string, number, "same", "diff"> // "diff"
 * ```
 *
 * @see {@link Equals}
 *
 * @since 3.15.0
 * @category models
 */
export type EqualsWith<A, B, Y, N> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? Y : N

/**
 * Checks if an object type contains any of the specified keys.
 *
 * - Use to conditionally branch based on the presence of keys in a type.
 * - Returns `true` if at least one key from `Key` exists in `A`, `false`
 *   otherwise.
 *
 * **Example** (Key presence check)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type Yes = Types.Has<{ a: number; b: string }, "a" | "c"> // true
 * type No = Types.Has<{ a: number }, "b" | "c"> // false
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export type Has<A, Key extends string> = (Key extends infer K ? K extends keyof A ? true : never : never) extends never
  ? false
  : true

/**
 * Merges two object types where keys from `Source` take precedence over
 * `Target` on conflict.
 *
 * - Use when you want left-biased merging (first argument wins).
 * - Implemented as `MergeRight<Target, Source>`.
 *
 * **Example** (Left-biased merge)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type Result = Types.MergeLeft<
 *   { a: number; b: number },
 *   { a: string; c: boolean }
 * >
 * // { a: number; b: number; c: boolean }
 * ```
 *
 * @see {@link MergeRight}
 * @see {@link MergeRecord}
 * @see {@link Simplify}
 *
 * @since 2.0.0
 * @category models
 */
export type MergeLeft<Source, Target> = MergeRight<Target, Source>

/**
 * Merges two object types where keys from `Source` take precedence over
 * `Target` on conflict.
 *
 * - Use when you want right-biased merging (second argument wins).
 * - The result is automatically simplified via {@link Simplify}.
 *
 * **Example** (Right-biased merge)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type Result = Types.MergeRight<
 *   { a: number; b: number },
 *   { a: string; c: boolean }
 * >
 * // { a: string; b: number; c: boolean }
 * ```
 *
 * @see {@link MergeLeft}
 * @see {@link Simplify}
 *
 * @since 2.0.0
 * @category models
 */
export type MergeRight<Target, Source> = Simplify<
  & Source
  & {
    [Key in keyof Target as Key extends keyof Source ? never : Key]: Target[Key]
  }
>

/**
 * Alias for {@link MergeLeft}. Merges two object types where keys from
 * `Source` take precedence on conflict.
 *
 * Prefer {@link MergeLeft} or {@link MergeRight} for clarity about which
 * side wins.
 *
 * **Example** (Merging records)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type Result = Types.MergeRecord<
 *   { a: number; b: number },
 *   { a: string; c: boolean }
 * >
 * // { a: number; b: number; c: boolean }
 * ```
 *
 * @see {@link MergeLeft}
 * @see {@link MergeRight}
 *
 * @since 2.0.0
 * @category models
 */
export type MergeRecord<Source, Target> = MergeLeft<Source, Target>

/**
 * Describes the concurrency level for Effect operations that run multiple
 * effects.
 *
 * - `number` — run at most N effects concurrently.
 * - `"unbounded"` — run all effects concurrently with no limit.
 * - `"inherit"` — inherit the concurrency from the surrounding context.
 *
 * **Example** (Concurrency values)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * const sequential: Types.Concurrency = 1
 * const limited: Types.Concurrency = 5
 * const unbounded: Types.Concurrency = "unbounded"
 * const inherit: Types.Concurrency = "inherit"
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export type Concurrency = number | "unbounded" | "inherit"

/**
 * Removes `readonly` from all properties of `T`. Supports arrays, tuples,
 * and records.
 *
 * - Use when you need a mutable version of a readonly type.
 * - Only affects the top level; nested properties remain readonly.
 *
 * **Example** (Shallow mutable conversion)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type Obj = Types.Mutable<{
 *   readonly a: string
 *   readonly b: ReadonlyArray<number>
 * }>
 * // { a: string; b: ReadonlyArray<number> }
 * //   ^ mutable    ^ still readonly inside
 *
 * type Arr = Types.Mutable<ReadonlyArray<string>>
 * // string[]
 *
 * type Tup = Types.Mutable<readonly [string, number]>
 * // [string, number]
 * ```
 *
 * @see {@link DeepMutable}
 *
 * @since 2.0.0
 * @category types
 */
export type Mutable<T> = {
  -readonly [P in keyof T]: T[P]
}

/**
 * Recursively removes `readonly` from all properties, including nested
 * objects, arrays, `Map`, and `Set`.
 *
 * - Use when you need a fully mutable version of a deeply readonly type.
 * - Recursion stops at primitives (`string`, `number`, `boolean`, `bigint`,
 *   `symbol`) and functions.
 *
 * **Example** (Deep mutable conversion)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type Deep = Types.DeepMutable<{
 *   readonly a: string
 *   readonly b: ReadonlyArray<{ readonly c: number }>
 * }>
 * // { a: string; b: Array<{ c: number }> }
 * ```
 *
 * @see {@link Mutable}
 *
 * @since 3.1.0
 * @category types
 */
export type DeepMutable<T> = T extends ReadonlyMap<infer K, infer V> ? Map<DeepMutable<K>, DeepMutable<V>>
  : T extends ReadonlySet<infer V> ? Set<DeepMutable<V>>
  : T extends string | number | boolean | bigint | symbol | Function ? T
  : { -readonly [K in keyof T]: DeepMutable<T[K]> }

/**
 * Prevents TypeScript from inferring a type parameter from a specific
 * position.
 *
 * - Use on a function parameter when you want inference to come from other
 *   parameters, not this one.
 * - The parameter using `NoInfer` must still match the inferred type.
 *
 * **Example** (Controlling inference)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * declare function withDefault<T>(value: T, fallback: Types.NoInfer<T>): T
 *
 * // T is inferred as "a" | "b" from the first argument only
 * const result = withDefault<"a" | "b">("a", "b")
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export type NoInfer<A> = [A][A extends any ? 0 : never]

/**
 * Function-type alias encoding invariant variance for a phantom type
 * parameter.
 *
 * - Use as a phantom field type to make a type parameter invariant (neither
 *   covariant nor contravariant).
 * - A value of type `Invariant<A>` cannot be assigned to `Invariant<B>`
 *   unless `A` and `B` are the same type.
 *
 * **Example** (Invariant phantom type)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * interface Container<T> {
 *   readonly _phantom: Types.Invariant<T>
 *   readonly value: T
 * }
 * ```
 *
 * @see {@link Invariant.Type}
 * @see {@link Covariant}
 * @see {@link Contravariant}
 *
 * @since 2.0.0
 * @category models
 */
export type Invariant<A> = (_: A) => A

/**
 * Namespace for {@link Invariant}-related utilities.
 *
 * @since 3.9.0
 * @category models
 */
export declare namespace Invariant {
  /**
   * Extracts the type parameter `A` from an `Invariant<A>`.
   *
   * **Example** (Extracting the inner type)
   *
   * ```ts
   * import type { Types } from "effect"
   *
   * type Inner = Types.Invariant.Type<Types.Invariant<number>>
   * // number
   * ```
   *
   * @see {@link Invariant}
   *
   * @since 3.9.0
   * @category models
   */
  export type Type<A> = A extends Invariant<infer U> ? U : never
}

/**
 * Function-type alias encoding covariant variance for a phantom type
 * parameter.
 *
 * - Use as a phantom field type to make a type parameter covariant
 *   (output position).
 * - `Covariant<A>` is assignable to `Covariant<B>` when `A extends B`
 *   (subtype direction).
 *
 * **Example** (Covariant phantom type)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * interface Producer<T> {
 *   readonly _phantom: Types.Covariant<T>
 *   readonly get: () => T
 * }
 * ```
 *
 * @see {@link Covariant.Type}
 * @see {@link Contravariant}
 * @see {@link Invariant}
 *
 * @since 2.0.0
 * @category models
 */
export type Covariant<A> = (_: never) => A

/**
 * Namespace for {@link Covariant}-related utilities.
 *
 * @since 3.9.0
 * @category models
 */
export declare namespace Covariant {
  /**
   * Extracts the type parameter `A` from a `Covariant<A>`.
   *
   * **Example** (Extracting the inner type)
   *
   * ```ts
   * import type { Types } from "effect"
   *
   * type Inner = Types.Covariant.Type<Types.Covariant<string>>
   * // string
   * ```
   *
   * @see {@link Covariant}
   *
   * @since 3.9.0
   * @category models
   */
  export type Type<A> = A extends Covariant<infer U> ? U : never
}

/**
 * Function-type alias encoding contravariant variance for a phantom type
 * parameter.
 *
 * - Use as a phantom field type to make a type parameter contravariant
 *   (input position).
 * - `Contravariant<A>` is assignable to `Contravariant<B>` when `B extends A`
 *   (supertype direction).
 *
 * **Example** (Contravariant phantom type)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * interface Consumer<T> {
 *   readonly _phantom: Types.Contravariant<T>
 *   readonly accept: (value: T) => void
 * }
 * ```
 *
 * @see {@link Contravariant.Type}
 * @see {@link Covariant}
 * @see {@link Invariant}
 *
 * @since 2.0.0
 * @category models
 */
export type Contravariant<A> = (_: A) => void

/**
 * Namespace for {@link Contravariant}-related utilities.
 *
 * @since 3.9.0
 * @category models
 */
export declare namespace Contravariant {
  /**
   * Extracts the type parameter `A` from a `Contravariant<A>`.
   *
   * **Example** (Extracting the inner type)
   *
   * ```ts
   * import type { Types } from "effect"
   *
   * type Inner = Types.Contravariant.Type<Types.Contravariant<string>>
   * // string
   * ```
   *
   * @see {@link Contravariant}
   *
   * @since 3.9.0
   * @category models
   */
  export type Type<A> = A extends Contravariant<infer U> ? U : never
}

/**
 * Conditional type that returns `void` if `S` is an empty object type,
 * otherwise returns `S`.
 *
 * @since 4.0.0
 * @category types
 */
export type VoidIfEmpty<S> = keyof S extends never ? void : S

/**
 * Excludes function types from a union, keeping only non-function members.
 *
 * - Use to filter out callable types from a union.
 * - Returns `never` if the entire union consists of function types.
 *
 * **Example** (Filtering out functions)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type Result = Types.NotFunction<string | (() => void) | number>
 * // string | number
 * ```
 *
 * @since 2.0.0
 * @category types
 */
export type NotFunction<T> = T extends Function ? never : T

/**
 * Constrains a type to prevent excess properties not present in `T`.
 *
 * - Use in generic functions to catch accidental extra properties at
 *   compile time.
 * - Extra keys from `U` that are not in `T` are mapped to `never`.
 *
 * **Example** (Preventing extra properties)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type Expected = { a: number; b: string }
 * type Input = { a: number; b: string; c: boolean }
 *
 * type Result = Types.NoExcessProperties<Expected, Input>
 * // { a: number; b: string; readonly c: never }
 * ```
 *
 * @since 3.9.0
 * @category types
 */
export type NoExcessProperties<T, U> = T & Readonly<Record<Exclude<keyof U, keyof T>, never>>

/**
 * Branded marker interface representing an unassigned type parameter.
 *
 * Used internally by the Effect type system to indicate that a type parameter
 * has not been assigned a concrete type.
 *
 * @see {@link unhandled}
 *
 * @since 4.0.0
 * @category types
 */
export interface unassigned {
  readonly _: unique symbol
}

/**
 * Branded marker interface representing an unhandled error type.
 *
 * Used internally by the Effect type system to indicate that an error type
 * has not been handled.
 *
 * @see {@link unassigned}
 *
 * @since 4.0.0
 * @category types
 */
export interface unhandled {
  readonly _: unique symbol
}

/**
 * Checks whether a type `T` is a union type.
 *
 * - Returns `true` if `T` is a union of two or more members.
 * - Returns `false` for single types, `never`, or `any`.
 *
 * Behavior:
 * - Compares `[T]` against `[UnionToIntersection<T>]`. If they differ, `T`
 *   must be a union.
 *
 * **Example** (Detecting union types)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type Yes = Types.IsUnion<"a" | "b"> // true
 * type No = Types.IsUnion<string> // false
 * ```
 *
 * @see {@link UnionToIntersection}
 *
 * @since 4.0.0
 * @category types
 */
export type IsUnion<T> = [T] extends [UnionToIntersection<T>] ? false : true

/**
 * Extracts the `reason` type from an error that has a `reason` field.
 *
 * - Use with the nested error pattern where errors wrap sub-errors in a
 *   `reason` field.
 * - Returns `never` if `E` has no `reason` field.
 *
 * **Example** (Extracting reason types)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type RateLimitError = { readonly _tag: "RateLimitError"; readonly retryAfter: number }
 * type QuotaError = { readonly _tag: "QuotaError"; readonly limit: number }
 * type ApiError = { readonly _tag: "ApiError"; readonly reason: RateLimitError | QuotaError }
 *
 * type Reasons = Types.ReasonOf<ApiError>
 * // RateLimitError | QuotaError
 * ```
 *
 * @see {@link ReasonTags}
 * @see {@link ExtractReason}
 * @see {@link ExcludeReason}
 *
 * @since 4.0.0
 * @category types
 */
export type ReasonOf<E> = E extends { readonly reason: infer R } ? R : never

/**
 * Extracts the `_tag` values from the `reason` type of an error.
 *
 * - Shorthand for `Tags<ReasonOf<E>>`.
 * - Returns `never` if `E` has no `reason` field or the reason has no `_tag`.
 *
 * **Example** (Getting reason tags)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type RateLimitError = { readonly _tag: "RateLimitError"; readonly retryAfter: number }
 * type QuotaError = { readonly _tag: "QuotaError"; readonly limit: number }
 * type ApiError = { readonly _tag: "ApiError"; readonly reason: RateLimitError | QuotaError }
 *
 * type Result = Types.ReasonTags<ApiError>
 * // "RateLimitError" | "QuotaError"
 * ```
 *
 * @see {@link ReasonOf}
 * @see {@link ExtractReason}
 *
 * @since 4.0.0
 * @category types
 */
export type ReasonTags<E> = E extends { readonly reason: { readonly _tag: string } } ? E["reason"]["_tag"]
  : never

/**
 * Extracts a specific reason variant by its `_tag` from an error's `reason`
 * field.
 *
 * - Use to narrow down to a single reason variant from a nested error type.
 * - Returns `never` if `E` has no matching reason variant.
 *
 * **Example** (Extracting a reason variant)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type RateLimitError = { readonly _tag: "RateLimitError"; readonly retryAfter: number }
 * type QuotaError = { readonly _tag: "QuotaError"; readonly limit: number }
 * type ApiError = { readonly _tag: "ApiError"; readonly reason: RateLimitError | QuotaError }
 *
 * type Result = Types.ExtractReason<ApiError, "RateLimitError">
 * // { readonly _tag: "RateLimitError"; readonly retryAfter: number }
 * ```
 *
 * @see {@link ExcludeReason}
 * @see {@link ReasonOf}
 * @see {@link ReasonTags}
 *
 * @since 4.0.0
 * @category types
 */
export type ExtractReason<E, K extends string> = E extends { readonly reason: infer R }
  ? R extends { readonly _tag: infer T } ? K extends T ? R : never
  : never
  : never

/**
 * Narrows a specific reason variant by its `_tag` from an error's `reason`
 * field.
 *
 * - Use to narrow down to a single reason variant from a nested error type.
 * - Returns `never` if `E` has no matching reason variant.
 *
 * **Example** (Narrowing a reason variant)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type RateLimitError = { readonly _tag: "RateLimitError"; readonly retryAfter: number }
 * type QuotaError = { readonly _tag: "QuotaError"; readonly limit: number }
 * type ApiError = { readonly _tag: "ApiError"; readonly reason: RateLimitError | QuotaError }
 *
 * type Result = Types.NarrowReason<ApiError, "RateLimitError">
 * // ApiError & { readonly reason: { readonly _tag: "RateLimitError"; readonly retryAfter: number } }
 * ```
 *
 * @see {@link ExcludeReason}
 * @see {@link ReasonOf}
 * @see {@link ReasonTags}
 *
 * @since 4.0.0
 * @category types
 */
export type NarrowReason<E, K extends string> = E extends { readonly reason: infer R }
  ? R extends { readonly _tag: infer T } ? K extends T ? E & { readonly reason: R } : never
  : never
  : never

/**
 * Narrows an error's `reason` field to exclude a specific reason variant by
 * its `_tag`.
 *
 * - Use to narrow the error to only the remaining reason variants after
 *   excluding the matched one.
 * - Returns `never` if `E` has no `reason` field or no remaining variants.
 *
 * **Example** (Omitting a reason variant)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type RateLimitError = { readonly _tag: "RateLimitError"; readonly retryAfter: number }
 * type QuotaError = { readonly _tag: "QuotaError"; readonly limit: number }
 * type ApiError = { readonly _tag: "ApiError"; readonly reason: RateLimitError | QuotaError }
 *
 * type Result = Types.OmitReason<ApiError, "RateLimitError">
 * // ApiError & { readonly reason: { readonly _tag: "QuotaError"; readonly limit: number } }
 * ```
 *
 * @see {@link NarrowReason}
 * @see {@link ExcludeReason}
 * @see {@link ReasonOf}
 * @see {@link ReasonTags}
 *
 * @since 4.0.0
 * @category types
 */
export type OmitReason<E, K extends string> = E extends { readonly reason: infer R }
  ? R extends { readonly _tag: infer T } ? K extends T ? never : E & { readonly reason: R }
  : never
  : never

/**
 * Excludes a specific reason variant by its `_tag` from an error's `reason`
 * field.
 *
 * - Use to remove a handled reason variant from an error's reason union.
 * - Returns `never` if `E` has no `reason` field.
 *
 * **Example** (Excluding a reason variant)
 *
 * ```ts
 * import type { Types } from "effect"
 *
 * type RateLimitError = { readonly _tag: "RateLimitError"; readonly retryAfter: number }
 * type QuotaError = { readonly _tag: "QuotaError"; readonly limit: number }
 * type ApiError = { readonly _tag: "ApiError"; readonly reason: RateLimitError | QuotaError }
 *
 * type Result = Types.ExcludeReason<ApiError, "RateLimitError">
 * // { readonly _tag: "QuotaError"; readonly limit: number }
 * ```
 *
 * @see {@link ExtractReason}
 * @see {@link ReasonOf}
 * @see {@link ReasonTags}
 *
 * @since 4.0.0
 * @category types
 */
export type ExcludeReason<E, K extends string> = E extends { readonly reason: infer R }
  ? Exclude<R, { readonly _tag: K }>
  : never

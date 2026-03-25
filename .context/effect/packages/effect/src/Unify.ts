/**
 * @since 2.0.0
 */

import { identity } from "./Function.ts"

/**
 * A unique symbol used to identify unification behavior in Effect types.
 *
 * This symbol is used internally by the Effect type system to enable automatic
 * unification of Effect types in unions and complex type operations.
 *
 * @example
 * ```ts
 * import type { Unify } from "effect"
 *
 * // The unifySymbol is used internally in Effect types
 * // to enable automatic type unification
 * declare const effect: {
 *   readonly [Unify.unifySymbol]?: any
 * }
 * ```
 *
 * @since 2.0.0
 * @category symbols
 */
export declare const unifySymbol: unique symbol

/**
 * The type of the unifySymbol.
 *
 * This type represents the unique symbol used for identifying unification
 * behavior in Effect types. It's typically used in type-level operations
 * to enable automatic type unification.
 *
 * @example
 * ```ts
 * import type { Unify } from "effect"
 *
 * // The unifySymbol type is used in type declarations
 * // to enable unification behavior
 * type UnifyableType = {
 *   [Unify.unifySymbol]?: any
 * }
 * ```
 *
 * @since 2.0.0
 * @category symbols
 */
export type unifySymbol = typeof unifySymbol

/**
 * A unique symbol used to identify the type information for unification.
 *
 * This symbol is used internally by the Effect type system to store type
 * information that can be used during type unification operations.
 *
 * @example
 * ```ts
 * import type { Unify } from "effect"
 *
 * // The typeSymbol is used internally in Effect types
 * // to store type information for unification
 * declare const effect: {
 *   readonly [Unify.typeSymbol]?: any
 * }
 * ```
 *
 * @since 2.0.0
 * @category symbols
 */
export declare const typeSymbol: unique symbol

/**
 * The type of the typeSymbol.
 *
 * This type represents the unique symbol used for storing type information
 * in types that support unification. It's used in type-level operations
 * to access and manipulate type information.
 *
 * @example
 * ```ts
 * import type { Unify } from "effect"
 *
 * // The typeSymbol type is used in type declarations
 * // to store type information for unification
 * type TypedValue = {
 *   [Unify.typeSymbol]?: string
 * }
 * ```
 *
 * @since 2.0.0
 * @category symbols
 */
export type typeSymbol = typeof typeSymbol

/**
 * A unique symbol used to specify types that should be ignored during unification.
 *
 * This symbol is used internally by the Effect type system to mark types
 * that should be excluded from the unification process, allowing for more
 * precise type handling in complex scenarios.
 *
 * @example
 * ```ts
 * import type { Unify } from "effect"
 *
 * // The ignoreSymbol is used internally in Effect types
 * // to mark types that should be ignored during unification
 * declare const effect: {
 *   readonly [Unify.ignoreSymbol]?: any
 * }
 * ```
 *
 * @since 2.0.0
 * @category symbols
 */
export declare const ignoreSymbol: unique symbol

/**
 * The type of the ignoreSymbol.
 *
 * This type represents the unique symbol used for marking types that should
 * be ignored during unification operations. It's used in type-level operations
 * to exclude specific types from the unification process.
 *
 * @example
 * ```ts
 * import type { Unify } from "effect"
 *
 * // The ignoreSymbol type is used in type declarations
 * // to mark types that should be ignored during unification
 * type IgnorableType = {
 *   [Unify.ignoreSymbol]?: unknown
 * }
 * ```
 *
 * @since 2.0.0
 * @category symbols
 */
export type ignoreSymbol = typeof ignoreSymbol

type MaybeReturn<F> = F extends () => infer R ? R : NonNullable<F>

type Values<X extends [any, any]> = X extends [infer A, infer Ignore]
  ? Exclude<keyof A, Ignore> extends infer k ? k extends keyof A ? MaybeReturn<A[k]> : never : never
  : never

type Ignore<X> = X extends { [ignoreSymbol]?: infer Obj } ? keyof NonNullable<Obj>
  : never

type ExtractTypes<
  X
> = X extends {
  [typeSymbol]?: infer _Type
  [unifySymbol]?: infer _Unify
} ? [NonNullable<_Unify>, Ignore<X>]
  : never

type FilterIn<A> = A extends any ? typeSymbol extends keyof A ? A : never : never

type FilterOut<A> = A extends any ? typeSymbol extends keyof A ? never : A : never

/**
 * Unifies types that implement the unification protocol.
 *
 * This type performs automatic type unification for types that contain
 * the unification symbols (`unifySymbol`, `typeSymbol`, `ignoreSymbol`).
 * It's primarily used internally by the Effect type system to handle
 * complex type unions and provide better type inference.
 *
 * @example
 * ```ts
 * import type * as Unify from "effect/Unify"
 *
 * // Example of types that can be unified
 * type UnifiableA = {
 *   value: string
 *   [Unify.typeSymbol]?: string
 *   [Unify.unifySymbol]?: { String: () => string }
 * }
 *
 * type UnifiableB = {
 *   value: number
 *   [Unify.typeSymbol]?: number
 *   [Unify.unifySymbol]?: { Number: () => number }
 * }
 *
 * // Unify automatically handles the union
 * type Unified = Unify.Unify<UnifiableA | UnifiableB>
 * // Results in a properly unified type
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export type Unify<A> = Values<
  ExtractTypes<
    (
      & FilterIn<A>
      & { [typeSymbol]: A }
    )
  >
> extends infer Z ? Z | Exclude<A, Z> | FilterOut<A> : never

/**
 * Unifies the return type of a function or value.
 *
 * This function applies type unification to the result of a function or to a value directly.
 * It's useful when you need to ensure that complex type unions are properly unified according
 * to the Effect type system's unification protocol.
 *
 * @example
 * ```ts
 * import { Unify } from "effect"
 *
 * // Unify a simple value
 * const unifiedValue = Unify.unify("hello")
 * // Type: string
 *
 * // Unify a function result
 * const createUnifiableValue = () => ({
 *   value: "test",
 *   [Unify.typeSymbol]: "string" as const,
 *   [Unify.unifySymbol]: { String: () => "test" as const }
 * })
 *
 * const unifiedFunction = Unify.unify(createUnifiableValue)
 * // The result will be properly unified
 *
 * // Unify with curried functions
 * const curriedFunction = (a: string) => (b: number) => ({ result: a + b })
 * const unifiedCurried = Unify.unify(curriedFunction)
 * // Type: (a: string) => (b: number) => Unify<{ result: string }>
 * ```
 *
 * @since 2.0.0
 * @category utilities
 */
export const unify: {
  <
    Args extends Array<any>,
    Args2 extends Array<any>,
    Args3 extends Array<any>,
    Args4 extends Array<any>,
    Args5 extends Array<any>,
    T
  >(
    x: (...args: Args) => (...args: Args2) => (...args: Args3) => (...args: Args4) => (...args: Args5) => T
  ): (...args: Args) => (...args: Args2) => (...args: Args3) => (...args: Args4) => (...args: Args5) => Unify<T>
  <
    Args extends Array<any>,
    Args2 extends Array<any>,
    Args3 extends Array<any>,
    Args4 extends Array<any>,
    T
  >(
    x: (...args: Args) => (...args: Args2) => (...args: Args3) => (...args: Args4) => T
  ): (...args: Args) => (...args: Args2) => (...args: Args3) => (...args: Args4) => Unify<T>
  <
    Args extends Array<any>,
    Args2 extends Array<any>,
    Args3 extends Array<any>,
    T
  >(
    x: (...args: Args) => (...args: Args2) => (...args: Args3) => T
  ): (...args: Args) => (...args: Args2) => (...args: Args3) => Unify<T>
  <
    Args extends Array<any>,
    Args2 extends Array<any>,
    T
  >(
    x: (...args: Args) => (...args: Args2) => T
  ): (...args: Args) => (...args: Args2) => Unify<T>
  <
    Args extends Array<any>,
    T
  >(x: (...args: Args) => T): (...args: Args) => Unify<T>
  <T>(x: T): Unify<T>
} = identity as any

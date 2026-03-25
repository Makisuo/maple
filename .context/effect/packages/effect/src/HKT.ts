/**
 * This module provides utilities for Higher-Kinded Types (HKT) in TypeScript.
 *
 * Higher-Kinded Types are types that take other types as parameters, similar to how
 * functions take values as parameters. They enable generic programming over type
 * constructors, allowing you to write code that works with any container type
 * (like Array, Option, Effect, etc.) in a uniform way.
 *
 * The HKT system in Effect uses TypeLambdas to encode type-level functions that
 * can represent complex type relationships with multiple type parameters, including
 * contravariant, covariant, and invariant positions.
 *
 * @example
 * ```ts
 * import type { HKT } from "effect"
 *
 * // Define a TypeLambda for Array
 * interface ArrayTypeLambda extends HKT.TypeLambda {
 *   readonly type: Array<this["Target"]>
 * }
 *
 * // Use Kind to get the concrete type
 * type MyArray = HKT.Kind<ArrayTypeLambda, never, never, never, string>
 * // MyArray is Array<string>
 *
 * // Define a TypeClass that works with any HKT
 * interface Functor<F extends HKT.TypeLambda> extends HKT.TypeClass<F> {
 *   map<A, B>(
 *     fa: HKT.Kind<F, never, never, never, A>,
 *     f: (a: A) => B
 *   ): HKT.Kind<F, never, never, never, B>
 * }
 * ```
 *
 * @since 2.0.0
 */
import type * as Types from "./Types.ts"

/**
 * A unique symbol used to identify TypeClass implementations.
 *
 * This symbol is used internally by the HKT system to associate type classes
 * with their corresponding TypeLambda. It provides a way to link runtime
 * type class instances with their compile-time type information.
 *
 * @example
 * ```ts
 * import type { HKT } from "effect"
 *
 * interface MyTypeClass<F extends HKT.TypeLambda> extends HKT.TypeClass<F> {
 *   // TypeClass methods here
 * }
 *
 * // The URI symbol helps TypeScript understand the relationship
 * // between the type class and its type lambda
 * ```
 *
 * @since 2.0.0
 * @category symbols
 */
export declare const URI: unique symbol

/**
 * Base interface for type classes that work with Higher-Kinded Types.
 *
 * A TypeClass defines operations that can be performed on any type constructor
 * that matches the given TypeLambda. This enables writing generic code that
 * works across different container types like Array, Option, Effect, etc.
 *
 * @example
 * ```ts
 * import type { HKT } from "effect"
 *
 * // Define a Functor type class
 * interface Functor<F extends HKT.TypeLambda> extends HKT.TypeClass<F> {
 *   map<A, B>(
 *     fa: HKT.Kind<F, never, never, never, A>,
 *     f: (a: A) => B
 *   ): HKT.Kind<F, never, never, never, B>
 * }
 *
 * // Define a Monad type class
 * interface Monad<F extends HKT.TypeLambda> extends Functor<F> {
 *   flatMap<A, B>(
 *     fa: HKT.Kind<F, never, never, never, A>,
 *     f: (a: A) => HKT.Kind<F, never, never, never, B>
 *   ): HKT.Kind<F, never, never, never, B>
 * }
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface TypeClass<F extends TypeLambda> {
  readonly [URI]?: F
}

/**
 * Base interface for defining Higher-Kinded Type parameters.
 *
 * A TypeLambda encodes the "shape" of a type constructor, specifying how many
 * type parameters it takes and their variance (contravariant, covariant, or invariant).
 * This allows representing complex types like `Effect<A, E, R>` in a uniform way.
 *
 * The four parameters represent:
 * - `In`: Contravariant input parameter
 * - `Out2`: Covariant output parameter (often used for errors)
 * - `Out1`: Covariant output parameter (often used for context/environment)
 * - `Target`: Invariant target parameter (the main type)
 *
 * @example
 * ```ts
 * import type { Effect, HKT } from "effect"
 *
 * // TypeLambda for Array<A>
 * interface ArrayTypeLambda extends HKT.TypeLambda {
 *   readonly type: Array<this["Target"]>
 * }
 *
 * // TypeLambda for Effect<A, E, R>
 * interface EffectTypeLambda extends HKT.TypeLambda {
 *   readonly type: Effect.Effect<this["Target"], this["Out2"], this["Out1"]>
 * }
 *
 * // TypeLambda for function (A) => B
 * interface FunctionTypeLambda extends HKT.TypeLambda {
 *   readonly type: (a: this["In"]) => this["Target"]
 * }
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface TypeLambda {
  readonly In: unknown
  readonly Out2: unknown
  readonly Out1: unknown
  readonly Target: unknown
}

/**
 * Applies type parameters to a TypeLambda to get the concrete type.
 *
 * This type-level function takes a TypeLambda and four type parameters,
 * then "applies" them to get the actual type. It handles the variance
 * correctly, ensuring contravariant parameters are used as inputs and
 * covariant parameters as outputs.
 *
 * This is the core mechanism that allows HKT to work - it transforms
 * abstract type constructors into concrete types by applying arguments.
 *
 * @example
 * ```ts
 * import type { Effect, HKT, Option } from "effect"
 *
 * // Define TypeLambdas
 * interface OptionTypeLambda extends HKT.TypeLambda {
 *   readonly type: Option.Option<this["Target"]>
 * }
 *
 * interface EffectTypeLambda extends HKT.TypeLambda {
 *   readonly type: Effect.Effect<this["Target"], this["Out2"], this["Out1"]>
 * }
 *
 * // Apply type parameters to get concrete types
 * type OptionString = HKT.Kind<OptionTypeLambda, never, never, never, string>
 * // Result: Option.Option<string>
 *
 * type EffectStringNumberBoolean = HKT.Kind<
 *   EffectTypeLambda,
 *   never,
 *   number,
 *   boolean,
 *   string
 * >
 * // Result: Effect.Effect<string, number, boolean>
 *
 * // TypeLambdas enable generic programming over type constructors
 * type StringType<F extends HKT.TypeLambda> = HKT.Kind<
 *   F,
 *   never,
 *   never,
 *   never,
 *   string
 * >
 * ```
 *
 * @since 2.0.0
 * @category type utils
 */
export type Kind<F extends TypeLambda, In, Out2, Out1, Target> = F extends {
  readonly type: unknown
} ? (F & {
    readonly In: In
    readonly Out2: Out2
    readonly Out1: Out1
    readonly Target: Target
  })["type"]
  : {
    readonly F: F
    readonly In: Types.Contravariant<In>
    readonly Out2: Types.Covariant<Out2>
    readonly Out1: Types.Covariant<Out1>
    readonly Target: Types.Invariant<Target>
  }

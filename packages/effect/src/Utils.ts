/**
 * Internal utilities for the Effect ecosystem's generator-based syntax and
 * higher-kinded type machinery.
 *
 * ## Mental model
 *
 * - **SingleShotGen** — an `IterableIterator` wrapper that yields its value
 *   exactly once. Used internally by `[Symbol.iterator]()` on Effect, Option,
 *   Result, and other yieldable types so they work inside generator functions.
 * - **Gen** — a type-level signature for generator-based monadic composition
 *   (`gen` functions). Parametric over any `TypeLambda` so each module
 *   (Effect, Option, Result, ...) can expose its own `gen` with correct types.
 * - **Variance** — a type-level marker that encodes the variance (covariant,
 *   contravariant, invariant) of a `TypeLambda`'s type parameters.
 *   Used by {@link Gen} for type inference.
 *
 * ## Common tasks
 *
 * - Make a type yieldable in generators -> implement `[Symbol.iterator]()` returning a {@link SingleShotGen}
 * - Define a generator-based API for a new TypeLambda -> type it as {@link Gen}`<MyTypeLambda>`
 * - Encode variance for a higher-kinded type -> use {@link Variance}
 *
 * ## Gotchas
 *
 * - {@link SingleShotGen} yields its value only on the first `.next()` call.
 *   Calling `.next()` again returns `{ done: true }`. Iterating the same
 *   instance twice will skip the value on the second pass; call
 *   `[Symbol.iterator]()` to get a fresh iterator.
 * - {@link Gen} and {@link Variance} are pure type-level constructs — they
 *   have no runtime representation.
 *
 * ## Quickstart
 *
 * **Example** (Using SingleShotGen to make a type yieldable)
 *
 * ```ts
 * import { Utils } from "effect"
 *
 * class MyWrapper<A> {
 *   constructor(readonly value: A) {}
 *   [Symbol.iterator]() {
 *     return new Utils.SingleShotGen<MyWrapper<A>, A>(this)
 *   }
 * }
 *
 * const w = new MyWrapper(42)
 * const iter = w[Symbol.iterator]()
 * console.log(iter.next(undefined as any))
 * // { value: MyWrapper { value: 42 }, done: false }
 * console.log(iter.next(42))
 * // { value: 42, done: true }
 * ```
 *
 * @see {@link SingleShotGen}
 * @see {@link Gen}
 * @see {@link Variance}
 *
 * @since 2.0.0
 */
import type { Kind, TypeLambda } from "./HKT.ts"
import type * as Types from "./Types.ts"

/**
 * An `IterableIterator` that yields its wrapped value exactly once.
 *
 * When to use:
 *
 * - Implement `[Symbol.iterator]()` on Effect-like types so they can be
 *   `yield*`-ed inside generator functions (e.g. `Effect.gen`, `Option.gen`).
 * - You almost never construct this directly — it is created internally by
 *   yieldable types.
 *
 * Behavior:
 *
 * - The first call to `next()` returns `{ value: self, done: false }`.
 * - Every subsequent call returns `{ value: a, done: true }` where `a` is
 *   the argument passed to `next()`.
 * - `[Symbol.iterator]()` returns a **new** `SingleShotGen` wrapping the same
 *   value, so the outer type can be iterated multiple times.
 * - Does not mutate the wrapped value.
 *
 * **Example** (Yielding a wrapped value in a generator)
 *
 * ```ts
 * import { Utils } from "effect"
 *
 * const gen = new Utils.SingleShotGen<string, number>("hello")
 *
 * // First call yields the wrapped value
 * console.log(gen.next(0))
 * // { value: "hello", done: false }
 *
 * // Second call signals completion with the provided value
 * console.log(gen.next(42))
 * // { value: 42, done: true }
 * ```
 *
 * @see {@link Gen} — the type-level signature that relies on `SingleShotGen`
 *
 * @category constructors
 * @since 2.0.0
 */
export class SingleShotGen<T, A> implements IterableIterator<T, A> {
  private called = false
  readonly self: T

  constructor(self: T) {
    this.self = self
  }

  /**
   * @since 2.0.0
   */
  next(a: A): IteratorResult<T, A> {
    return this.called ?
      ({
        value: a,
        done: true
      }) :
      (this.called = true,
        ({
          value: this.self,
          done: false
        }))
  }

  /**
   * @since 2.0.0
   */
  [Symbol.iterator](): IterableIterator<T, A> {
    return new SingleShotGen<T, A>(this.self)
  }
}

/**
 * Type-level marker encoding the variance of a `TypeLambda`'s type
 * parameters.
 *
 * When to use:
 *
 * - Define variance constraints for a higher-kinded type so that
 *   {@link Gen} can correctly infer `R`, `O`, and `E` from yielded values.
 * - You typically don't construct values of this type — it exists purely for
 *   type inference.
 *
 * Behavior:
 *
 * - `F` is invariant (must match exactly).
 * - `R` is contravariant (input / environment position).
 * - `O` and `E` are covariant (output / error position).
 * - Pure type-level construct — no runtime representation.
 *
 * **Example** (Declaring variance for a TypeLambda)
 *
 * ```ts
 * import type { Utils } from "effect"
 * import type * as Option from "effect/Option"
 *
 * declare const variance: Utils.Variance<
 *   Option.OptionTypeLambda,
 *   never,
 *   never,
 *   never
 * >
 * ```
 *
 * @see {@link Gen} — uses `Variance` for type parameter inference
 *
 * @category models
 * @since 2.0.0
 */
export interface Variance<in out F extends TypeLambda, in R, out O, out E> {
  readonly _F: Types.Invariant<F>
  readonly _R: Types.Contravariant<R>
  readonly _O: Types.Covariant<O>
  readonly _E: Types.Covariant<E>
}

/**
 * Type-level signature for generator-based monadic composition over any
 * `TypeLambda`.
 *
 * When to use:
 *
 * - Type the `gen` function of a module that supports generator syntax
 *   (e.g. `Option.gen`, `Result.gen`, `Effect.gen`).
 * - Accepts either `(body)` or `(self, body)` where `body` is a generator
 *   function. The `self` overload binds `this` inside the generator.
 *
 * Behavior:
 *
 * - Pure type alias — no runtime behavior.
 * - Infers `R`, `O`, `E` from the yielded values via {@link Variance} or
 *   `Kind` constraints.
 * - The generator's return type `A` becomes the output's `A` parameter.
 *
 * **Example** (Typing a gen function for Option)
 *
 * ```ts
 * import type { Option, Utils } from "effect"
 *
 * declare const gen: Utils.Gen<Option.OptionTypeLambda>
 * ```
 *
 * @see {@link Variance} — encodes the variance used for inference
 * @see {@link SingleShotGen} — the iterator protocol that makes yielding work
 *
 * @category models
 * @since 2.0.0
 */
export type Gen<F extends TypeLambda> = <
  Self,
  K extends Variance<F, any, any, any> | Kind<F, any, any, any, any>,
  A
>(
  ...args:
    | [
      self: Self,
      body: (this: Self) => Generator<K, A, never>
    ]
    | [
      body: () => Generator<K, A, never>
    ]
) => Kind<
  F,
  [K] extends [Variance<F, infer R, any, any>] ? R
    : [K] extends [Kind<F, infer R, any, any, any>] ? R
    : never,
  [K] extends [Variance<F, any, infer O, any>] ? O
    : [K] extends [Kind<F, any, infer O, any, any>] ? O
    : never,
  [K] extends [Variance<F, any, any, infer E>] ? E
    : [K] extends [Kind<F, any, any, infer E, any>] ? E
    : never,
  A
>

const InternalTypeId = "~effect/Utils/internal"

const standard = {
  [InternalTypeId]: <A>(body: () => A) => {
    return body()
  }
}

const forced = {
  [InternalTypeId]: <A>(body: () => A) => {
    try {
      return body()
    } finally {
      //
    }
  }
}

const isNotOptimizedAway = standard[InternalTypeId](() => new Error().stack)?.includes(InternalTypeId) === true

/** @internal */
export const internalCall = isNotOptimizedAway ? standard[InternalTypeId] : forced[InternalTypeId]

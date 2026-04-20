/**
 * @since 2.0.0
 */
import type { NonEmptyReadonlyArray } from "./Array.ts"
import * as Arr from "./Array.ts"
import * as Cause from "./Cause.ts"
import * as Channel from "./Channel.ts"
import * as Clock from "./Clock.ts"
import type * as Context from "./Context.ts"
import * as Duration from "./Duration.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import type * as Filter from "./Filter.ts"
import type { LazyArg } from "./Function.ts"
import { constant, constFalse, constTrue, constVoid, dual, identity, pipe } from "./Function.ts"
import * as internalStream from "./internal/stream.ts"
import * as Option from "./Option.ts"
import { type Pipeable, pipeArguments } from "./Pipeable.ts"
import type { Predicate, Refinement } from "./Predicate.ts"
import { hasProperty } from "./Predicate.ts"
import * as PubSub from "./PubSub.ts"
import * as Pull from "./Pull.ts"
import * as Queue from "./Queue.ts"
import * as Result from "./Result.ts"
import * as Scope from "./Scope.ts"
import type { Stream } from "./Stream.ts"
import type * as Types from "./Types.ts"
import type * as Unify from "./Unify.ts"

const TypeId = "~effect/Sink"

/**
 * A `Sink<A, In, L, E, R>` is used to consume elements produced by a `Stream`.
 * You can think of a sink as a function that will consume a variable amount of
 * `In` elements (could be 0, 1, or many), might fail with an error of type `E`,
 * and will eventually yield a value of type `A` together with a remainder of
 * type `L` (i.e. any leftovers).
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import * as Sink from "effect/Sink"
 * import * as Stream from "effect/Stream"
 *
 * // Create a simple sink that always succeeds with a value
 * const sink: Sink.Sink<number> = Sink.succeed(42)
 *
 * // Use the sink to consume a stream
 * const stream = Stream.make(1, 2, 3)
 * const program = Stream.run(stream, sink)
 *
 * Effect.runPromise(program).then(console.log)
 * // Output: 42
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface Sink<out A, in In = unknown, out L = never, out E = never, out R = never>
  extends Sink.Variance<A, In, L, E, R>, Pipeable
{
  readonly transform: (
    upstream: Pull.Pull<NonEmptyReadonlyArray<In>, never, void>,
    scope: Scope.Scope
  ) => Effect.Effect<End<A, L>, E, R>
  [Unify.typeSymbol]?: unknown
  [Unify.unifySymbol]?: SinkUnify<this>
  [Unify.ignoreSymbol]?: SinkUnifyIgnore
}

/**
 * @since 2.0.0
 * @category models
 */
export type End<A, L = never> = readonly [value: A, leftover?: NonEmptyReadonlyArray<L> | undefined]

const endVoid = Effect.succeed([void 0] as End<void, never>)

/**
 * Interface for Sink unification, used internally by the Effect type system
 * to provide proper type inference when using Sink with other Effect types.
 *
 * @example
 * ```ts
 * import type { Effect } from "effect"
 * import type * as Sink from "effect/Sink"
 * import type * as Unify from "effect/Unify"
 *
 * // SinkUnify helps unify Sink and Effect types
 * declare const sink: Sink.Sink<number>
 * declare const effect: Effect.Effect<string>
 *
 * // The unification system handles mixed operations
 * type Combined = Sink.SinkUnify<{ [Unify.typeSymbol]?: any }>
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface SinkUnify<A extends { [Unify.typeSymbol]?: any }> extends Effect.EffectUnify<A> {
  Sink?: () => A[Unify.typeSymbol] extends
    | Sink<
      infer A,
      infer In,
      infer L,
      infer E,
      infer R
    >
    | infer _ ? Sink<A, In, L, E, R>
    : never
}

/**
 * Interface used to ignore certain types during Sink unification.
 * Part of the internal type system machinery.
 *
 * @example
 * ```ts
 * import type * as Sink from "effect/Sink"
 *
 * // Used internally by the type system
 * type IgnoreConfig = Sink.SinkUnifyIgnore
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface SinkUnifyIgnore {
  Effect?: true
}

/**
 * Namespace containing types and interfaces for Sink variance and type relationships.
 *
 * @example
 * ```ts
 * import type * as Sink from "effect/Sink"
 *
 * // The Sink namespace contains internal type definitions
 * // These are used internally for type safety and variance
 * type SinkType<A, In, L, E, R> = Sink.Sink<A, In, L, E, R>
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export declare namespace Sink {
  /**
   * Represents the variance annotations for a Sink type.
   * Used internally to track how type parameters flow through the Sink.
   *
   * @example
   * ```ts
   * import type * as Sink from "effect/Sink"
   *
   * // The variance interface is used internally
   * // It defines how type parameters behave in Sink
   * type SinkWithVariance = Sink.Sink<string> & { variance: "internal" }
   * ```
   *
   * @since 2.0.0
   * @category models
   */
  export interface Variance<out A, in In, out L, out E, out R> {
    readonly [TypeId]: VarianceStruct<A, In, L, E, R>
  }
  /**
   * The internal structure representing Sink variance annotations.
   * Contains the actual variance markers for each type parameter.
   *
   * @example
   * ```ts
   * import type * as Sink from "effect/Sink"
   *
   * // The variance structure is used internally by the type system
   * // It ensures proper type safety for Sink operations
   * type SinkInstance = Sink.Sink<number, string>
   * ```
   *
   * @since 2.0.0
   * @category models
   */
  export interface VarianceStruct<out A, in In, out L, out E, out R> {
    _A: Types.Covariant<A>
    _In: Types.Contravariant<In>
    _L: Types.Covariant<L>
    _E: Types.Covariant<E>
    _R: Types.Covariant<R>
  }
}

const sinkVariance = {
  _A: identity,
  _In: identity,
  _L: identity,
  _E: identity,
  _R: identity
}

const SinkProto = {
  [TypeId]: sinkVariance,
  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * Checks if a value is a Sink.
 *
 * @example
 * ```ts
 * import { Sink } from "effect"
 *
 * const sink = Sink.never
 * const notStream = { data: [1, 2, 3] }
 *
 * console.log(Sink.isSink(sink)) // true
 * console.log(Sink.isSink(notStream)) // false
 * ```
 *
 * @since 2.0.0
 * @category guards
 */
export const isSink = (u: unknown): u is Sink<unknown, never, unknown, unknown, unknown> => hasProperty(u, TypeId)

/**
 * Creates a sink from a `Channel`.
 *
 * @since 2.0.0
 * @category constructors
 */
export const fromChannel = <L, In, E, A, R>(
  channel: Channel.Channel<
    never,
    E,
    End<A, L>,
    NonEmptyReadonlyArray<In>,
    never,
    void,
    R
  >
): Sink<A, In, L, E, R> =>
  fromTransform((upstream, scope) =>
    Channel.toTransform(channel)(upstream, scope).pipe(
      Effect.flatMap(Effect.forever({ disableYield: true })),
      Pull.catchDone(Effect.succeed)
    ) as Effect.Effect<End<A, L>, E, R>
  )

/**
 * @since 4.0.0
 * @category constructors
 */
export const fromTransform = <In, A, E, R, L = never>(
  transform: (
    upstream: Pull.Pull<NonEmptyReadonlyArray<In>, never, void>,
    scope: Scope.Scope
  ) => Effect.Effect<End<A, L>, E, R>
): Sink<A, In, L, E, R> => {
  const self = Object.create(SinkProto)
  self.transform = transform
  return self
}

/**
 * Creates a `Channel` from a Sink.
 *
 * @example
 * ```ts
 * import { Sink } from "effect"
 *
 * // Create a sink and extract its channel
 * const sink = Sink.succeed(42)
 * const channel = Sink.toChannel(sink)
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const toChannel = <A, In, L, E, R>(
  self: Sink<A, In, L, E, R>
): Channel.Channel<never, E, End<A, L>, NonEmptyReadonlyArray<In>, never, void, R> =>
  Channel.fromTransform((upstream, scope) =>
    Effect.succeed(Effect.flatMap(
      self.transform(upstream, scope),
      Cause.done
    ))
  )

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = <In>(): make.Constructor<In> => (...fns: []) =>
  fromTransform((upstream, scope) =>
    pipe(
      internalStream.fromChannel(Channel.fromPull(Effect.succeed(upstream))),
      ...fns as any as [() => Effect.Effect<any>],
      Effect.flatMap((a) => Cause.done<End<any>>([a])),
      Scope.provide(scope)
    )
  )

/**
 * @since 4.0.0
 */
export declare namespace make {
  /**
   * @since 4.0.0
   */
  export interface Constructor<In> {
    <E, R, B = never>(ab: (_: Stream<In>) => Effect.Effect<B, E, R>): Sink<B, In, never, E, Exclude<R, Scope.Scope>>
    <E, R, B = never, C = never>(
      ab: (_: Stream<In>) => B,
      bc: (_: B) => Effect.Effect<C, E, R>
    ): Sink<C, In, never, E, Exclude<R, Scope.Scope>>
    <E, R, B = never, C = never, D = never>(
      ab: (_: Stream<In>) => B,
      bc: (_: B) => C,
      cd: (_: C) => Effect.Effect<D, E, R>
    ): Sink<D, In, never, E, Exclude<R, Scope.Scope>>
    <E, R, B = never, C = never, D = never, F = never>(
      ab: (_: Stream<In>) => B,
      bc: (_: B) => C,
      cd: (_: C) => D,
      df: (_: D) => Effect.Effect<F, E, R>
    ): Sink<F, In, never, E, Exclude<R, Scope.Scope>>
    <E, R, B = never, C = never, D = never, F = never, G = never>(
      ab: (_: Stream<In>) => B,
      bc: (_: B) => C,
      cd: (_: C) => D,
      df: (_: D) => F,
      fg: (_: F) => Effect.Effect<G, E, R>
    ): Sink<G, In, never, E, Exclude<R, Scope.Scope>>
    <E, R, B = never, C = never, D = never, F = never, G = never, H = never>(
      ab: (_: Stream<In>) => B,
      bc: (_: B) => C,
      cd: (_: C) => D,
      df: (_: D) => F,
      fg: (_: F) => G,
      gh: (_: G) => Effect.Effect<H, E, R>
    ): Sink<H, In, never, E, Exclude<R, Scope.Scope>>
    <E, R, B = never, C = never, D = never, F = never, G = never, H = never, I = never>(
      ab: (_: Stream<In>) => B,
      bc: (_: B) => C,
      cd: (_: C) => D,
      df: (_: D) => F,
      fg: (_: F) => G,
      gh: (_: G) => H,
      hi: (_: H) => Effect.Effect<I, E, R>
    ): Sink<I, In, never, E, Exclude<R, Scope.Scope>>
    <E, R, B = never, C = never, D = never, F = never, G = never, H = never, I = never, J = never>(
      ab: (_: Stream<In>) => B,
      bc: (_: B) => C,
      cd: (_: C) => D,
      df: (_: D) => F,
      fg: (_: F) => G,
      gh: (_: G) => H,
      hi: (_: H) => I,
      ij: (_: I) => Effect.Effect<J, E, R>
    ): Sink<J, In, never, E, Exclude<R, Scope.Scope>>
    <E, R, B = never, C = never, D = never, F = never, G = never, H = never, I = never, J = never, K = never>(
      ab: (_: Stream<In>) => B,
      bc: (_: B) => C,
      cd: (_: C) => D,
      df: (_: D) => F,
      fg: (_: F) => G,
      gh: (_: G) => H,
      hi: (_: H) => I,
      ij: (_: I) => J,
      jk: (_: J) => Effect.Effect<K, E, R>
    ): Sink<K, In, never, E, Exclude<R, Scope.Scope>>
    <
      E,
      R,
      B = never,
      C = never,
      D = never,
      F = never,
      G = never,
      H = never,
      I = never,
      J = never,
      K = never,
      L = never
    >(
      ab: (_: Stream<In>) => B,
      bc: (_: B) => C,
      cd: (_: C) => D,
      df: (_: D) => F,
      fg: (_: F) => G,
      gh: (_: G) => H,
      hi: (_: H) => I,
      ij: (_: I) => J,
      jk: (_: J) => K,
      kl: (_: K) => Effect.Effect<L, E, R>
    ): Sink<L, In, never, E, Exclude<R, Scope.Scope>>
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const fromEffectEnd = <A, E, R, L = never>(
  effect: Effect.Effect<End<A, L>, E, R>
): Sink<A, unknown, L, E, R> => fromTransform(() => effect)

/**
 * @since 4.0.0
 * @category constructors
 */
export const fromEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Sink<A, unknown, never, E, R> => fromEffectEnd(Effect.map(effect, (a) => [a]))

/**
 * @since 2.0.0
 * @category constructors
 */
export const fromQueue = <A>(
  queue: Queue.Queue<A, Cause.Done>
): Sink<void, A> =>
  fromTransform((upstream) =>
    upstream.pipe(
      Effect.flatMap((arr) => Queue.offerAll(queue, arr)),
      Effect.forever({ disableYield: true }),
      Pull.catchDone((_) => {
        Queue.endUnsafe(queue)
        return endVoid
      })
    )
  )

/**
 * @since 2.0.0
 * @category constructors
 */
export const fromPubSub = <A>(
  pubsub: PubSub.PubSub<A>
): Sink<void, A> => forEachArray((arr) => PubSub.publishAll(pubsub, arr))

/**
 * A sink that immediately ends with the specified value.
 *
 * @example
 * ```ts
 * import { Effect, Sink, Stream } from "effect"
 *
 * // Create a sink that always yields the same value
 * const sink = Sink.succeed(42)
 *
 * // Use it with a stream
 * const stream = Stream.make(1, 2, 3)
 * const program = Stream.run(stream, sink)
 *
 * Effect.runPromise(program).then(console.log)
 * // Output: 42
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const succeed = <A, L = never>(a: A, leftovers?: NonEmptyReadonlyArray<L> | undefined): Sink<A, unknown, L> =>
  fromEffectEnd(Effect.succeed([a, leftovers]))

/**
 * A sink that immediately ends with the specified lazily evaluated value.
 *
 * @since 2.0.0
 * @category constructors
 */
export const sync = <A>(a: LazyArg<A>): Sink<A> => fromEffect(Effect.sync(a))

/**
 * A sink that is created from a lazily evaluated sink.
 *
 * @since 2.0.0
 * @category constructors
 */
export const suspend = <A, In, L, E, R>(evaluate: LazyArg<Sink<A, In, L, E, R>>): Sink<A, In, L, E, R> =>
  fromTransform((upstream, scope) => evaluate().transform(upstream, scope))

/**
 * A sink that always fails with the specified error.
 *
 * @example
 * ```ts
 * import { Effect, Sink, Stream } from "effect"
 *
 * // Create a sink that always fails
 * const sink = Sink.fail(new Error("Sink failed"))
 *
 * // Use it with a stream
 * const stream = Stream.make(1, 2, 3)
 * const program = Stream.run(stream, sink)
 *
 * Effect.runPromise(program).catch(console.log)
 * // Output: Error: Sink failed
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const fail = <E>(e: E): Sink<never, unknown, never, E> => fromEffectEnd(Effect.fail(e))

/**
 * A sink that always fails with the specified lazily evaluated error.
 *
 * @example
 * ```ts
 * import { Effect, Sink, Stream } from "effect"
 *
 * // Create a sink that fails with a lazy error
 * const sink = Sink.failSync(() => new Error("Lazy error"))
 *
 * // Use it with a stream
 * const stream = Stream.make(1, 2, 3)
 * const program = Stream.run(stream, sink)
 *
 * Effect.runPromise(program).catch(console.log)
 * // Output: Error: Lazy error
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const failSync = <E>(evaluate: LazyArg<E>): Sink<never, unknown, never, E> =>
  fromEffectEnd(Effect.failSync(evaluate))

/**
 * Creates a sink halting with a specified `Cause`.
 *
 * @example
 * ```ts
 * import { Cause, Effect, Sink, Stream } from "effect"
 *
 * // Create a sink that fails with a specific cause
 * const sink = Sink.failCause(Cause.fail(new Error("Custom cause")))
 *
 * // Use it with a stream
 * const stream = Stream.make(1, 2, 3)
 * const program = Stream.run(stream, sink)
 *
 * Effect.runPromise(program).catch(console.log)
 * // Output: Error: Custom cause
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const failCause = <E>(cause: Cause.Cause<E>): Sink<never, unknown, never, E> =>
  fromEffectEnd(Effect.failCause(cause))

/**
 * Creates a sink halting with a specified lazily evaluated `Cause`.
 *
 * @example
 * ```ts
 * import { Cause, Effect, Sink, Stream } from "effect"
 *
 * // Create a sink that fails with a lazy cause
 * const sink = Sink.failCauseSync(() => Cause.fail(new Error("Lazy cause")))
 *
 * // Use it with a stream
 * const stream = Stream.make(1, 2, 3)
 * const program = Stream.run(stream, sink)
 *
 * Effect.runPromise(program).catch(console.log)
 * // Output: Error: Lazy cause
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const failCauseSync = <E>(evaluate: LazyArg<Cause.Cause<E>>): Sink<never, unknown, never, E> =>
  fromEffectEnd(Effect.failCauseSync(evaluate))

/**
 * Creates a sink halting with a specified defect.
 *
 * @example
 * ```ts
 * import { Effect, Sink, Stream } from "effect"
 *
 * // Create a sink that dies with a defect
 * const sink = Sink.die(new Error("Defect error"))
 *
 * // Use it with a stream
 * const stream = Stream.make(1, 2, 3)
 * const program = Stream.run(stream, sink)
 *
 * Effect.runPromise(program).catch(console.log)
 * // Output: Error: Defect error
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const die = (defect: unknown): Sink<never> => fromEffectEnd(Effect.die(defect))

/**
 * A sink that never completes.
 *
 * @since 2.0.0
 * @category constructors
 */
export const never: Sink<unknown> = fromEffectEnd(Effect.never)

/**
 * Drains the remaining elements from the stream after the sink finishes
 *
 * @since 2.0.0
 * @category utils
 */
export const ignoreLeftover = <A, In, L, E, R>(self: Sink<A, In, L, E, R>): Sink<A, In, never, E, R> =>
  mapEnd(self, ([a]) => [a])

/**
 * Drains elements from the stream by ignoring all inputs.
 *
 * @since 2.0.0
 * @category constructors
 */
export const drain: Sink<void, unknown> = fromTransform((upstream) =>
  Pull.catchDone(
    Effect.forever(upstream, { disableYield: true }),
    () => endVoid
  )
)

/**
 * A sink that folds its inputs with the provided function, termination
 * predicate and initial state.
 *
 * @since 2.0.0
 * @category folding
 */
export const fold = <S, In, E = never, R = never>(
  s: LazyArg<S>,
  contFn: Predicate<S>,
  f: (s: S, input: In) => Effect.Effect<S, E, R>
): Sink<S, In, In, E, R> =>
  fromTransform((upstream) => {
    let state = s()
    return Effect.gen(function*() {
      while (true) {
        const arr = yield* upstream
        for (let i = 0; i < arr.length; i++) {
          state = yield* f(state, arr[i])
          if (contFn(state)) continue
          return [
            state,
            (i + 1) < arr.length ? (arr.slice(i + 1) as any) : undefined
          ] as const
        }
      }
    }).pipe(
      Pull.catchDone(() => Effect.succeed<End<S, In>>([state]))
    )
  })

/**
 * @since 2.0.0
 * @category folding
 */
export const foldArray = <S, In, E = never, R = never>(
  s: LazyArg<S>,
  contFn: Predicate<S>,
  f: (s: S, input: Arr.NonEmptyReadonlyArray<In>) => Effect.Effect<S, E, R>
): Sink<S, In, never, E, R> =>
  fromTransform((upstream) => {
    let state = s()
    return Effect.gen(function*() {
      while (true) {
        const arr = yield* upstream
        state = yield* f(state, arr)
        if (contFn(state)) continue
        return [state] as const
      }
    }).pipe(
      Pull.catchDone(() => Effect.succeed<End<S>>([state]))
    )
  })

/**
 * @since 2.0.0
 * @category folding
 */
export const foldUntil = <S, In, E = never, R = never>(
  s: LazyArg<S>,
  max: number,
  f: (s: S, input: In) => Effect.Effect<S, E, R>
): Sink<S, In, In, E, R> =>
  fold<readonly [S, number], In, E, R>(
    () => [s(), 0],
    (tuple) => tuple[1] < max,
    ([output, count], input) => Effect.map(f(output, input), (s) => [s, count + 1] as const)
  ).pipe(
    map((tuple) => tuple[0])
  )

/**
 * A sink that returns whether all elements satisfy the specified predicate.
 *
 * @since 2.0.0
 * @category constructors
 */
export const every = <In>(predicate: Predicate<In>): Sink<boolean, In, In> =>
  fold(
    constTrue,
    identity,
    (_, a) => Effect.succeed(predicate(a))
  )

/**
 * A sink that returns whether an element satisfies the specified predicate.
 *
 * @since 2.0.0
 * @category constructors
 */
export const some = <In>(predicate: Predicate<In>): Sink<boolean, In, In> =>
  fold(
    constFalse,
    (b) => !b,
    (_, a) => Effect.succeed(predicate(a))
  )

/**
 * Transforms this sink's result.
 *
 * @since 2.0.0
 * @category mapping
 */
export const map: {
  <A, A2>(f: (a: A) => A2): <In, L, E, R>(self: Sink<A, In, L, E, R>) => Sink<A2, In, L, E, R>
  <A, In, L, E, R, A2>(self: Sink<A, In, L, E, R>, f: (a: A) => A2): Sink<A2, In, L, E, R>
} = dual(
  2,
  <A, In, L, E, R, A2>(self: Sink<A, In, L, E, R>, f: (a: A) => A2): Sink<A2, In, L, E, R> =>
    mapEnd(self, ([a, l]) => [f(a), l])
)

/**
 * Set the sink's result to a constant value.
 *
 * @since 2.0.0
 * @category mapping
 */
export const as: {
  <A2>(a2: A2): <A, In, L, E, R>(self: Sink<A, In, L, E, R>) => Sink<A2, In, L, E, R>
  <A, In, L, E, R, A2>(self: Sink<A, In, L, E, R>, a2: A2): Sink<A2, In, L, E, R>
} = dual(
  2,
  <A, In, L, E, R, A2>(self: Sink<A, In, L, E, R>, a2: A2): Sink<A2, In, L, E, R> => map(self, () => a2)
)

/**
 * Transforms this sink's input elements.
 *
 * @since 2.0.0
 * @category mapping
 */
export const mapInput: {
  <In0, In>(f: (input: In0) => In): <A, L, E, R>(self: Sink<A, In, L, E, R>) => Sink<A, In0, L, E, R>
  <A, In, L, E, R, In0>(self: Sink<A, In, L, E, R>, f: (input: In0) => In): Sink<A, In0, L, E, R>
} = dual(
  2,
  <A, In, L, E, R, In0>(self: Sink<A, In, L, E, R>, f: (input: In0) => In): Sink<A, In0, L, E, R> =>
    mapInputArray(self, Arr.map(f))
)

/**
 * Effectfully transforms this sink's input elements.
 *
 * @since 2.0.0
 * @category mapping
 */
export const mapInputEffect: {
  <In0, In, E2, R2>(
    f: (input: In0) => Effect.Effect<In, E2, R2>
  ): <A, L, E, R>(self: Sink<A, In, L, E, R>) => Sink<A, In0, L, E2 | E, R2 | R>
  <A, In, L, E, R, In0, E2, R2>(
    self: Sink<A, In, L, E, R>,
    f: (input: In0) => Effect.Effect<In, E2, R2>
  ): Sink<A, In0, L, E | E2, R | R2>
} = dual(
  2,
  <A, In, L, E, R, In0, E2, R2>(
    self: Sink<A, In, L, E, R>,
    f: (input: In0) => Effect.Effect<In, E2, R2>
  ): Sink<A, In0, L, E | E2, R | R2> => mapInputArrayEffect(self, Effect.forEach(f))
)

/**
 * Transforms this sink's input elements.
 *
 * @since 4.0.0
 * @category mapping
 */
export const mapInputArray: {
  <In0, In>(
    f: (input: Arr.NonEmptyReadonlyArray<In0>) => Arr.NonEmptyReadonlyArray<In>
  ): <A, L, E, R>(self: Sink<A, In, L, E, R>) => Sink<A, In0, L, E, R>
  <A, In, L, E, R, In0>(
    self: Sink<A, In, L, E, R>,
    f: (input: Arr.NonEmptyReadonlyArray<In0>) => Arr.NonEmptyReadonlyArray<In>
  ): Sink<A, In0, L, E, R>
} = dual(
  2,
  <A, In, L, E, R, In0>(
    self: Sink<A, In, L, E, R>,
    f: (input: Arr.NonEmptyReadonlyArray<In0>) => Arr.NonEmptyReadonlyArray<In>
  ): Sink<A, In0, L, E, R> => fromTransform((upstream, scope) => self.transform(Effect.map(upstream, f), scope))
)

/**
 * Effectfully transforms this sink's input elements.
 *
 * @since 4.0.0
 * @category mapping
 */
export const mapInputArrayEffect: {
  <In0, In, E2, R2>(
    f: (input: Arr.NonEmptyReadonlyArray<In0>) => Effect.Effect<Arr.NonEmptyReadonlyArray<In>, E2, R2>
  ): <A, L, E, R>(self: Sink<A, In, L, E, R>) => Sink<A, In0, L, E2 | E, R2 | R>
  <A, In, L, E, R, In0, E2, R2>(
    self: Sink<A, In, L, E, R>,
    f: (input: Arr.NonEmptyReadonlyArray<In0>) => Effect.Effect<Arr.NonEmptyReadonlyArray<In>, E2, R2>
  ): Sink<A, In0, L, E | E2, R | R2>
} = dual(
  2,
  <A, In, L, E, R, In0, E2, R2>(
    self: Sink<A, In, L, E, R>,
    f: (input: Arr.NonEmptyReadonlyArray<In0>) => Effect.Effect<Arr.NonEmptyReadonlyArray<In>, E2, R2>
  ): Sink<A, In0, L, E | E2, R | R2> =>
    fromTransform((upstream, scope) =>
      self.transform(
        Effect.flatMap(upstream, f) as any,
        scope
      )
    )
)

/**
 * Transforms this sink's result.
 *
 * @since 4.0.0
 * @category mapping
 */
export const mapEnd: {
  <A, L, A2, L2 = never>(
    f: (a: End<A, L>) => End<A2, L2>
  ): <In, E, R>(self: Sink<A, In, L, E, R>) => Sink<A2, In, L2, E, R>
  <A, In, L, E, R, A2, L2 = never>(self: Sink<A, In, L, E, R>, f: (a: End<A, L>) => End<A2, L2>): Sink<A2, In, L2, E, R>
} = dual(
  2,
  <A, In, L, E, R, A2, L2 = never>(
    self: Sink<A, In, L, E, R>,
    f: (a: End<A, L>) => End<A2, L2>
  ): Sink<A2, In, L2, E, R> =>
    fromTransform((upstream, scope) =>
      Effect.map(
        self.transform(upstream, scope),
        f
      )
    )
)

const transformEffect = <A, In, L, E, R, A2, E2, R2, L2 = never>(
  self: Sink<A, In, L, E, R>,
  f: (effect: Effect.Effect<End<A, L>, E, R>) => Effect.Effect<End<A2, L2>, E2, R2>
): Sink<A2, In, L2, E2, R2> => fromTransform((upstream, scope) => f(self.transform(upstream, scope)))

/**
 * Effectfully transforms this sink's result.
 *
 * @since 4.0.0
 * @category mapping
 */
export const mapEffectEnd: {
  <A, L, A2, E2, R2, L2 = never>(
    f: (end: End<A, L>) => Effect.Effect<End<A2, L2>, E2, R2>
  ): <In, E, R>(self: Sink<A, In, L, E, R>) => Sink<A2, In, L2, E2 | E, R2 | R>
  <A, In, L, E, R, A2, E2, R2, L2 = never>(
    self: Sink<A, In, L, E, R>,
    f: (end: End<A, L>) => Effect.Effect<End<A2, L2>, E2, R2>
  ): Sink<A2, In, L2, E | E2, R | R2>
} = dual(2, <A, In, L, E, R, A2, E2, R2, L2 = never>(
  self: Sink<A, In, L, E, R>,
  f: (end: End<A, L>) => Effect.Effect<End<A2, L2>, E2, R2>
): Sink<A2, In, L2, E | E2, R | R2> => transformEffect(self, Effect.flatMap(f)))

/**
 * Effectfully transforms this sink's result.
 *
 * @since 2.0.0
 * @category mapping
 */
export const mapEffect: {
  <A, A2, E2, R2>(
    f: (a: A) => Effect.Effect<A2, E2, R2>
  ): <In, L, E, R>(self: Sink<A, In, L, E, R>) => Sink<A2, In, L, E2 | E, R2 | R>
  <A, In, L, E, R, A2, E2, R2>(
    self: Sink<A, In, L, E, R>,
    f: (a: A) => Effect.Effect<A2, E2, R2>
  ): Sink<A2, In, L, E | E2, R | R2>
} = dual(2, <A, In, L, E, R, A2, E2, R2>(
  self: Sink<A, In, L, E, R>,
  f: (a: A) => Effect.Effect<A2, E2, R2>
): Sink<A2, In, L, E | E2, R | R2> => mapEffectEnd(self, ([a, l]) => Effect.map(f(a), (a2) => [a2, l] as End<A2, L>)))

/**
 * Transforms the errors emitted by this sink using `f`.
 *
 * @since 2.0.0
 * @category mapping
 */
export const mapError: {
  <E, E2>(f: (error: E) => E2): <A, In, L, R>(self: Sink<A, In, L, E, R>) => Sink<A, In, L, E2, R>
  <A, In, L, E, R, E2>(self: Sink<A, In, L, E, R>, f: (error: E) => E2): Sink<A, In, L, E2, R>
} = dual(2, <A, In, L, E, R, E2>(
  self: Sink<A, In, L, E, R>,
  f: (error: E) => E2
): Sink<A, In, L, E2, R> => transformEffect(self, Effect.mapError(f)))

/**
 * Transforms the leftovers emitted by this sink using `f`.
 *
 * @since 2.0.0
 * @category mapping
 */
export const mapLeftover: {
  <L, L2>(f: (leftover: L) => L2): <A, In, E, R>(self: Sink<A, In, L, E, R>) => Sink<A, In, L2, E, R>
  <A, In, L, E, R, L2>(self: Sink<A, In, L, E, R>, f: (leftover: L) => L2): Sink<A, In, L2, E, R>
} = dual(2, <A, In, L, E, R, L2>(
  self: Sink<A, In, L, E, R>,
  f: (leftover: L) => L2
): Sink<A, In, L2, E, R> => mapEnd(self, ([a, l]) => [a, l && Arr.map(l, f)]))

/**
 * @since 2.0.0
 * @category collecting
 */
export const take = <In>(n: number): Sink<Array<In>, In, In> =>
  fromTransform((upstream) => {
    const taken: Array<In> = []
    if (n <= 0) {
      return Effect.succeed([taken] as const)
    }
    let leftover: NonEmptyReadonlyArray<In> | undefined = undefined
    return upstream.pipe(
      Effect.flatMap((arr) => {
        if (taken.length + arr.length <= n) {
          taken.push(...arr)
          if (taken.length === n) {
            return Cause.done()
          }
          return Effect.void
        }
        for (let i = 0; i < arr.length; i++) {
          taken.push(arr[i])
          if (taken.length === n) {
            if ((i + 1) < arr.length) {
              leftover = arr.slice(i + 1) as any
            }
            return Cause.done()
          }
        }
        return Effect.void
      }),
      Effect.forever({ disableYield: true }),
      Pull.catchDone(() => Effect.succeed([taken, leftover] as const))
    )
  })

/**
 * Runs this sink until it yields a result, then uses that result to create
 * another sink from the provided function which will continue to run until it
 * yields a result.
 *
 * This function essentially runs sinks in sequence.
 *
 * @since 2.0.0
 * @category sequencing
 */
export const flatMap: {
  <A, A1, L, In1 extends L, L1, E1, R1>(
    f: (a: A) => Sink<A1, In1, L1, E1, R1>
  ): <In, E, R>(self: Sink<A, In, L, E, R>) => Sink<A1, In & In1, L1 | L, E1 | E, R1 | R>
  <A, In, L, E, R, A1, In1 extends L, L1, E1, R1>(
    self: Sink<A, In, L, E, R>,
    f: (a: A) => Sink<A1, In1, L1, E1, R1>
  ): Sink<A1, In & In1, L | L1, E | E1, R | R1>
} = dual(2, <A, In, L, E, R, A1, In1 extends L, L1, E1, R1>(
  self: Sink<A, In, L, E, R>,
  f: (a: A) => Sink<A1, In1, L1, E1, R1>
): Sink<A1, In & In1, L | L1, E | E1, R | R1> =>
  fromTransform((upstream, scope) => {
    let upstreamDone = false
    const pull = Effect.catchCause(upstream, (cause) => {
      upstreamDone = true
      return Effect.failCause(cause)
    })
    return Effect.flatMap(
      self.transform(pull, scope),
      ([a, leftover]) =>
        f(a).transform(
          Effect.suspend(() => {
            if (leftover) {
              const arr = leftover as Arr.NonEmptyReadonlyArray<In1>
              leftover = undefined
              return Effect.succeed(arr)
            } else if (upstreamDone) {
              return Cause.done()
            }
            return upstream
          }),
          scope
        )
    )
  }))

/**
 * A sink that reduces its inputs using the provided function `f` starting from
 * the provided `initial` state while the specified `predicate` returns `true`.
 *
 * @since 2.0.0
 * @category reducing
 */
export const reduceWhile = <S, In>(
  initial: LazyArg<S>,
  predicate: Predicate<S>,
  f: (s: S, input: In) => S
): Sink<S, In, In> =>
  fromTransform((upstream) => {
    let state = initial()
    let leftover: NonEmptyReadonlyArray<In> | undefined = undefined
    if (!predicate(state)) {
      return Effect.succeed([state] as const)
    }
    return upstream.pipe(
      Effect.flatMap((arr) => {
        for (let i = 0; i < arr.length; i++) {
          state = f(state, arr[i])
          if (!predicate(state)) {
            if ((i + 1) < arr.length) {
              leftover = arr.slice(i + 1) as any
            }
            return Cause.done()
          }
        }
        return Effect.void
      }),
      Effect.forever({ disableYield: true }),
      Pull.catchDone(() => Effect.succeed([state, leftover] as const))
    )
  })

/**
 * A sink that reduces its inputs using the provided effectful function `f`
 * starting from the provided `initial` state while the specified `predicate`
 * returns `true`.
 *
 * @since 2.0.0
 * @category reducing
 */
export const reduceWhileEffect = <S, In, E, R>(
  initial: LazyArg<S>,
  predicate: Predicate<S>,
  f: (s: S, input: In) => Effect.Effect<S, E, R>
): Sink<S, In, In, E, R> =>
  fromTransform((upstream) => {
    let state = initial()
    let leftover: NonEmptyReadonlyArray<In> | undefined = undefined
    if (!predicate(state)) {
      return Effect.succeed([state] as const)
    }
    return upstream.pipe(
      Effect.flatMap((arr) => {
        let i = 0
        return Effect.whileLoop({
          while: () => i < arr.length,
          body: constant(Effect.flatMap(Effect.suspend(() => f(state, arr[i++])), (s) => {
            state = s
            if (!predicate(state)) {
              if (i < arr.length) {
                leftover = arr.slice(i) as any
              }
              return Cause.done()
            }
            return Effect.void
          })),
          step: constVoid
        })
      }),
      Effect.forever({ disableYield: true }),
      Pull.catchDone(() => Effect.succeed([state, leftover] as const))
    )
  })

/**
 * A sink that reduces its inputs using the provided function `f` starting from
 * the provided `initial` state while the specified `predicate` returns `true`.
 *
 * @since 4.0.0
 * @category reducing
 */
export const reduceWhileArray = <S, In>(
  initial: LazyArg<S>,
  contFn: Predicate<S>,
  f: (s: S, input: NonEmptyReadonlyArray<In>) => S
): Sink<S, In> =>
  fromTransform((upstream) => {
    let state = initial()
    if (!contFn(state)) {
      return Effect.succeed([state] as const)
    }
    return upstream.pipe(
      Effect.flatMap((arr) => {
        for (let i = 0; i < arr.length; i++) {
          state = f(state, arr)
          if (!contFn(state)) {
            return Cause.done()
          }
        }
        return Effect.void
      }),
      Effect.forever({ disableYield: true }),
      Pull.catchDone(() => Effect.succeed([state] as const))
    )
  })

/**
 * A sink that reduces its inputs using the provided effectful function `f`
 * starting from the provided `initial` state while the specified `predicate`
 * returns `true`.
 *
 * @since 4.0.0
 * @category reducing
 */
export const reduceWhileArrayEffect = <S, In, E, R>(
  initial: LazyArg<S>,
  predicate: Predicate<S>,
  f: (s: S, input: NonEmptyReadonlyArray<In>) => Effect.Effect<S, E, R>
): Sink<S, In, never, E, R> =>
  fromTransform((upstream) => {
    let state = initial()
    if (!predicate(state)) {
      return Effect.succeed([state] as const)
    }
    return upstream.pipe(
      Effect.flatMap((arr) => f(state, arr)),
      Effect.flatMap((s) => {
        state = s
        if (!predicate(state)) {
          return Cause.done()
        }
        return Effect.void
      }),
      Effect.forever({ disableYield: true }),
      Pull.catchDone(() => Effect.succeed([state] as const))
    )
  })

/**
 * A sink that reduces its inputs using the provided function `f` starting from
 * the provided `initial` state.
 *
 * @since 2.0.0
 * @category reducing
 */
export const reduce = <S, In>(initial: LazyArg<S>, f: (s: S, input: In) => S): Sink<S, In> =>
  reduceArray(initial, (s, arr) => {
    for (let i = 0; i < arr.length; i++) {
      s = f(s, arr[i])
    }
    return s
  })

/**
 * A sink that reduces its inputs using the provided function `f` starting from
 * the specified `initial` state.
 *
 * @since 2.0.0
 * @category reducing
 */
export const reduceArray = <S, In>(
  initial: LazyArg<S>,
  f: (s: S, input: NonEmptyReadonlyArray<In>) => S
): Sink<S, In> =>
  fromTransform((upstream) => {
    let state = initial()
    return upstream.pipe(
      Effect.flatMap((arr) => {
        state = f(state, arr)
        return Effect.void
      }),
      Effect.forever({ disableYield: true }),
      Pull.catchDone(() => Effect.succeed([state] as const))
    )
  })

/**
 * A sink that reduces its inputs using the provided effectful function `f`
 * starting from the specified `initial` state.
 *
 * @since 2.0.0
 * @category reducing
 */
export const reduceEffect = <S, In, E, R>(
  initial: LazyArg<S>,
  f: (s: S, input: In) => Effect.Effect<S, E, R>
): Sink<S, In, never, E, R> => reduceWhileEffect(initial, constTrue, f) as any

const head_ = reduceWhile(Option.none<unknown>, Option.isNone, (_, in_) => Option.some(in_))

/**
 * Creates a sink containing the first value.
 *
 * @since 2.0.0
 * @category constructors
 */
export const head = <In>(): Sink<Option.Option<In>, In, In> => head_ as any

const last_ = reduceArray(Option.none<unknown>, (_, arr) => Arr.last(arr))

/**
 * Creates a sink containing the last value.
 *
 * @since 2.0.0
 * @category constructors
 */
export const last = <In>(): Sink<Option.Option<In>, In> => last_ as any

/**
 * Creates a sink containing the first matching value.
 *
 * @since 4.0.0
 * @category constructors
 */
export const find: {
  <In, Out extends In>(refinement: Refinement<In, Out>): Sink<Option.Option<Out>, In, In>
  <In>(predicate: Predicate<In>): Sink<Option.Option<In>, In, In>
} = <In>(predicate: Predicate<In>): Sink<Option.Option<In>, In, In> =>
  reduceWhile(
    Option.none<In>,
    Option.isNone,
    (acc, in_) => predicate(in_) ? Option.some(in_) : acc
  )

/**
 * Creates a sink containing the first matching value.
 *
 * @since 4.0.0
 * @category constructors
 */
export const findEffect = <In, E, R>(
  predicate: (input: In) => Effect.Effect<boolean, E, R>
): Sink<Option.Option<In>, In, In, E, R> =>
  reduceWhileEffect(
    Option.none<In>,
    Option.isNone,
    (acc, in_) => Effect.map(predicate(in_), (b) => b ? Option.some(in_) : acc)
  )

/**
 * Creates a sink which sums up its inputs.
 *
 * @since 2.0.0
 * @category constructors
 */
export const sum: Sink<number, number> = reduceArray(() => 0, (s, arr) => {
  for (let i = 0; i < arr.length; i++) {
    s += arr[i]
  }
  return s
})

/**
 * A sink that counts the number of elements fed to it.
 *
 * @since 2.0.0
 * @category constructors
 */
export const count: Sink<number, unknown> = reduceArray(() => 0, (s, arr) => s + arr.length)

/**
 * Accumulates incoming elements into an array.
 *
 * @since 2.0.0
 * @category constructors
 */
export const collect = <In>(): Sink<Array<In>, In> =>
  reduceArray(Arr.empty<In>, (s, arr) => {
    s.push(...arr)
    return s
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const takeWhile: {
  <In, Out extends In>(refinement: Refinement<In, Out>): Sink<Array<Out>, In, In>
  <In>(predicate: Predicate<In>): Sink<Array<In>, In, In>
} = <In>(predicate: Predicate<In>): Sink<Array<In>, In, In> =>
  fromTransform((upstream) => {
    const out = Arr.empty<In>()
    return upstream.pipe(
      Effect.flatMap((arr) => {
        for (let i = 0; i < arr.length; i++) {
          if (!predicate(arr[i])) {
            const leftover: Arr.NonEmptyReadonlyArray<In> | undefined = (i + 1) < arr.length
              ? arr.slice(i + 1) as any
              : undefined
            return Cause.done([out, leftover] as const)
          }
          out.push(arr[i])
        }
        return Effect.void
      }),
      Effect.forever({ disableYield: true }),
      Pull.catchDone((end) => Effect.succeed<End<Array<In>, In>>(end ?? [out]))
    )
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const takeWhileFilter = <In, Out, X>(
  filter: Filter.Filter<In, Out, X>
): Sink<Array<Out>, In, In> =>
  fromTransform((upstream) => {
    const out = Arr.empty<Out>()
    return upstream.pipe(
      Effect.flatMap((arr) => {
        for (let i = 0; i < arr.length; i++) {
          const result = filter(arr[i])
          if (Result.isFailure(result)) {
            const leftover: Arr.NonEmptyReadonlyArray<In> | undefined = (i + 1) < arr.length
              ? arr.slice(i + 1) as any
              : undefined
            return Cause.done([out, leftover] as const)
          }
          out.push(result.success)
        }
        return Effect.void
      }),
      Effect.forever({ disableYield: true }),
      Pull.catchDone((end) => Effect.succeed<End<Array<Out>, In>>(end ?? [out]))
    )
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const takeWhileEffect: {
  <In, E, R>(predicate: (input: In) => Effect.Effect<boolean, E, R>): Sink<Array<In>, In, In, E, R>
} = <In, E, R>(
  predicate: (input: In) => Effect.Effect<boolean, E, R>
): Sink<Array<In>, In, In, E, R> =>
  fromTransform((upstream) => {
    const out = Arr.empty<In>()
    let leftover: Arr.NonEmptyReadonlyArray<In> | undefined = undefined
    return upstream.pipe(
      Effect.flatMap((arr) => {
        let i = 0
        return Effect.whileLoop({
          while: () => i < arr.length,
          body: constant(Effect.flatMap(
            Effect.suspend(() => {
              const input = arr[i++]
              return Effect.map(predicate(input), (passes) => [input, passes] as const)
            }),
            ([input, passes]) => {
              if (!passes) {
                if (i < arr.length) {
                  leftover = arr.slice(i) as any
                }
                return Cause.done()
              }
              out.push(input)
              return Effect.void
            }
          )),
          step: constVoid
        })
      }),
      Effect.forever({ disableYield: true }),
      Pull.catchDone(() => Effect.succeed([out, leftover] as const))
    )
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const takeWhileFilterEffect = <In, Out, X, E, R>(
  filter: Filter.FilterEffect<In, Out, X, E, R>
): Sink<Array<Out>, In, In, E, R> =>
  fromTransform((upstream) => {
    const out = Arr.empty<Out>()
    let leftover: Arr.NonEmptyReadonlyArray<In> | undefined = undefined
    return upstream.pipe(
      Effect.flatMap((arr) => {
        let i = 0
        return Effect.whileLoop({
          while: () => i < arr.length,
          body: constant(Effect.flatMap(Effect.suspend(() => filter(arr[i++])), (result) => {
            if (Result.isFailure(result)) {
              if (i < arr.length) {
                leftover = arr.slice(i) as any
              }
              return Cause.done()
            }
            out.push(result.success)
            return Effect.void
          })),
          step: constVoid
        })
      }),
      Effect.forever({ disableYield: true }),
      Pull.catchDone(() => Effect.succeed([out, leftover] as const))
    )
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const takeUntil = <In>(predicate: Predicate<In>): Sink<Array<In>, In, In> =>
  suspend(() => {
    let done = false
    return takeWhile((i) => {
      if (done) return false
      done = predicate(i)
      return true
    })
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const takeUntilEffect = <In, E, R>(
  predicate: (input: In) => Effect.Effect<boolean, E, R>
): Sink<Array<In>, In, In, E, R> =>
  suspend(() => {
    let done = false
    return takeWhileEffect((input) => {
      if (done) {
        return Effect.succeed(false)
      }
      return Effect.map(predicate(input), (b) => {
        done = b
        return true
      })
    })
  })

/**
 * A sink that executes the provided effectful function for every item fed
 * to it.
 *
 * @example
 * ```ts
 * import { Console, Effect, Sink, Stream } from "effect"
 *
 * // Create a sink that logs each item
 * const sink = Sink.forEach((item: number) => Console.log(`Processing: ${item}`))
 *
 * // Use it with a stream
 * const stream = Stream.make(1, 2, 3)
 * const program = Stream.run(stream, sink)
 *
 * Effect.runPromise(program)
 * // Output:
 * // Processing: 1
 * // Processing: 2
 * // Processing: 3
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const forEach = <In, X, E, R>(
  f: (input: In) => Effect.Effect<X, E, R>
): Sink<void, In, never, E, R> => forEachArray(Effect.forEach((_) => f(_), { discard: true }))

/**
 * A sink that executes the provided effectful function for every Chunk fed
 * to it.
 *
 * @example
 * ```ts
 * import { Console, Effect, Sink, Stream } from "effect"
 *
 * // Create a sink that processes chunks
 * const sink = Sink.forEachArray((chunk: ReadonlyArray<number>) =>
 *   Console.log(
 *     `Processing chunk of ${chunk.length} items: [${chunk.join(", ")}]`
 *   )
 * )
 *
 * // Use it with a stream
 * const stream = Stream.make(1, 2, 3, 4, 5)
 * const program = Stream.run(stream, sink)
 *
 * Effect.runPromise(program)
 * // Output: Processing chunk of 5 items: [1, 2, 3, 4, 5]
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const forEachArray = <In, X, E, R>(
  f: (input: NonEmptyReadonlyArray<In>) => Effect.Effect<X, E, R>
): Sink<void, In, never, E, R> =>
  fromTransform((upstream) =>
    upstream.pipe(
      Effect.flatMap(f),
      Effect.forever({ disableYield: true }),
      Pull.catchDone(() => endVoid)
    )
  )

/**
 * @since 2.0.0
 * @category constructors
 */
export const forEachWhile = <In, E, R>(
  f: (input: In) => Effect.Effect<boolean, E, R>
): Sink<void, In, never, E, R> =>
  forEachWhileArray(Effect.fnUntraced(function*(input) {
    for (let i = 0; i < input.length; i++) {
      const cont = yield* f(input[i])
      if (!cont) return false
    }
    return true
  }))

/**
 * @since 2.0.0
 * @category constructors
 */
export const forEachWhileArray = <In, E, R>(
  f: (input: NonEmptyReadonlyArray<In>) => Effect.Effect<boolean, E, R>
): Sink<void, In, never, E, R> =>
  fromTransform((upstream) =>
    upstream.pipe(
      Effect.flatMap(f),
      Effect.flatMap((cont) => cont ? Effect.void : Cause.done()),
      Effect.forever({ disableYield: true }),
      Pull.catchDone(() => endVoid)
    )
  )

/**
 * Creates a sink produced from a scoped effect.
 *
 * @example
 * ```ts
 * import { Console, Effect, Sink, Stream } from "effect"
 *
 * // Create a sink from an effect that produces a sink
 * const sinkEffect = Effect.succeed(
 *   Sink.forEach((item: number) => Console.log(`Item: ${item}`))
 * )
 * const sink = Sink.unwrap(sinkEffect)
 *
 * // Use it with a stream
 * const stream = Stream.make(1, 2, 3)
 * const program = Stream.run(stream, sink)
 *
 * Effect.runPromise(program)
 * // Output:
 * // Item: 1
 * // Item: 2
 * // Item: 3
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const unwrap = <A, In, L, E, R, R2>(
  effect: Effect.Effect<Sink<A, In, L, E, R2>, E, R>
): Sink<A, In, L, E, Exclude<R, Scope.Scope> | R2> => fromChannel(Channel.unwrap(Effect.map(effect, toChannel)))

/**
 * Summarize a sink by running an effect when the sink starts and again when
 * it completes.
 *
 * @since 2.0.0
 * @category utils
 */
export const summarized: {
  <A2, E2, R2, A3>(
    summary: Effect.Effect<A2, E2, R2>,
    f: (start: A2, end: A2) => A3
  ): <A, In, L, E, R>(self: Sink<A, In, L, E, R>) => Sink<[A, A3], In, L, E2 | E, R2 | R>
  <A, In, L, E, R, A2, E2, R2, A3>(
    self: Sink<A, In, L, E, R>,
    summary: Effect.Effect<A2, E2, R2>,
    f: (start: A2, end: A2) => A3
  ): Sink<[A, A3], In, L, E | E2, R | R2>
} = dual(3, <A, In, L, E, R, A2, E2, R2, A3>(
  self: Sink<A, In, L, E, R>,
  summary: Effect.Effect<A2, E2, R2>,
  f: (start: A2, end: A2) => A3
): Sink<[A, A3], In, L, E | E2, R | R2> =>
  fromTransform(Effect.fnUntraced(function*(upstream, scope) {
    const start = yield* summary
    const [done, leftover] = yield* self.transform(upstream, scope)
    const end = yield* summary
    return [[done, f(start, end)], leftover] as const
  })))

/**
 * Returns the sink that executes this one and times its execution.
 *
 * @since 2.0.0
 * @category utils
 */
export const withDuration = <A, In, L, E, R>(
  self: Sink<A, In, L, E, R>
): Sink<[A, Duration.Duration], In, L, E, R> =>
  summarized(self, Clock.currentTimeNanos, (start, end) => Duration.nanos(end - start))

/**
 * @since 2.0.0
 * @category constructors
 */
export const timed: Sink<Duration.Duration, unknown> = map(withDuration(drain), ([, duration]) => duration)

/**
 * @since 4.0.0
 * @category Services
 */
export const provideContext: {
  <Provided>(
    context: Context.Context<Provided>
  ): <A, In, L, E, R>(self: Sink<A, In, L, E, R>) => Sink<A, In, L, E, Exclude<R, Provided>>
  <A, In, L, E, R, Provided>(
    self: Sink<A, In, L, E, R>,
    context: Context.Context<Provided>
  ): Sink<A, In, L, E, Exclude<R, Provided>>
} = dual(2, <A, In, L, E, R, Provided>(
  self: Sink<A, In, L, E, R>,
  context: Context.Context<Provided>
): Sink<A, In, L, E, Exclude<R, Provided>> =>
  fromTransform((upstream, scope) =>
    self.transform(upstream, scope).pipe(
      Effect.provideContext(context)
    )
  ))

/**
 * @since 4.0.0
 * @category Services
 */
export const provideService: {
  <I, S>(
    key: Context.Key<I, S>,
    value: Types.NoInfer<S>
  ): <A, In, L, E, R>(self: Sink<A, In, L, E, R>) => Sink<A, In, L, E, Exclude<R, I>>
  <A, In, L, E, R, I, S>(
    self: Sink<A, In, L, E, R>,
    key: Context.Key<I, S>,
    value: Types.NoInfer<S>
  ): Sink<A, In, L, E, Exclude<R, I>>
} = dual(3, <A, In, L, E, R, I, S>(
  self: Sink<A, In, L, E, R>,
  key: Context.Key<I, S>,
  value: Types.NoInfer<S>
): Sink<A, In, L, E, Exclude<R, I>> =>
  fromTransform((upstream, scope) =>
    self.transform(upstream, scope).pipe(
      Effect.provideService(key, value)
    )
  ))

/**
 * @since 2.0.0
 * @category Error handling
 */
export const orElse: {
  <E, A2, In2, L2, E2, R2>(
    f: (error: Types.NoInfer<E>) => Sink<A2, In2, L2, E2, R2>
  ): <A, In, L, R>(self: Sink<A, In, L, E, R>) => Sink<A2 | A, In & In2, L2 | L, E2 | E, R2 | R>
  <A, In, L, E, R, A2, In2, L2, E2, R2>(
    self: Sink<A, In, L, E, R>,
    f: (error: E) => Sink<A2, In2, L2, E2, R2>
  ): Sink<A | A2, In & In2, L | L2, E | E2, R | R2>
} = dual(2, <A, In, L, E, R, A2, In2, L2, E2, R2>(
  self: Sink<A, In, L, E, R>,
  f: (error: E) => Sink<A2, In2, L2, E2, R2>
): Sink<A | A2, In & In2, L | L2, E | E2, R | R2> =>
  fromTransform((upstream, scope) => {
    let upstreamDone = false
    const pull = Effect.catchCause(upstream, (cause) => {
      upstreamDone = true
      return Effect.failCause(cause)
    })
    return Effect.catch(
      self.transform(pull, scope) as Effect.Effect<End<A | A2, L | L2>, E, R>,
      (error) =>
        f(error).transform(
          Effect.suspend(() => {
            if (upstreamDone) {
              return Cause.done()
            }
            return upstream
          }),
          scope
        )
    )
  }))

/**
 * @since 4.0.0
 * @category Error handling
 */
export const catchCause: {
  <E, A2, E2, R2>(
    f: (error: Cause.Cause<Types.NoInfer<E>>) => Effect.Effect<A2, E2, R2>
  ): <A, In, L, R>(self: Sink<A, In, L, E, R>) => Sink<A2 | A, In, L, E, R2 | R>
  <A, In, L, E, R, A2, E2, R2>(
    self: Sink<A, In, L, E, R>,
    f: (error: Cause.Cause<E>) => Effect.Effect<A2, E2, R2>
  ): Sink<A | A2, In, L, E2, R | R2>
} = dual(2, <A, In, L, E, R, A2, E2, R2>(
  self: Sink<A, In, L, E, R>,
  f: (error: Cause.Cause<E>) => Effect.Effect<A2, E2, R2>
): Sink<A | A2, In, L, E2, R | R2> =>
  transformEffect(
    self,
    Effect.catchCause((cause) => Effect.map(f(cause), (a2) => [a2 as A | A2] as const))
  ))

const catch_: {
  <E, A2, E2, R2>(
    f: (error: Types.NoInfer<E>) => Effect.Effect<A2, E2, R2>
  ): <A, In, L, R>(self: Sink<A, In, L, E, R>) => Sink<A2 | A, In, L, E, R2 | R>
  <A, In, L, E, R, A2, E2, R2>(
    self: Sink<A, In, L, E, R>,
    f: (error: E) => Effect.Effect<A2, E2, R2>
  ): Sink<A | A2, In, L, E2, R | R2>
} = dual(2, <A, In, L, E, R, A2, E2, R2>(
  self: Sink<A, In, L, E, R>,
  f: (error: E) => Effect.Effect<A2, E2, R2>
): Sink<A | A2, In, L, E2, R | R2> =>
  transformEffect(
    self,
    Effect.catch((error) => Effect.map(f(error), (a2) => [a2 as A | A2] as const))
  ))

export {
  /**
   * @since 4.0.0
   * @category Error handling
   */
  catch_ as catch
}

/**
 * @since 4.0.0
 * @category Finalization
 */
export const onExit: {
  <A, E, X, E2, R2>(
    f: (exit: Exit.Exit<A, E>) => Effect.Effect<X, E2, R2>
  ): <In, L, R>(self: Sink<A, In, L, E, R>) => Sink<A, In, L, E | E2, R2 | R>
  <A, In, L, E, R, X, E2, R2>(
    self: Sink<A, In, L, E, R>,
    f: (exit: Exit.Exit<A, E>) => Effect.Effect<X, E2, R2>
  ): Sink<A, In, L, E | E2, R | R2>
} = dual(2, <A, In, L, E, R, X, E2, R2>(
  self: Sink<A, In, L, E, R>,
  f: (exit: Exit.Exit<A, E>) => Effect.Effect<X, E2, R2>
): Sink<A, In, L, E | E2, R | R2> =>
  transformEffect(
    self,
    Effect.onExit((exit) => f(Exit.map(exit, ([a]) => a)))
  ))

/**
 * @since 4.0.0
 * @category Finalization
 */
export const ensuring: {
  <X, E2, R2>(
    effect: Effect.Effect<X, E2, R2>
  ): <A, E, In, L, R>(self: Sink<A, In, L, E, R>) => Sink<A, In, L, E | E2, R2 | R>
  <A, In, L, E, R, X, E2, R2>(
    self: Sink<A, In, L, E, R>,
    effect: Effect.Effect<X, E2, R2>
  ): Sink<A, In, L, E | E2, R | R2>
} = dual(2, <A, In, L, E, R, X, E2, R2>(
  self: Sink<A, In, L, E, R>,
  effect: Effect.Effect<X, E2, R2>
): Sink<A, In, L, E | E2, R | R2> => onExit(self, () => effect))

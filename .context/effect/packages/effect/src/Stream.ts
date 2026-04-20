/**
 * @since 2.0.0
 */
// @effect-diagnostics returnEffectInGen:off
import * as Arr from "./Array.ts"
import * as Cause from "./Cause.ts"
import * as Channel from "./Channel.ts"
import { Clock } from "./Clock.ts"
import * as Context from "./Context.ts"
import * as Duration from "./Duration.ts"
import * as Effect from "./Effect.ts"
import * as Equal from "./Equal.ts"
import * as ExecutionPlan from "./ExecutionPlan.ts"
import * as Exit from "./Exit.ts"
import * as Fiber from "./Fiber.ts"
import type * as Filter from "./Filter.ts"
import type { LazyArg } from "./Function.ts"
import { constant, constTrue, constVoid, dual, identity } from "./Function.ts"
import type { TypeLambda } from "./HKT.ts"
import * as internalExecutionPlan from "./internal/executionPlan.ts"
import * as internal from "./internal/stream.ts"
import { addSpanStackTrace } from "./internal/tracer.ts"
import * as Iterable from "./Iterable.ts"
import * as Latch from "./Latch.ts"
import type * as Layer from "./Layer.ts"
import type { Severity } from "./LogLevel.ts"
import * as MutableHashMap from "./MutableHashMap.ts"
import * as MutableList from "./MutableList.ts"
import * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import type { Predicate, Refinement } from "./Predicate.ts"
import { hasProperty, isNotUndefined, isTagged } from "./Predicate.ts"
import type * as PubSub from "./PubSub.ts"
import * as Pull from "./Pull.ts"
import * as Queue from "./Queue.ts"
import * as RcMap from "./RcMap.ts"
import * as RcRef from "./RcRef.ts"
import * as Result from "./Result.ts"
import * as Schedule from "./Schedule.ts"
import * as Scope from "./Scope.ts"
import * as Sink from "./Sink.ts"
import { isString } from "./String.ts"
import type * as Take from "./Take.ts"
import type { ParentSpan, SpanOptions } from "./Tracer.ts"
import type {
  Covariant,
  ExcludeReason,
  ExcludeTag,
  ExtractReason,
  ExtractTag,
  NarrowReason,
  NoInfer,
  OmitReason,
  ReasonTags,
  Tags,
  unassigned
} from "./Types.ts"
import type * as Unify from "./Unify.ts"

/**
 * @since 4.0.0
 * @category Type Identifiers
 */
export type TypeId = "~effect/Stream"

/**
 * @since 4.0.0
 * @category Type Identifiers
 */
export const TypeId: TypeId = "~effect/Stream"

/**
 * A `Stream<A, E, R>` describes a program that can emit many `A` values, fail
 * with `E`, and require `R`.
 *
 * Streams are pull-based with backpressure and emit chunks to amortize effect
 * evaluation. They support monadic composition and error handling similar to
 * `Effect`, adapted for multiple values.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Stream.make(1, 2, 3).pipe(
 *     Stream.map((n) => n * 2),
 *     Stream.runForEach((n) => Console.log(n))
 *   )
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // 2
 * // 4
 * // 6
 * ```
 *
 * @since 2.0.0
 * @category Models
 */
export interface Stream<out A, out E = never, out R = never> extends Variance<A, E, R>, Pipeable {
  readonly channel: Channel.Channel<Arr.NonEmptyReadonlyArray<A>, E, void, unknown, unknown, unknown, R>
  [Unify.typeSymbol]?: unknown
  [Unify.unifySymbol]?: StreamUnify<this>
  [Unify.ignoreSymbol]?: StreamUnifyIgnore
}

/**
 * Type-level unification hook for Stream within the Effect type system.
 *
 * @example
 * ```ts
 * import { Effect, Stream } from "effect"
 *
 * // StreamUnify helps unify Stream and Effect types
 * declare const stream: Stream.Stream<number>
 * declare const effect: Effect.Effect<string>
 *
 * // The unification system handles mixed operations
 * const combined = Effect.zip(stream.pipe(Stream.runCollect), effect)
 * ```
 *
 * @since 2.0.0
 * @category Models
 */
export interface StreamUnify<A extends { [Unify.typeSymbol]?: any }> extends Effect.EffectUnify<A> {
  Stream?: () => A[Unify.typeSymbol] extends Stream<infer A0, infer E0, infer R0> | infer _ ? Stream<A0, E0, R0> : never
}

/**
 * Type-level marker that excludes Stream from unification.
 *
 * @example
 * ```ts
 * import type * as Stream from "effect/Stream"
 *
 * // Used internally by the type system
 * // Users typically don't interact with this directly
 * type StreamIgnore = Stream.StreamUnifyIgnore
 * ```
 *
 * @category Models
 * @since 2.0.0
 */
export interface StreamUnifyIgnore {
  Effect?: true
}

/**
 * Type lambda for Stream used in higher-kinded type operations.
 *
 * @example
 * ```ts
 * import type { Kind } from "effect/HKT"
 * import type { StreamTypeLambda } from "effect/Stream"
 *
 * // Create a Stream type using the type lambda
 * type NumberStream = Kind<StreamTypeLambda, never, string, never, number>
 * // Equivalent to: Stream<number, string, never>
 * ```
 *
 * @category Type Lambdas
 * @since 2.0.0
 */
export interface StreamTypeLambda extends TypeLambda {
  readonly type: Stream<this["Target"], this["Out1"], this["Out2"]>
}

/**
 * Variance markers for Stream type parameters.
 *
 * @since 2.0.0
 * @category Models
 */
export interface Variance<out A, out E, out R> {
  readonly [TypeId]: VarianceStruct<A, E, R>
}

/**
 * Structural encoding of Stream type parameter variance.
 *
 * @since 2.0.0
 * @category Models
 */
export interface VarianceStruct<out A, out E, out R> {
  readonly _A: Covariant<A>
  readonly _E: Covariant<E>
  readonly _R: Covariant<R>
}

/**
 * Extract the success type from a Stream type.
 *
 * @example
 * ```ts
 * import type { Stream } from "effect"
 *
 * type NumberStream = Stream.Stream<number, string, never>
 * type SuccessType = Stream.Success<NumberStream>
 * // SuccessType is number
 * ```
 *
 * @since 3.4.0
 * @category Type-Level
 */
export type Success<T extends Stream<any, any, any>> = [T] extends [Stream<infer _A, infer _E, infer _R>] ? _A : never

/**
 * Extract the error type from a Stream type.
 *
 * @example
 * ```ts
 * import type { Stream } from "effect"
 *
 * type NumberStream = Stream.Stream<number, string, never>
 * type ErrorType = Stream.Error<NumberStream>
 * // ErrorType is string
 * ```
 *
 * @since 3.4.0
 * @category Type-Level
 */
export type Error<T extends Stream<any, any, any>> = [T] extends [Stream<infer _A, infer _E, infer _R>] ? _E : never

/**
 * Extract the services type from a Stream type.
 *
 * **Previously Known As:**
 *
 * This type alias was named `Context` in Effect 3.x.
 *
 * @example
 * ```ts
 * import type { Stream } from "effect"
 *
 * interface Database {
 *   query: (sql: string) => unknown
 * }
 * type NumberStream = Stream.Stream<number, string, { db: Database }>
 * type RequiredServices = Stream.Services<NumberStream>
 * // RequiredServices is { db: Database }
 * ```
 *
 * @since 3.4.0
 * @category Type-Level
 */
export type Services<T extends Stream<any, any, any>> = [T] extends [Stream<infer _A, infer _E, infer _R>] ? _R
  : never

/**
 * Checks whether a value is a Stream.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.make(1, 2, 3)
 *   const notStream = { data: [1, 2, 3] }
 *
 *   yield* Console.log(Stream.isStream(stream))
 *   // true
 *   yield* Console.log(Stream.isStream(notStream))
 *   // false
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @since 2.0.0
 * @category Guards
 */
export const isStream = (u: unknown): u is Stream<unknown, unknown, unknown> => hasProperty(u, TypeId)

/**
 * The default chunk size used by Stream constructors and combinators.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.log(Stream.DefaultChunkSize)
 * })
 *
 * Effect.runPromise(program)
 * // Output: 4096
 * ```
 *
 * @category Constants
 * @since 2.0.0
 */
export const DefaultChunkSize: number = Channel.DefaultChunkSize

/**
 * Describes how merged streams decide when to halt.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `StreamHaltStrategy.HaltStrategy`
 *
 * @category Models
 * @since 2.0.0
 */
export type HaltStrategy = Channel.HaltStrategy

/**
 * Creates a stream from a array-emitting `Channel`.
 *
 * @example
 * ```ts
 * import { Channel, Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const channel = Channel.succeed([1, 2, 3] as const)
 *   const stream = Stream.fromChannel(channel)
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * })
 *
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const fromChannel: <Arr extends Arr.NonEmptyReadonlyArray<any>, E, R>(
  channel: Channel.Channel<Arr, E, void, unknown, unknown, unknown, R>
) => Stream<Arr extends Arr.NonEmptyReadonlyArray<infer A> ? A : never, E, R> = internal.fromChannel

/**
 * Either emits the success value of this effect or terminates the stream
 * with the failure value of this effect.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.fromEffect(Effect.succeed(42))
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 42 ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const fromEffect = <A, E, R>(effect: Effect.Effect<A, E, R>): Stream<A, E, R> =>
  fromChannel(Channel.fromEffect(Effect.map(effect, Arr.of)))

/**
 * Accesses a service from the context and emits it as a single element.
 *
 * @example
 * ```ts
 * import { Effect, Context, Stream } from "effect"
 *
 * class Greeter extends Context.Service<Greeter, {
 *   readonly greet: (name: string) => string
 * }>()("Greeter") {}
 *
 * const stream = Stream.service(Greeter).pipe(
 *   Stream.map((greeter) => greeter.greet("World"))
 * )
 *
 * const program = Effect.gen(function*() {
 *   return yield* stream.pipe(
 *     Stream.provideService(Greeter, {
 *       greet: (name) => `Hello, ${name}!`
 *     }),
 *     Stream.runCollect
 *   )
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "Hello, World!" ]
 * ```
 *
 * @since 4.0.0
 * @category Context
 */
export const service = <I, S>(service: Context.Key<I, S>): Stream<S, never, I> => fromEffect(Effect.service(service))

/**
 * Optionally accesses a service from the context and emits the result as a
 * single element.
 *
 * @example
 * ```ts
 * import { Effect, Option, Context, Stream } from "effect"
 *
 * class Greeter extends Context.Service<Greeter, {
 *   readonly greet: (name: string) => string
 * }>()("Greeter") {}
 *
 * const stream = Stream.serviceOption(Greeter).pipe(
 *   Stream.map((maybeGreeter) =>
 *     Option.match(maybeGreeter, {
 *       onNone: () => "No greeter",
 *       onSome: (greeter) => greeter.greet("World")
 *     })
 *   )
 * )
 *
 * const program = Effect.gen(function*() {
 *   return yield* stream.pipe(
 *     Stream.provideService(Greeter, {
 *       greet: (name) => `Hello, ${name}!`
 *     }),
 *     Stream.runCollect
 *   )
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "Hello, World!" ]
 * ```
 *
 * @since 4.0.0
 * @category Context
 */
export const serviceOption = <I, S>(service: Context.Key<I, S>): Stream<Option.Option<S>> =>
  fromEffect(Effect.serviceOption(service))

/**
 * Creates a stream that runs the effect and emits no elements.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Stream.fromEffectDrain(Console.log("Draining side effect")).pipe(
 *     Stream.runDrain
 *   )
 * })
 *
 * Effect.runPromise(program)
 * // Output: Draining side effect
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const fromEffectDrain = <A, E, R>(effect: Effect.Effect<A, E, R>): Stream<never, E, R> =>
  fromPull(Effect.succeed(Effect.flatMap(effect, () => Cause.done())))

/**
 * Creates a stream from an effect producing a value of type `A` which repeats forever.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.repeatEffect`
 *
 * @example
 * ```ts
 * import { Console, Effect, Random, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.fromEffectRepeat(Random.nextInt).pipe(
 *     Stream.take(5)
 *   )
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 3891571149, 4239494205, 2352981603, 2339111046, 1488052210 ]
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const fromEffectRepeat = <A, E, R>(effect: Effect.Effect<A, E, R>): Stream<A, Pull.ExcludeDone<E>, R> =>
  fromPull(Effect.succeed(Effect.map(effect, Arr.of)))

/**
 * Creates a stream from an effect producing a value of type `A`, which is
 * repeated using the specified schedule.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.repeatEffectWithSchedule`
 *
 * @example
 * ```ts
 * import { Console, Effect, Schedule, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.fromEffectSchedule(
 *     Effect.succeed("ping"),
 *     Schedule.recurs(2)
 *   )
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "ping", "ping", "ping" ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const fromEffectSchedule = <A, E, R, X, AS extends A, ES, RS>(
  effect: Effect.Effect<A, E, R>,
  schedule: Schedule.Schedule<X, AS, ES, RS>
): Stream<A, E | ES, R | RS> =>
  fromPull(Effect.gen(function*() {
    const step = yield* Schedule.toStepWithMetadata(schedule)
    let s = yield* Effect.provideService(effect, Schedule.CurrentMetadata, Schedule.CurrentMetadata.defaultValue())
    let initial = true
    const pull = Effect.suspend(() => step(s as AS)).pipe(
      Effect.flatMap((meta) => Effect.provideService(effect, Schedule.CurrentMetadata, meta)),
      Effect.map((next) => {
        s = next
        return Arr.of(next)
      })
    ) as Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E | ES, void, R | RS>
    return Effect.suspend(() => {
      if (initial) {
        initial = false
        return Effect.succeed(Arr.of(s))
      }
      return pull
    })
  }))

/**
 * Creates a stream that emits void values spaced by the specified duration.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ticks = yield* Stream.tick("200 millis").pipe(
 *     Stream.take(3),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(ticks)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ undefined, undefined, undefined ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const tick = (interval: Duration.Input): Stream<void> =>
  fromPull(Effect.sync(() => {
    let first = true
    const effect = Effect.succeed(Arr.of<void>(undefined))
    const delayed = Effect.delay(effect, interval)
    return Effect.suspend(() => {
      if (first) {
        first = false
        return effect
      }
      return delayed
    })
  }))

/**
 * Creates a stream from a pull effect, such as one produced by `Stream.toPull`.
 *
 * A pull effect yields chunks on demand and completes when the upstream stream ends.
 * See `Stream.toPull` for a matching producer.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const source = Stream.make(1, 2, 3)
 *     const pull = yield* Stream.toPull(source)
 *     const stream = Stream.fromPull(Effect.succeed(pull))
 *     const values = yield* Stream.runCollect(stream)
 *     yield* Console.log(values)
 *   })
 * )
 *
 * Effect.runPromise(program)
 * // Output: [1, 2, 3]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const fromPull = <A, E, R, EX, RX>(
  pull: Effect.Effect<Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void, R>, EX, RX>
): Stream<A, Pull.ExcludeDone<E> | EX, R | RX> => fromChannel(Channel.fromPull(pull))

/**
 * Derive a stream by transforming its pull effect.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3)
 *
 * const transformed = Stream.transformPull(stream, (pull) => Effect.succeed(pull))
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(transformed)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const transformPull = <A, E, R, B, E2, R2, EX, RX>(
  self: Stream<A, E, R>,
  f: (pull: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void>, scope: Scope.Scope) => Effect.Effect<
    Pull.Pull<Arr.NonEmptyReadonlyArray<B>, E2, void, R2>,
    EX,
    RX
  >
): Stream<B, EX | Pull.ExcludeDone<E2>, R | R2 | RX> =>
  fromChannel(
    Channel.fromTransform((_, scope) =>
      Effect.flatMap(Channel.toPullScoped(self.channel, scope), (pull) => f(pull as any, scope))
    )
  )

/**
 * Transforms a stream by effectfully transforming its pull effect.
 *
 * A forked scope is also provided to the transformation function, which is
 * closed once the resulting stream has finished processing.
 *
 * @example
 * ```ts
 * import { Console, Effect, Scope, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3)
 *
 * const transformed = Stream.transformPullBracket(
 *   stream,
 *   (pull, _scope, forkedScope) =>
 *     Effect.gen(function*() {
 *       yield* Scope.addFinalizer(forkedScope, Console.log("Releasing scope"))
 *       return pull
 *     })
 * )
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(transformed)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [1, 2, 3]
 * // Releasing scope
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const transformPullBracket = <A, E, R, B, E2, R2, EX, RX>(
  self: Stream<A, E, R>,
  f: (
    pull: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void, R>,
    scope: Scope.Scope,
    forkedScope: Scope.Scope
  ) => Effect.Effect<
    Pull.Pull<Arr.NonEmptyReadonlyArray<B>, E2, void, R2>,
    EX,
    RX
  >
): Stream<B, EX | Pull.ExcludeDone<E2>, R | R2 | RX> =>
  fromChannel(
    Channel.fromTransformBracket((_, scope, forkedScope) =>
      Effect.flatMap(Channel.toPullScoped(self.channel, scope), (pull) => f(pull, scope, forkedScope))
    )
  )

/**
 * Creates a channel from a stream.
 *
 * @example
 * ```ts
 * import { Channel, Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.make(1, 2, 3)
 *   const channel = Stream.toChannel(stream)
 *   const values = yield* Channel.runCollect(channel)
 *   yield* Console.log(values.flat())
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const toChannel = <A, E, R>(
  stream: Stream<A, E, R>
): Channel.Channel<Arr.NonEmptyReadonlyArray<A>, E, void, unknown, unknown, unknown, R> => stream.channel

/**
 * Creates a stream from a callback that can emit values into a queue.
 *
 * You can use the `Queue` with the apis from the `Queue` module to emit
 * values to the stream or to signal the stream ending.
 *
 * By default it uses an "unbounded" buffer size.
 * You can customize the buffer size and strategy by passing an object as the
 * second argument with the `bufferSize` and `strategy` fields.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.async`
 * - `Stream.asyncEffect`
 * - `Stream.asyncPush`
 * - `Stream.asyncScoped`
 *
 * @example
 * ```ts
 * import { Console, Effect, Queue, Stream } from "effect"
 *
 * const stream = Stream.callback<number>((queue) =>
 *   Effect.sync(() => {
 *     // Emit values to the stream
 *     Queue.offerUnsafe(queue, 1)
 *     Queue.offerUnsafe(queue, 2)
 *     Queue.offerUnsafe(queue, 3)
 *     // Signal completion
 *     Queue.endUnsafe(queue)
 *   })
 * )
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* stream.pipe(Stream.runCollect)
 *   yield* Console.log(values)
 *   // [ 1, 2, 3 ]
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const callback = <A, E = never, R = never>(
  f: (queue: Queue.Queue<A, E | Cause.Done>) => Effect.Effect<unknown, E, R | Scope.Scope>,
  options?: {
    readonly bufferSize?: number | undefined
    readonly strategy?: "sliding" | "dropping" | "suspend" | undefined
  }
): Stream<A, E, Exclude<R, Scope.Scope>> => fromChannel(Channel.callbackArray(f, options))

/**
 * Creates an empty stream.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.empty.pipe(Stream.runCollect)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // []
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const empty: Stream<never> = fromChannel(Channel.empty)

/**
 * Creates a single-valued pure stream.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.succeed(3).pipe(Stream.runCollect)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // [ 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const succeed = <A>(value: A): Stream<A> => fromChannel(Channel.succeed(Arr.of(value)))

/**
 * Creates a stream from a sequence of values.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3)
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values) // [ 1, 2, 3 ]
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const make = <const As extends ReadonlyArray<any>>(...values: As): Stream<As[number]> => fromArray(values)

/**
 * Creates a stream that synchronously evaluates a function and emits the result as a single value.
 *
 * The function is evaluated each time the stream is run.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.sync(() => 2 + 1).pipe(Stream.runCollect)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const sync = <A>(evaluate: LazyArg<A>): Stream<A> => fromChannel(Channel.sync(() => Arr.of(evaluate())))

/**
 * Creates a lazily constructed stream.
 *
 * The stream factory is evaluated each time the stream is run.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.suspend(() => Stream.make(1, 2, 3)).pipe(Stream.runCollect)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const suspend = <A, E, R>(stream: LazyArg<Stream<A, E, R>>): Stream<A, E, R> =>
  fromChannel(Channel.suspend(() => stream().channel))

/**
 * Terminates with the specified error.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.fail("Uh oh!")
 *   const exit = yield* Effect.exit(Stream.runCollect(stream))
 *   yield* Console.log(exit)
 *   // Output: { _id: 'Exit', _tag: 'Failure', cause: { _id: 'Cause', _tag: 'Fail', failure: 'Uh oh!' } }
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const fail = <E>(error: E): Stream<never, E> => fromChannel(Channel.fail(error))

/**
 * Terminates with the specified lazily evaluated error.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.failSync(() => "Uh oh!")
 *
 * const program = Effect.gen(function*() {
 *   const exit = yield* Stream.runCollect(stream).pipe(Effect.exit)
 *   yield* Console.log(exit)
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // { _id: 'Exit', _tag: 'Failure', cause: { _id: 'Cause', _tag: 'Fail', failure: 'Uh oh!' } }
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const failSync = <E>(evaluate: LazyArg<E>): Stream<never, E> => fromChannel(Channel.failSync(evaluate))

/**
 * Creates a stream that fails with the specified `Cause`.
 *
 * @example
 * ```ts
 * import { Cause, Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.failCause(Cause.fail("Database connection failed")).pipe(
 *   Stream.catchCause(() => Stream.succeed("recovered"))
 * )
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 *   // Output: [ "recovered" ]
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const failCause = <E>(cause: Cause.Cause<E>): Stream<never, E> => fromChannel(Channel.failCause(cause))

/**
 * The stream that dies with the specified defect.
 *
 * @example
 * ```ts
 * import { Cause, Console, Effect, Exit, Stream } from "effect"
 *
 * const defect = new Error("Boom")
 * const stream = Stream.die(defect)
 *
 * const program = Effect.gen(function*() {
 *   const exit = yield* Effect.exit(Stream.runCollect(stream))
 *   const message = Exit.match(exit, {
 *     onSuccess: () => "Exit.Success",
 *     onFailure: (cause) => {
 *       const reason = cause.reasons[0]
 *       const defect = Cause.isDieReason(reason) ? String(reason.defect) : "Unexpected reason"
 *       return `Exit.Failure(${defect})`
 *     }
 *   })
 *   yield* Console.log(message)
 * })
 *
 * Effect.runPromise(program)
 * // Output: Exit.Failure(Error: Boom)
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const die = (defect: unknown): Stream<never> => fromChannel(Channel.die(defect))

/**
 * The stream that always fails with the specified lazily evaluated `Cause`.
 *
 * @example
 * ```ts
 * import { Cause, Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.failCauseSync(() =>
 *   Cause.fail("Connection timeout after retries")
 * )
 *
 * const program = Effect.gen(function*() {
 *   const exit = yield* Stream.runCollect(stream).pipe(Effect.exit)
 *   yield* Console.log(exit)
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // { _id: 'Exit', _tag: 'Failure', cause: { _id: 'Cause', _tag: 'Fail', failure: 'Connection timeout after retries' } }
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const failCauseSync = <E>(evaluate: LazyArg<Cause.Cause<E>>): Stream<never, E> =>
  fromChannel(Channel.failCauseSync(evaluate))

/**
 * Creates a stream that consumes values from an iterator.
 *
 * The `maxChunkSize` parameter controls how many values are pulled per chunk.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * function* numbers() {
 *   yield 1
 *   yield 2
 *   yield 3
 * }
 *
 * const stream = Stream.fromIteratorSucceed(numbers())
 *
 * const program = Effect.gen(function* () {
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const fromIteratorSucceed = <A>(iterator: IterableIterator<A>, maxChunkSize?: number): Stream<A> =>
  fromChannel(Channel.fromIteratorArray(() => iterator, maxChunkSize))

/**
 * Creates a new `Stream` from an iterable collection of values.
 *
 * **Options**
 *
 * - `chunkSize`: Maximum number of values emitted per chunk.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const numbers = [1, 2, 3]
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.fromIterable(numbers)
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const fromIterable = <A>(
  iterable: Iterable<A>,
  options?: {
    readonly chunkSize?: number | undefined
  }
): Stream<A> =>
  Array.isArray(iterable) && options?.chunkSize === undefined
    ? fromArray(iterable)
    : fromChannel(Channel.fromIterableArray(iterable, options?.chunkSize))

/**
 * Creates a stream from an effect producing an iterable of values.
 *
 * @example
 * ```ts
 * import { Console, Effect, Context, Stream } from "effect"
 *
 * class UserRepo extends Context.Service<UserRepo, {
 *   readonly list: Effect.Effect<ReadonlyArray<string>>
 * }>()("UserRepo") {}
 *
 * const listUsers = Effect.service(UserRepo).pipe(
 *   Effect.andThen((repo) => repo.list)
 * )
 *
 * const stream = Stream.fromIterableEffect(listUsers)
 *
 * const program = Effect.gen(function*() {
 *   const users = yield* stream.pipe(
 *     Stream.provideService(UserRepo, {
 *       list: Effect.succeed(["user1", "user2"])
 *     }),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(users)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "user1", "user2" ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const fromIterableEffect = <A, E, R>(iterable: Effect.Effect<Iterable<A>, E, R>): Stream<A, E, R> =>
  unwrap(Effect.map(iterable, fromIterable))

/**
 * Creates a stream by repeatedly running an effect that yields an iterable of values.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.repeatEffectChunk`
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.fromIterableEffectRepeat(Effect.succeed([1, 2])).pipe(
 *     Stream.take(5)
 *   )
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 1, 2, 1 ]
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const fromIterableEffectRepeat = <A, E, R>(
  iterable: Effect.Effect<Iterable<A>, E, R>
): Stream<A, Pull.ExcludeDone<E>, R> => flatMap(fromEffectRepeat(iterable), fromIterable)

/**
 * Creates a stream from an array of values.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.fromChunk`
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.fromArray([1, 2, 3])
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const fromArray = <A>(array: ReadonlyArray<A>): Stream<A> =>
  Arr.isReadonlyArrayNonEmpty(array) ? fromChannel(Channel.succeed(array)) : empty

/**
 * Creates a stream from an effect that produces an array of values.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.fromArrayEffect(Effect.succeed(["Ada", "Grace"]))
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "Ada", "Grace" ]
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const fromArrayEffect = <A, E, R>(
  effect: Effect.Effect<ReadonlyArray<A>, E, R>
): Stream<A, Pull.ExcludeDone<E>, R> => unwrap(Effect.map(effect, fromArray)) as any

/**
 * Creates a stream from an arbitrary number of arrays.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.fromChunks`
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.fromArrays([1, 2], [3, 4])
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3, 4 ]
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const fromArrays = <Arr extends ReadonlyArray<ReadonlyArray<any>>>(
  ...arrays: Arr
): Stream<Arr[number][number]> => fromChannel(Channel.fromArray(Arr.filter(arrays, Arr.isReadonlyArrayNonEmpty)))

/**
 * Creates a stream from a queue of values.
 *
 * **Options**
 *
 * - `maxChunkSize`: The maximum number of queued elements to put in one chunk in the stream
 * - `shutdown`: If `true`, the queue will be shutdown after the stream is evaluated (defaults to `false`)
 *
 * @example
 * ```ts
 * import { Console, Effect, Queue, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.unbounded<number>()
 *   yield* Queue.offer(queue, 1)
 *   yield* Queue.offer(queue, 2)
 *   yield* Queue.offer(queue, 3)
 *   yield* Queue.shutdown(queue)
 *
 *   const stream = Stream.fromQueue(queue)
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const fromQueue = <A, E>(queue: Queue.Dequeue<A, E>): Stream<A, Exclude<E, Cause.Done>> =>
  fromChannel(Channel.fromQueueArray(queue))

/**
 * Creates a stream from a subscription to a `PubSub`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Fiber, PubSub, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.unbounded<number>()
 *
 *   const fiber = yield* Stream.fromPubSub(pubsub).pipe(
 *     Stream.take(3),
 *     Stream.runCollect,
 *     Effect.forkChild
 *   )
 *
 *   yield* PubSub.publish(pubsub, 1)
 *   yield* PubSub.publish(pubsub, 2)
 *   yield* PubSub.publish(pubsub, 3)
 *
 *   const values = yield* Fiber.join(fiber)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const fromPubSub = <A>(pubsub: PubSub.PubSub<A>): Stream<A> => fromChannel(Channel.fromPubSubArray(pubsub))

/**
 * Creates a stream from a PubSub of `Take` values.
 *
 * `Take` values include end and failure signals.
 *
 * @example
 * ```ts
 * import { Console, Effect, Exit, PubSub, Stream, Take } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pubsub = yield* PubSub.unbounded<Take.Take<number, string>>({
 *     replay: 3
 *   })
 *
 *   yield* PubSub.publish(pubsub, [1])
 *   yield* PubSub.publish(pubsub, [2])
 *   yield* PubSub.publish(pubsub, Exit.succeed<void>(undefined))
 *
 *   const values = yield* Stream.fromPubSubTake(pubsub).pipe(Stream.runCollect)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2 ]
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const fromPubSubTake = <A, E>(pubsub: PubSub.PubSub<Take.Take<A, E>>): Stream<A, E> =>
  fromChannel(Channel.fromPubSubTake(pubsub))

/**
 * Creates a stream from a `ReadableStream`.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream.
 *
 * @example
 * ```ts
 * import { Console, Data, Effect, Stream } from "effect"
 *
 * class StreamError extends Data.TaggedError("StreamError")<{ readonly cause: unknown }> {}
 *
 * const readableStream = new ReadableStream({
 *   start(controller) {
 *     controller.enqueue(1)
 *     controller.enqueue(2)
 *     controller.enqueue(3)
 *     controller.close()
 *   }
 * })
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.fromReadableStream({
 *     evaluate: () => readableStream,
 *     onError: (cause) => new StreamError({ cause })
 *   })
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const fromReadableStream = <A, E>(
  options: {
    readonly evaluate: LazyArg<ReadableStream<A>>
    readonly onError: (error: unknown) => E
    readonly releaseLockOnEnd?: boolean | undefined
  }
): Stream<A, E> =>
  fromChannel(Channel.fromTransform(Effect.fnUntraced(function*(_, scope) {
    const reader = options.evaluate().getReader()
    yield* Scope.addFinalizer(
      scope,
      options.releaseLockOnEnd
        ? Effect.sync(() => reader.releaseLock())
        : Effect.promise(() => reader.cancel())
    )
    return Effect.flatMap(
      Effect.tryPromise({
        try: () => reader.read(),
        catch: (reason) => options.onError(reason)
      }),
      ({ done, value }) => done ? Cause.done() : Effect.succeed(Arr.of(value))
    )
  })))

/**
 * Creates a stream from an AsyncIterable.
 *
 * @example
 * ```ts
 * import { Console, Data, Effect, Stream } from "effect"
 *
 * class StreamError extends Data.TaggedError("StreamError")<{ readonly cause: unknown }> {}
 *
 * const iterable = (async function*() {
 *   yield 1
 *   yield 2
 *   yield 3
 * })()
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.fromAsyncIterable(iterable, (cause) => new StreamError({ cause }))
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const fromAsyncIterable = <A, E>(
  iterable: AsyncIterable<A>,
  onError: (error: unknown) => E
): Stream<A, E> => fromChannel(Channel.fromAsyncIterableArray(iterable, onError))

/**
 * Creates a stream that emits each output of a schedule that does not require input,
 * for as long as the schedule continues.
 *
 * @example
 * ```ts
 * import { Console, Effect, Schedule, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const schedule = Schedule.spaced("50 millis").pipe(
 *     Schedule.both(Schedule.recurs(2))
 *   )
 *   const stream = Stream.fromSchedule(schedule)
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 0, 1, 2 ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const fromSchedule = <O, E, R>(schedule: Schedule.Schedule<O, unknown, E, R>): Stream<O, E, R> =>
  fromPull(
    Effect.map(
      Schedule.toStepWithSleep(schedule),
      (step) => Pull.catchDone(Effect.map(step(void 0), Arr.of), () => Cause.done())
    )
  )

/**
 * Creates a stream from a PubSub subscription.
 *
 * Use `PubSub.subscribe` to create the subscription and `Stream.take` or
 * cancellation to control how many values are consumed.
 *
 * @example
 * ```ts
 * import { Console, Effect, PubSub, Stream } from "effect"
 *
 * const program = Effect.scoped(Effect.gen(function*() {
 *   const pubsub = yield* PubSub.unbounded<number>()
 *   const subscription = yield* PubSub.subscribe(pubsub)
 *
 *   yield* PubSub.publish(pubsub, 1)
 *   yield* PubSub.publish(pubsub, 2)
 *
 *   const stream = Stream.fromSubscription(subscription)
 *   const values = yield* stream.pipe(Stream.take(2), Stream.runCollect)
 *   yield* Console.log(values)
 * }))
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2 ]
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const fromSubscription = <A>(pubsub: PubSub.Subscription<A>): Stream<A> =>
  fromChannel(Channel.fromSubscriptionArray(pubsub))

/**
 * Interface representing an event listener target.
 *
 * @since 3.4.0
 * @category Models
 */
export interface EventListener<A> {
  addEventListener(
    event: string,
    f: (event: A) => void,
    options?: {
      readonly capture?: boolean
      readonly passive?: boolean
      readonly once?: boolean
      readonly signal?: AbortSignal
    } | boolean
  ): void
  removeEventListener(
    event: string,
    f: (event: A) => void,
    options?: {
      readonly capture?: boolean
    } | boolean
  ): void
}

/**
 * Creates a stream from an event listener.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * declare const target: Stream.EventListener<number>
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.fromEventListener(target, "data").pipe(
 *     Stream.take(3)
 *   )
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 3.1.0
 * @category Constructors
 */
export const fromEventListener = <A = unknown>(
  target: EventListener<A>,
  type: string,
  options?: boolean | {
    readonly capture?: boolean
    readonly passive?: boolean
    readonly once?: boolean
    readonly bufferSize?: number | undefined
  } | undefined
): Stream<A> =>
  callback<A>((queue) => {
    function emit(event: A) {
      Queue.offerUnsafe(queue, event)
    }
    return Effect.acquireRelease(
      Effect.sync(() => target.addEventListener(type, emit, options)),
      () => Effect.sync(() => target.removeEventListener(type, emit, options))
    )
  }, { bufferSize: typeof options === "object" ? options.bufferSize : undefined })

/**
 * Creates a stream by peeling off successive layers of a state value.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.unfold(1, (n) => Effect.succeed([n, n + 1] as const))
 *   const values = yield* Stream.runCollect(stream.pipe(Stream.take(5)))
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3, 4, 5 ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const unfold = <S, A, E, R>(
  s: S,
  f: (s: S) => Effect.Effect<readonly [A, S] | undefined, E, R>
): Stream<A, E, R> =>
  fromPull(Effect.sync(() => {
    let state = s
    return Effect.flatMap(Effect.suspend(() => f(state)), (next) => {
      if (next === undefined) return Cause.done()
      state = next[1]
      return Effect.succeed(Arr.of(next[0]))
    })
  }))

/**
 * Like `Stream.unfold`, but allows the emission of values to end one step further
 * than the unfolding of the state. This is useful for embedding paginated APIs,
 * hence the name.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 * import * as Option from "effect/Option"
 *
 * const stream = Stream.paginate(0, (n: number) =>
 *   Effect.succeed(
 *     [
 *       [n],
 *       n < 3 ? Option.some(n + 1) : Option.none<number>()
 *     ] as const
 *   ))
 *
 * Effect.runPromise(Stream.runCollect(stream)).then(console.log)
 * // Output: [ 0, 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const paginate = <S, A, E = never, R = never>(
  s: S,
  f: (
    s: S
  ) => Effect.Effect<readonly [ReadonlyArray<A>, Option.Option<S>], E, R>
): Stream<A, E, R> =>
  fromPull(Effect.sync(() => {
    let state = s
    let done = false
    return Effect.suspend(function loop(): Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void, R> {
      if (done) return Cause.done()
      return Effect.flatMap(f(state), ([a, s]) => {
        if (Option.isNone(s)) {
          done = true
        } else {
          state = s.value
        }
        if (!Arr.isReadonlyArrayNonEmpty(a)) return loop()
        return Effect.succeed(a)
      })
    })
  }))

/**
 * Creates an infinite stream by repeatedly applying a function to a seed value.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.iterate(1, (n) => n + 1).pipe(Stream.take(3))
 *
 * const program = Effect.gen(function* () {
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const iterate = <A>(value: A, next: (value: A) => A): Stream<A> =>
  unfold(value, (a) => Effect.succeed([a, next(a)]))

/**
 * Constructs a stream from a range of integers, including both endpoints.
 *
 * If the provided `min` is greater than `max`, the stream will not emit any
 * values.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.range(1, 5).pipe(Stream.runCollect)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3, 4, 5 ]
 * ```
 * @since 4.0.0
 * @category Constructors
 */
export const range = (
  min: number,
  max: number,
  chunkSize = Channel.DefaultChunkSize
): Stream<number> =>
  min > max ? empty : fromPull(Effect.sync(() => {
    let start = min
    let done = false
    return Effect.suspend(() => {
      if (done) return Cause.done()
      const remaining = max - start + 1
      if (remaining > chunkSize) {
        const chunk = Arr.range(start, start + chunkSize - 1)
        start += chunkSize
        return Effect.succeed(chunk)
      }
      const chunk = Arr.range(start, start + remaining - 1)
      done = true
      return Effect.succeed(chunk)
    })
  }))

/**
 * The stream that never produces any value or fails with any error.
 *
 * @example
 * ```ts
 * import { Effect, Stream } from "effect"
 *
 * const program = Stream.never.pipe(
 *   Stream.take(0),
 *   Stream.runCollect
 * )
 *
 * Effect.runPromise(program).then(console.log)
 * // []
 * ```
 *
 * @since 4.0.0
 * @category Constructors
 */
export const never: Stream<never> = fromChannel(Channel.never)

/**
 * Creates a stream produced from an `Effect`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const effect = Effect.succeed(Stream.make(1, 2, 3))
 *
 * const stream = Stream.unwrap(effect)
 *
 * const program = Effect.gen(function*() {
 *   const chunk = yield* Stream.runCollect(stream)
 *   yield* Console.log(chunk)
 * })
 * // [1, 2, 3]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const unwrap = <A, E2, R2, E, R>(
  effect: Effect.Effect<Stream<A, E2, R2>, E, R>
): Stream<A, E | E2, R2 | Exclude<R, Scope.Scope>> => fromChannel(Channel.unwrap(Effect.map(effect, toChannel)))

/**
 * Runs a stream that requires `Scope` in a managed scope, ensuring its
 * finalizers are run when the stream completes.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.scoped(
 *   Stream.fromEffect(
 *     Effect.acquireRelease(
 *       Console.log("acquire").pipe(Effect.as("resource")),
 *       () => Console.log("release")
 *     )
 *   )
 * )
 *
 * Effect.runPromise(Stream.runCollect(stream)).then(console.log)
 * // acquire
 * // release
 * // [ "resource" ]
 * ```
 *
 * @since 2.0.0
 * @category Constructors
 */
export const scoped = <A, E, R>(
  self: Stream<A, E, R>
): Stream<A, E, Exclude<R, Scope.Scope>> => fromChannel(Channel.scoped(self.channel))

/**
 * Transforms the elements of this stream using the supplied function.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.fromArray([1, 2, 3]).pipe(Stream.map((n, i) => n + i))
 * const program = Stream.runCollect(stream).pipe(
 *   Effect.tap((values) => Console.log(values))
 * )
 *
 * Effect.runPromise(program)
 * // [ 1, 3, 5 ]
 * ```
 *
 * @since 2.0.0
 * @category Mapping
 */
export const map: {
  <A, B>(f: (a: A, i: number) => B): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>
  <A, E, R, B>(self: Stream<A, E, R>, f: (a: A, i: number) => B): Stream<B, E, R>
} = dual(2, <A, E, R, B>(self: Stream<A, E, R>, f: (a: A, i: number) => B): Stream<B, E, R> =>
  suspend(() => {
    let i = 0
    return fromChannel(Channel.map(
      self.channel,
      Arr.map((o) => f(o, i++))
    ))
  }))

/**
 * Maps both the failure and success channels of a stream.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const mapper = {
 *   onFailure: (error: string) => `error: ${error}`,
 *   onSuccess: (value: number) => value * 2
 * }
 *
 * const program = Effect.gen(function*() {
 *   const success = yield* Stream.make(1, 2).pipe(
 *     Stream.mapBoth(mapper),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(success)
 *
 *   const failure = yield* Stream.fail("boom").pipe(
 *     Stream.mapBoth(mapper),
 *     Stream.catch((error: string) => Stream.succeed(error)),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(failure)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 2, 4 ]
 * // Output: [ "error: boom" ]
 * ```
 *
 * @since 2.0.0
 * @category Mapping
 */
export const mapBoth: {
  <E, E2, A, A2>(
    options: { readonly onFailure: (e: E) => E2; readonly onSuccess: (a: A) => A2 }
  ): <R>(self: Stream<A, E, R>) => Stream<A2, E2, R>
  <A, E, R, E2, A2>(
    self: Stream<A, E, R>,
    options: { readonly onFailure: (e: E) => E2; readonly onSuccess: (a: A) => A2 }
  ): Stream<A2, E2, R>
} = dual(2, <A, E, R, E2, A2>(
  self: Stream<A, E, R>,
  options: { readonly onFailure: (e: E) => E2; readonly onSuccess: (a: A) => A2 }
): Stream<A2, E2, R> =>
  self.pipe(
    map(options.onSuccess),
    mapError(options.onFailure)
  ))

/**
 * Transforms each emitted chunk using the provided function, which receives the chunk and its index.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.mapChunks`
 *
 * @example
 * ```ts
 * import { Array, Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.make(1, 2, 3, 4).pipe(
 *     Stream.rechunk(2),
 *     Stream.mapArray((chunk, index) => Array.map(chunk, (n) => n + index)),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 4, 5 ]
 * ```
 *
 * @since 2.0.0
 * @category Mapping
 */
export const mapArray: {
  <A, B>(
    f: (a: Arr.NonEmptyReadonlyArray<A>, i: number) => Arr.NonEmptyReadonlyArray<B>
  ): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>
  <A, E, R, B>(
    self: Stream<A, E, R>,
    f: (a: Arr.NonEmptyReadonlyArray<A>, i: number) => Arr.NonEmptyReadonlyArray<B>
  ): Stream<B, E, R>
} = dual(2, <A, E, R, B>(
  self: Stream<A, E, R>,
  f: (a: Arr.NonEmptyReadonlyArray<A>, i: number) => Arr.NonEmptyReadonlyArray<B>
): Stream<B, E, R> => fromChannel(Channel.map(self.channel, f)))

/**
 * Maps over elements of the stream with the specified effectful function.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3)
 *
 * const mappedStream = stream.pipe(
 *   Stream.mapEffect((n) =>
 *     Effect.gen(function*() {
 *       yield* Console.log(`Processing: ${n}`)
 *       return n * 2
 *     })
 *   )
 * )
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(mappedStream)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // Processing: 1
 * // Processing: 2
 * // Processing: 3
 * // [2, 4, 6]
 * ```
 *
 * @since 2.0.0
 * @category Mapping
 */
export const mapEffect: {
  <A, A2, E2, R2>(
    f: (a: A, i: number) => Effect.Effect<A2, E2, R2>,
    options?: {
      readonly concurrency?: number | "unbounded" | undefined
      readonly unordered?: boolean | undefined
    } | undefined
  ): <E, R>(self: Stream<A, E, R>) => Stream<A2, E2 | E, R2 | R>
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    f: (a: A, i: number) => Effect.Effect<A2, E2, R2>,
    options?: {
      readonly concurrency?: number | "unbounded" | undefined
      readonly unordered?: boolean | undefined
    } | undefined
  ): Stream<A2, E | E2, R | R2>
} = dual((args) => isStream(args[0]), <A, E, R, A2, E2, R2>(
  self: Stream<A, E, R>,
  f: (a: A, i: number) => Effect.Effect<A2, E2, R2>,
  options?: {
    readonly concurrency?: number | "unbounded" | undefined
    readonly unordered?: boolean | undefined
  } | undefined
): Stream<A2, E | E2, R | R2> =>
  self.channel.pipe(
    Channel.flattenArray,
    Channel.mapEffect(f, options),
    Channel.map(Arr.of),
    fromChannel
  ))

/**
 * Flattens a stream of `Effect` values into a stream of their results.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(Effect.succeed(1), Effect.succeed(2), Effect.succeed(3))
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(stream.pipe(Stream.flattenEffect()))
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [1, 2, 3]
 * ```
 *
 * @since 2.0.0
 * @category Mapping
 */
export const flattenEffect: <
  Arg extends Stream<Effect.Effect<any, any, any>, any, any> | {
    readonly concurrency?: number | "unbounded" | undefined
    readonly unordered?: boolean | undefined
  } | undefined = {
    readonly concurrency?: number | "unbounded" | undefined
    readonly unordered?: boolean | undefined
  }
>(
  selfOrOptions?: Arg,
  options?: {
    readonly concurrency?: number | "unbounded" | undefined
    readonly unordered?: boolean | undefined
  } | undefined
) => [Arg] extends [Stream<Effect.Effect<infer _A, infer _EX, infer _RX>, infer _E, infer _R>] ?
  Stream<_A, _EX | _E, _RX | _R>
  : <A, EX, RX, E, R>(self: Stream<Effect.Effect<A, EX, RX>, E, R>) => Stream<A, EX | E, RX | R> = dual(
    (args) => isStream(args[0]),
    <A, E, R, EX, RX>(
      self: Stream<Effect.Effect<A, EX, RX>, E, R>,
      options?: {
        readonly concurrency?: number | "unbounded" | undefined
        readonly unordered?: boolean | undefined
      } | undefined
    ): Stream<A, EX | E, RX | R> => mapEffect(self, identity, options)
  )

/**
 * Effectfully maps over non-empty array chunks emitted by the stream.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.mapChunksEffect`
 *
 * @example
 * ```ts
 * import { Array, Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.fromArray([1, 2, 3, 4]).pipe(
 *     Stream.rechunk(2),
 *     Stream.mapArrayEffect((chunk, index) =>
 *       Effect.succeed(Array.map(chunk, (n) => n + index * 10))
 *     ),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [1, 2, 13, 14]
 * ```
 *
 * @since 4.0.0
 * @category Mapping
 */
export const mapArrayEffect: {
  <A, B, E2, R2>(
    f: (a: Arr.NonEmptyReadonlyArray<A>, i: number) => Effect.Effect<Arr.NonEmptyReadonlyArray<B>, E2, R2>
  ): <E, R>(self: Stream<A, E, R>) => Stream<B, E | E2, R | R2>
  <A, E, R, B, E2, R2>(
    self: Stream<A, E, R>,
    f: (a: Arr.NonEmptyReadonlyArray<A>, i: number) => Effect.Effect<Arr.NonEmptyReadonlyArray<B>, E2, R2>
  ): Stream<B, E | E2, R | R2>
} = dual(2, <A, E, R, B, E2, R2>(
  self: Stream<A, E, R>,
  f: (a: Arr.NonEmptyReadonlyArray<A>, i: number) => Effect.Effect<Arr.NonEmptyReadonlyArray<B>, E2, R2>
): Stream<B, E | E2, R | R2> => fromChannel(Channel.mapEffect(self.channel, f)))

/**
 * Lifts failures and successes into a `Result`, yielding a stream that cannot fail.
 *
 * The stream ends after the first failure, emitting a `Result.fail` value.
 *
 * **Previously Known As:**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.either`
 *
 * @example
 * ```ts
 * import { Console, Effect, Result, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const results = yield* Stream.make(1, 2).pipe(
 *     Stream.concat(Stream.fail("boom")),
 *     Stream.result,
 *     Stream.map(Result.match({
 *       onFailure: (error) => `failure: ${error}`,
 *       onSuccess: (value) => `success: ${value}`
 *     })),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(results)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "success: 1", "success: 2", "failure: boom" ]
 * ```
 *
 * @since 4.0.0
 * @category Error Handling
 */
export const result = <A, E, R>(self: Stream<A, E, R>): Stream<Result.Result<A, E>, never, R> =>
  self.pipe(
    map(Result.succeed),
    catch_((e) => succeed(Result.fail(e)))
  )

/**
 * Runs the provided effect for each element while preserving the elements.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.fromArray([1, 2, 3]).pipe(
 *     Stream.tap((n) => Console.log(`before mapping: ${n}`)),
 *     Stream.map((n) => n * 2),
 *     Stream.tap((n) => Console.log(`after mapping: ${n}`)),
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // before mapping: 1
 * // after mapping: 2
 * // before mapping: 2
 * // after mapping: 4
 * // before mapping: 3
 * // after mapping: 6
 * // [ 2, 4, 6 ]
 * ```
 *
 * @since 2.0.0
 * @category Sequencing
 */
export const tap: {
  <A, X, E2, R2>(
    f: (a: NoInfer<A>) => Effect.Effect<X, E2, R2>,
    options?: {
      readonly concurrency?: number | "unbounded" | undefined
    } | undefined
  ): <E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>
  <A, E, R, X, E2, R2>(
    self: Stream<A, E, R>,
    f: (a: NoInfer<A>) => Effect.Effect<X, E2, R2>,
    options?: {
      readonly concurrency?: number | "unbounded" | undefined
    } | undefined
  ): Stream<A, E | E2, R | R2>
} = dual((args) => isStream(args[0]), <A, E, R, X, E2, R2>(
  self: Stream<A, E, R>,
  f: (a: NoInfer<A>) => Effect.Effect<X, E2, R2>,
  options?: {
    readonly concurrency?: number | "unbounded" | undefined
  } | undefined
): Stream<A, E | E2, R | R2> =>
  mapEffect(
    self,
    (a) => Effect.as(f(a), a),
    options
  ))

/**
 * Returns a stream that effectfully "peeks" at elements and failures.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.make(1, 2).pipe(
 *     Stream.concat(Stream.fail("boom")),
 *     Stream.tapBoth({
 *       onElement: (value) => Console.log(`seen: ${value}`),
 *       onError: (error) => Console.log(`error: ${error}`)
 *     }),
 *     Stream.catch(() => Stream.make(3))
 *   )
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // seen: 1
 * // seen: 2
 * // error: boom
 * // [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Sequencing
 */
export const tapBoth: {
  <A, E, X, E2, R2, Y, E3, R3>(
    options: {
      readonly onElement: (a: NoInfer<A>) => Effect.Effect<X, E2, R2>
      readonly onError: (a: NoInfer<E>) => Effect.Effect<Y, E3, R3>
      readonly concurrency?: number | "unbounded" | undefined
    }
  ): <R>(self: Stream<A, E, R>) => Stream<A, E | E2 | E3, R | R2 | R3>
  <A, E, R, X, E2, R2, Y, E3, R3>(
    self: Stream<A, E, R>,
    options: {
      readonly onElement: (a: NoInfer<A>) => Effect.Effect<X, E2, R2>
      readonly onError: (a: NoInfer<E>) => Effect.Effect<Y, E3, R3>
      readonly concurrency?: number | "unbounded" | undefined
    }
  ): Stream<A, E | E2 | E3, R | R2 | R3>
} = dual(2, <A, E, R, X, E2, R2, Y, E3, R3>(
  self: Stream<A, E, R>,
  options: {
    readonly onElement: (a: NoInfer<A>) => Effect.Effect<X, E2, R2>
    readonly onError: (a: NoInfer<E>) => Effect.Effect<Y, E3, R3>
    readonly concurrency?: number | "unbounded" | undefined
  }
): Stream<A, E | E2 | E3, R | R2 | R3> =>
  self.pipe(
    tapError(options.onError),
    tap(options.onElement, { concurrency: options.concurrency })
  ))

/**
 * Sends all elements emitted by this stream to the specified sink in addition
 * to emitting them.
 *
 * @example
 * ```ts
 * import { Console, Effect, Ref, Sink, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const seen = yield* Ref.make<Array<number>>([])
 *   const sink = Sink.forEach((value: number) =>
 *     Ref.update(seen, (items) => [...items, value])
 *   )
 *   const result = yield* Stream.make(1, 2, 3).pipe(
 *     Stream.tapSink(sink),
 *     Stream.runCollect
 *   )
 *   const tapped = yield* Ref.get(seen)
 *   yield* Console.log(tapped)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [1, 2, 3]
 * // Output: [1, 2, 3]
 * ```
 *
 * @since 2.0.0
 * @category Sequencing
 */
export const tapSink: {
  <A, E2, R2>(sink: Sink.Sink<unknown, A, unknown, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>
  <A, E, R, E2, R2>(self: Stream<A, E, R>, sink: Sink.Sink<unknown, A, unknown, E2, R2>): Stream<A, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, E2, R2>(
    self: Stream<A, E, R>,
    sink: Sink.Sink<unknown, A, unknown, E2, R2>
  ): Stream<A, E | E2, R | R2> =>
    transformPullBracket(
      self,
      Effect.fnUntraced(function*(pull, _, scope) {
        const upstreamLatch = Latch.makeUnsafe()
        const sinkLatch = Latch.makeUnsafe()
        let chunk: Arr.NonEmptyReadonlyArray<A> | undefined = undefined
        let causeSink: Cause.Cause<E2> | undefined = undefined
        let sinkDone = false
        let streamDone = false

        const sinkUpstream = upstreamLatch.whenOpen(Effect.suspend(() => {
          if (chunk) {
            const arr = chunk!
            chunk = undefined
            if (!streamDone) upstreamLatch.closeUnsafe()
            return Effect.as(sinkLatch.open, arr)
          }
          return Cause.done()
        }))

        yield* Effect.suspend(() => sink.transform(sinkUpstream, scope)).pipe(
          (eff) =>
            Effect.onExitPrimitive(eff, (exit) => {
              sinkDone = true
              if (Exit.isFailure(exit)) {
                causeSink = exit.cause
              }
              return sinkLatch.open
            }, true),
          Effect.forkIn(scope)
        )

        const pullAndOffer = pull.pipe(
          Effect.flatMap((chunk_) => {
            chunk = chunk_
            sinkLatch.closeUnsafe()
            upstreamLatch.openUnsafe()
            return Effect.as(sinkLatch.await, chunk_)
          }),
          Pull.catchDone(() => {
            streamDone = true
            sinkLatch.closeUnsafe()
            upstreamLatch.openUnsafe()
            return Effect.flatMap(sinkLatch.await, () => Cause.done())
          })
        )

        return Effect.suspend((): Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E | E2, void, R> => {
          if (causeSink) {
            return Effect.failCause(causeSink)
          } else if (sinkDone) {
            return pull
          }
          return pullAndOffer
        })
      })
    )
)

/**
 * Maps each element to a stream and concatenates the results in order.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make(1, 2, 3).pipe(
 *     Stream.flatMap((n) => Stream.make(n, n * 2)),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 2, 4, 3, 6 ]
 * ```
 *
 * @since 2.0.0
 * @category Mapping
 */
export const flatMap: {
  <A, A2, E2, R2>(
    f: (a: A) => Stream<A2, E2, R2>,
    options?: {
      readonly concurrency?: number | "unbounded" | undefined
      readonly bufferSize?: number | undefined
    } | undefined
  ): <E, R>(self: Stream<A, E, R>) => Stream<A2, E2 | E, R2 | R>
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    f: (a: A) => Stream<A2, E2, R2>,
    options?: {
      readonly concurrency?: number | "unbounded" | undefined
      readonly bufferSize?: number | undefined
    } | undefined
  ): Stream<A2, E | E2, R | R2>
} = dual((args) => isStream(args[0]), <A, E, R, A2, E2, R2>(
  self: Stream<A, E, R>,
  f: (a: A) => Stream<A2, E2, R2>,
  options?: {
    readonly concurrency?: number | "unbounded" | undefined
    readonly bufferSize?: number | undefined
  } | undefined
): Stream<A2, E | E2, R | R2> =>
  self.channel.pipe(
    Channel.flattenArray,
    Channel.flatMap((a) => f(a).channel, options),
    fromChannel
  ))

/**
 * Switches to the latest stream produced by the mapping function, interrupting
 * the previous stream when a new element arrives.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Stream.make(1, 2, 3).pipe(
 *   Stream.switchMap((n) => (n === 3 ? Stream.make(n) : Stream.never)),
 *   Stream.runCollect
 * )
 *
 * Effect.gen(function*() {
 *   const result = yield* program
 *   yield* Console.log(result)
 *   // Output: [ 3 ]
 * })
 * ```
 *
 * @since 4.0.0
 * @category Sequencing
 */
export const switchMap: {
  <A, A2, E2, R2>(
    f: (a: A) => Stream<A2, E2, R2>,
    options?: {
      readonly concurrency?: number | "unbounded" | undefined
      readonly bufferSize?: number | undefined
    } | undefined
  ): <E, R>(self: Stream<A, E, R>) => Stream<A2, E2 | E, R2 | R>
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    f: (a: A) => Stream<A2, E2, R2>,
    options?: {
      readonly concurrency?: number | "unbounded" | undefined
      readonly bufferSize?: number | undefined
    } | undefined
  ): Stream<A2, E | E2, R | R2>
} = dual((args) => isStream(args[0]), <A, E, R, A2, E2, R2>(
  self: Stream<A, E, R>,
  f: (a: A) => Stream<A2, E2, R2>,
  options?: {
    readonly concurrency?: number | "unbounded" | undefined
    readonly bufferSize?: number | undefined
  } | undefined
): Stream<A2, E | E2, R | R2> =>
  self.channel.pipe(
    Channel.flattenArray,
    Channel.switchMap((a) => f(a).channel, options),
    fromChannel
  ))

/**
 * Flattens a stream of streams into a single stream by concatenating the
 * inner streams in strict order.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const streamOfStreams = Stream.make(
 *   Stream.make(1, 2),
 *   Stream.make(3, 4),
 *   Stream.make(5, 6)
 * )
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(Stream.flatten(streamOfStreams))
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3, 4, 5, 6 ]
 * ```
 *
 * @since 2.0.0
 * @category Mapping
 */
export const flatten: <
  Arg extends Stream<Stream<any, any, any>, any, any> | {
    readonly concurrency?: number | "unbounded" | undefined
    readonly bufferSize?: number | undefined
  } | undefined = {
    readonly concurrency?: number | "unbounded" | undefined
    readonly bufferSize?: number | undefined
  }
>(
  selfOrOptions?: Arg,
  options?: {
    readonly concurrency?: number | "unbounded" | undefined
    readonly bufferSize?: number | undefined
  } | undefined
) => [Arg] extends [Stream<Stream<infer _A, infer _E, infer _R>, infer _E2, infer _R2>] ? Stream<_A, _E | _E2, _R | _R2>
  : <A, E, R, E2, R2>(self: Stream<Stream<A, E, R>, E2, R2>) => Stream<A, E | E2, R | R2> = dual(
    (args) => isStream(args[0]),
    <A, E, R, E2, R2>(
      self: Stream<Stream<A, E, R>, E2, R2>,
      options?: {
        readonly concurrency?: number | "unbounded" | undefined
        readonly bufferSize?: number | undefined
      } | undefined
    ): Stream<A, E | E2, R | R2> => flatMap(self, identity, options)
  )

/**
 * Flattens a stream of non-empty arrays into a stream of elements.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.flattenChunks`
 *
 * @example
 * ```ts
 * import { Array, Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(Array.make(1, 2), Array.make(3))
 *
 * const program = Effect.gen(function* () {
 *   const result = yield* Stream.runCollect(Stream.flattenArray(stream))
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 4.0.0
 * @category Sequencing
 */
export const flattenArray = <A, E, R>(self: Stream<Arr.NonEmptyReadonlyArray<A>, E, R>): Stream<A, E, R> =>
  fromChannel(Channel.flattenArray(self.channel))

/**
 * Converts this stream to one that runs its effects but emits no elements.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.range(1, 6).pipe(Stream.drain, Stream.runCollect)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: []
 * ```
 *
 * @since 2.0.0
 * @category Sequencing
 */
export const drain = <A, E, R>(self: Stream<A, E, R>): Stream<never, E, R> => fromChannel(Channel.drain(self.channel))

/**
 * Runs the provided stream in the background while this stream runs, interrupting it
 * when this stream completes and failing if the background stream fails or defects.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const foreground = Stream.make(1, 2)
 * const background = Stream.fromEffect(Console.log("background task"))
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* foreground.pipe(
 *     Stream.drainFork(background),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: background task
 * // Output: [ 1, 2 ]
 * ```
 *
 * @since 2.0.0
 * @category Sequencing
 */
export const drainFork: {
  <A2, E2, R2>(that: Stream<A2, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<A, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<A, E | E2, R | R2> =>
    mergeEffect(self, runDrain(that))
)

/**
 * Repeats the entire stream according to the provided schedule.
 *
 * @example
 * ```ts
 * import { Console, Effect, Schedule, Stream } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const result = yield* Stream.make(1).pipe(
 *     Stream.repeat(Schedule.recurs(4)),
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 1, 1, 1, 1 ]
 * ```
 *
 * @since 2.0.0
 * @category Sequencing
 */
export const repeat: {
  <B, E2, R2>(
    schedule:
      | Schedule.Schedule<B, void, E2, R2>
      | ((
        $: <SO, SE, SR>(_: Schedule.Schedule<SO, void, SE, SR>) => Schedule.Schedule<SO, void, SE, SR>
      ) => Schedule.Schedule<B, void, E2, R2>)
  ): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R2 | R>
  <A, E, R, B, E2, R2>(
    self: Stream<A, E, R>,
    schedule:
      | Schedule.Schedule<B, void, E2, R2>
      | ((
        $: <SO, SE, SR>(_: Schedule.Schedule<SO, void, SE, SR>) => Schedule.Schedule<SO, void, SE, SR>
      ) => Schedule.Schedule<B, void, E2, R2>)
  ): Stream<A, E | E2, R | R2>
} = dual(2, <A, E, R, B, E2, R2>(
  self: Stream<A, E, R>,
  schedule:
    | Schedule.Schedule<B, void, E2, R2>
    | ((
      $: <SO, SE, SR>(_: Schedule.Schedule<SO, void, SE, SR>) => Schedule.Schedule<SO, void, SE, SR>
    ) => Schedule.Schedule<B, void, E2, R2>)
): Stream<A, E | E2, R | R2> => fromChannel(Channel.repeat(self.channel, schedule)))

/**
 * Spaces the stream's elements according to the provided `schedule`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Schedule, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.make(1, 2, 3).pipe(
 *     Stream.schedule(Schedule.spaced("10 millis")),
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Rate Limiting
 */
export const schedule: {
  <X, E2, R2, A>(
    schedule: Schedule.Schedule<X, NoInfer<A>, E2, R2>
  ): <E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R2 | R>
  <A, E, R, X, E2, R2>(
    self: Stream<A, E, R>,
    schedule: Schedule.Schedule<X, NoInfer<A>, E2, R2>
  ): Stream<A, E | E2, R | R2>
} = dual(2, <A, E, R, X, E2, R2>(
  self: Stream<A, E, R>,
  schedule: Schedule.Schedule<X, NoInfer<A>, E2, R2>
): Stream<A, E | E2, R | R2> =>
  self.channel.pipe(
    Channel.flattenArray,
    Channel.schedule(schedule),
    Channel.map(Arr.of),
    fromChannel
  ))

/**
 * Ends the stream if it does not produce a value within the specified duration.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make(1).pipe(
 *     Stream.concat(Stream.never),
 *     Stream.timeout("1 second"),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1 ]
 * ```
 *
 * @since 2.0.0
 * @category Rate Limiting
 */
export const timeout: {
  (duration: Duration.Input): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R>(self: Stream<A, E, R>, duration: Duration.Input): Stream<A, E, R>
} = dual(
  2,
  <A, E, R>(self: Stream<A, E, R>, duration: Duration.Input): Stream<A, E, R> =>
    timeoutOrElse(self, {
      duration,
      orElse: () => empty
    })
)

/**
 * @since 2.0.0
 * @category Rate Limiting
 */
export const timeoutOrElse: {
  <B, E2, R2>(options: {
    readonly duration: Duration.Input
    readonly orElse: () => Stream<B, E2, R2>
  }): <A, E, R>(self: Stream<A, E, R>) => Stream<A | B, E | E2, R | R2>
  <A, E, R, B, E2, R2>(
    self: Stream<A, E, R>,
    options: {
      readonly duration: Duration.Input
      readonly orElse: () => Stream<B, E2, R2>
    }
  ): Stream<A | B, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, B, E2, R2>(
    self: Stream<A, E, R>,
    options: {
      readonly duration: Duration.Input
      readonly orElse: () => Stream<B, E2, R2>
    }
  ): Stream<A | B, E | E2, R | R2> => {
    const duration = Duration.fromInputUnsafe(options.duration)
    if (!Duration.isFinite(duration)) return self
    if (Duration.isZero(duration)) return suspend(options.orElse)
    const timeoutSymbol = Symbol()
    return catchCause(
      suspend(() => {
        const parent = Fiber.getCurrent()!
        const clock = parent.getRef(Clock)
        const durationMs = Duration.toMillis(duration)
        let deadline: number | undefined = undefined
        const latch = Latch.makeUnsafe(false)
        return merge(
          transformPull(self, (pull, _scope) =>
            Effect.suspend(() => {
              deadline = clock.currentTimeMillisUnsafe() + durationMs
              latch.openUnsafe()
              return pull
            }).pipe(
              Effect.map((arr) => {
                latch.closeUnsafe()
                deadline = undefined
                return arr
              }),
              Effect.succeed
            )),
          fromEffectDrain(Effect.gen(function*() {
            while (true) {
              yield* latch.await
              if (deadline === undefined) continue
              yield* Effect.sleep(deadline - clock.currentTimeMillisUnsafe())
              if (deadline === undefined) continue
              const remaining = deadline - clock.currentTimeMillisUnsafe()
              if (remaining > 0) continue
              return yield* Effect.die(timeoutSymbol)
            }
          })),
          { haltStrategy: "left" }
        )
      }),
      (cause): Stream<B, E | E2, R2> => {
        const isTimeout = cause.reasons.find((r) => r._tag === "Die" && r.defect === timeoutSymbol)
        if (isTimeout) return options.orElse()
        return failCause(cause as Cause.Cause<E>)
      }
    )
  }
)

/**
 * Repeats each element of the stream according to the provided schedule,
 * including the original emission.
 *
 * @since 2.0.0
 * @category Sequencing
 * @example
 * ```ts
 * import { Console, Effect, Schedule, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make("A", "B", "C").pipe(
 *     Stream.repeatElements(Schedule.recurs(1)),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "A", "A", "B", "B", "C", "C" ]
 * ```
 */
export const repeatElements: {
  <B, E2, R2>(
    schedule: Schedule.Schedule<B, unknown, E2, R2>
  ): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R2 | R>
  <A, E, R, B, E2, R2>(
    self: Stream<A, E, R>,
    schedule: Schedule.Schedule<B, unknown, E2, R2>
  ): Stream<A, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, B, E2, R2>(
    self: Stream<A, E, R>,
    schedule: Schedule.Schedule<B, unknown, E2, R2>
  ): Stream<A, E | E2, R | R2> =>
    fromChannel(Channel.fromTransform((upstream, scope) =>
      Effect.map(
        Channel.toTransform(Channel.flattenArray(self.channel))(upstream, scope),
        (pullElement) => {
          let pullRepeat: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E | E2, void, R | R2> | undefined = undefined

          const pull: Pull.Pull<
            Arr.NonEmptyReadonlyArray<A>,
            E,
            void,
            R | R2
          > = Effect.gen(function*() {
            const element = yield* pullElement
            const chunk = Arr.of(element)
            const step = yield* Schedule.toStepWithSleep(schedule)
            pullRepeat = step(element).pipe(
              Effect.as(chunk),
              Pull.catchDone((_) => {
                pullRepeat = undefined
                return pull
              })
            )
            return chunk
          })

          return Effect.suspend(() => pullRepeat ?? pull)
        }
      )
    ))
)

/**
 * Repeats this stream forever.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make("A", "B").pipe(
 *   Stream.forever,
 *   Stream.take(5)
 * )
 *
 * const program = Effect.gen(function*() {
 *   const output = yield* Stream.runCollect(stream)
 *   yield* Console.log(output)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "A", "B", "A", "B", "A" ]
 * ```
 *
 * @since 2.0.0
 * @category Sequencing
 */
export const forever = <A, E, R>(self: Stream<A, E, R>): Stream<A, E, R> => fromChannel(Channel.forever(self.channel))

/**
 * Submerges the iterables emitted by this stream into the stream's structure.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.flattenIterables`
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.make([1, 2], [3, 4]).pipe(Stream.flattenIterable)
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3, 4 ]
 * ```
 *
 * @since 4.0.0
 * @category Mapping
 */
export const flattenIterable = <A, E, R>(self: Stream<Iterable<A>, E, R>): Stream<A, E, R> =>
  flatMap(self, fromIterable)

/**
 * Unwraps `Take` values, emitting elements from non-empty arrays and ending or
 * failing when the `Exit` signals completion.
 *
 * @example
 * ```ts
 * import { Array, Console, Effect, Exit, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const takes = Stream.make(
 *     Array.make(1, 2),
 *     Array.make(3),
 *     Exit.succeed<void>(undefined)
 *   )
 *
 *   const values = yield* Stream.flattenTake(takes).pipe(Stream.runCollect)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 4.0.0
 * @category Sequencing
 */
export const flattenTake = <A, E, E2, R>(self: Stream<Take.Take<A, E>, E2, R>): Stream<A, E | E2, R> =>
  self.channel.pipe(
    Channel.flattenArray,
    Channel.flattenTake,
    fromChannel
  )

/**
 * Concatenates two streams, emitting all elements from the first stream
 * followed by all elements from the second stream.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.concat(Stream.make(1, 2, 3), Stream.make(4, 5, 6))
 *
 * Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 * // Output: [ 1, 2, 3, 4, 5, 6 ]
 * ```
 *
 * @since 2.0.0
 * @category Sequencing
 */
export const concat: {
  <A2, E2, R2>(that: Stream<A2, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A | A2, E | E2, R | R2>
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<A | A2, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<A | A2, E | E2, R | R2> =>
    flatten(fromArray<Stream<A | A2, E | E2, R | R2>>([self, that]))
)

/**
 * Prepends the values from the provided iterable before the stream's elements.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make(3, 4).pipe(
 *     Stream.prepend([1, 2]),
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(values)
 *   // Output: [ 1, 2, 3, 4 ]
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @since 2.0.0
 * @category Sequencing
 */
export const prepend: {
  <B>(values: Iterable<B>): <A, E, R>(self: Stream<A, E, R>) => Stream<B | A, E, R>
  <A, E, R, B>(self: Stream<A, E, R>, values: Iterable<B>): Stream<A | B, E, R>
} = dual(2, <A, E, R, B>(
  self: Stream<A, E, R>,
  values: Iterable<B>
): Stream<A | B, E, R> => concat(fromIterable(values), self))

/**
 * Merges two streams, emitting elements from both as they arrive.
 *
 * By default, the merged stream ends when both streams end. Use
 * `haltStrategy` to change the termination behavior.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const fast = Stream.make(1, 2, 3)
 * const slow = Stream.fromEffect(Effect.delay(Effect.succeed(4), "50 millis"))
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(Stream.merge(fast, slow))
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3, 4 ]
 * ```
 *
 * @since 2.0.0
 * @category Merging
 */
export const merge: {
  <A2, E2, R2>(
    that: Stream<A2, E2, R2>,
    options?: {
      readonly haltStrategy?: HaltStrategy | undefined
    } | undefined
  ): <A, E, R>(self: Stream<A, E, R>) => Stream<A | A2, E | E2, R | R2>
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    that: Stream<A2, E2, R2>,
    options?: {
      readonly haltStrategy?: HaltStrategy | undefined
    } | undefined
  ): Stream<A | A2, E | E2, R | R2>
} = dual(
  (args) => isStream(args[0]) && isStream(args[1]),
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    that: Stream<A2, E2, R2>,
    options?: {
      readonly haltStrategy?: HaltStrategy | undefined
    } | undefined
  ): Stream<A | A2, E | E2, R | R2> => fromChannel(Channel.merge(toChannel(self), toChannel(that), options))
)

/**
 * Merges this stream with a background effect, keeping the stream's elements.
 *
 * The effect runs concurrently, fails the stream if it fails, and is interrupted
 * when the stream completes.
 *
 * @since 4.0.0
 * @category Merging
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make(1, 2, 3).pipe(
 *     Stream.mergeEffect(Console.log("side task")),
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: side task
 * // Output: [ 1, 2, 3 ]
 * ```
 */
export const mergeEffect: {
  <A2, E2, R2>(effect: Effect.Effect<A2, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, effect: Effect.Effect<A2, E2, R2>): Stream<A, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, effect: Effect.Effect<A2, E2, R2>): Stream<A, E | E2, R | R2> =>
    self.channel.pipe(
      Channel.mergeEffect(effect),
      fromChannel
    )
)

/**
 * Merges this stream and the specified stream together, tagging values from the
 * left stream as `Result.succeed` and values from the right stream as `Result.fail`.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.mergeEither`
 *
 * @example
 * ```ts
 * import { Console, Effect, Result, Stream } from "effect"
 *
 * const left = Stream.fromEffect(Effect.succeed("left"))
 * const right = Stream.fromEffect(Effect.delay(Effect.succeed("right"), "10 millis"))
 *
 * const merged = left.pipe(
 *   Stream.mergeResult(right),
 *   Stream.map(
 *     Result.match({
 *       onFailure: (value) => `right:${value}`,
 *       onSuccess: (value) => `left:${value}`
 *     })
 *   )
 * )
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(merged)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "left:left", "right:right" ]
 * ```
 *
 * @since 2.0.0
 * @category Merging
 */
export const mergeResult: {
  <A2, E2, R2>(
    that: Stream<A2, E2, R2>
  ): <A, E, R>(self: Stream<A, E, R>) => Stream<Result.Result<A, A2>, E2 | E, R2 | R>
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<Result.Result<A, A2>, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    that: Stream<A2, E2, R2>
  ): Stream<Result.Result<A, A2>, E | E2, R | R2> =>
    merge(
      map(self, Result.succeed),
      map(that, Result.fail)
    )
)

/**
 * Merges two streams while emitting only the values from the left stream.
 *
 * The right stream still runs for its effects, and any failures from the right
 * stream are propagated. The merged stream completes when the left stream
 * completes, interrupting the right stream.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const left = Stream.make(1, 2)
 *   const right = Stream.make("a", "b")
 *   const values = yield* left.pipe(Stream.mergeLeft(right), Stream.runCollect)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2 ]
 * ```
 *
 * @since 2.0.0
 * @category Merging
 */
export const mergeLeft: {
  <AR, ER, RR>(right: Stream<AR, ER, RR>): <AL, EL, RL>(left: Stream<AL, EL, RL>) => Stream<AL, ER | EL, RR | RL>
  <AL, EL, RL, AR, ER, RR>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>): Stream<AL, EL | ER, RL | RR>
} = dual(
  2,
  <AL, EL, RL, AR, ER, RR>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>): Stream<AL, EL | ER, RL | RR> =>
    mergeEffect(left, runDrain(right))
)

/**
 * Merges this stream and the specified stream together, emitting only the
 * values from the right stream while the left stream runs for its effects.
 *
 * The merged stream ends when the right stream completes, interrupting the
 * left stream. Failures from the left stream still fail the merged stream.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const left = Stream.make("left-1", "left-2").pipe(
 *   Stream.tap(() => Effect.sync(() => undefined))
 * )
 * const right = Stream.make(1, 2)
 *
 * const merged = Stream.mergeRight(left, right)
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(merged)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2 ]
 * ```
 *
 * @since 2.0.0
 * @category Merging
 */
export const mergeRight: {
  <AR, ER, RR>(right: Stream<AR, ER, RR>): <AL, EL, RL>(left: Stream<AL, EL, RL>) => Stream<AR, ER | EL, RR | RL>
  <AL, EL, RL, AR, ER, RR>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>): Stream<AR, EL | ER, RL | RR>
} = dual(
  2,
  <AL, EL, RL, AR, ER, RR>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>): Stream<AR, EL | ER, RL | RR> =>
    mergeEffect(right, runDrain(left))
)

/**
 * Merges a collection of streams, running up to the specified number concurrently.
 *
 * @since 2.0.0
 * @category Merging
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const streams = [
 *   Stream.fromEffect(Effect.delay(Effect.succeed("A"), "20 millis")),
 *   Stream.fromEffect(Effect.delay(Effect.succeed("B"), "10 millis"))
 * ]
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.mergeAll(streams, { concurrency: 2 }).pipe(
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "B", "A" ]
 * ```
 */
export const mergeAll: {
  (
    options: {
      readonly concurrency: number | "unbounded"
      readonly bufferSize?: number | undefined
    }
  ): <A, E, R>(streams: Iterable<Stream<A, E, R>>) => Stream<A, E, R>
  <A, E, R>(
    streams: Iterable<Stream<A, E, R>>,
    options: {
      readonly concurrency: number | "unbounded"
      readonly bufferSize?: number | undefined
    }
  ): Stream<A, E, R>
} = dual(2, <A, E, R>(
  streams: Iterable<Stream<A, E, R>>,
  options: {
    readonly concurrency: number | "unbounded"
    readonly bufferSize?: number | undefined
  }
): Stream<A, E, R> => flatten(fromIterable(streams), options))

/**
 * Creates the cartesian product of two streams, running the `right` stream for
 * each element in the `left` stream.
 *
 * See also `Stream.zip` for the more common point-wise variant.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const left = Stream.make(1, 2)
 *   const right = Stream.make("a", "b")
 *   const values = yield* Stream.runCollect(Stream.cross(left, right))
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ [ 1, "a" ], [ 1, "b" ], [ 2, "a" ], [ 2, "b" ] ]
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const cross: {
  <AR, ER, RR>(right: Stream<AR, ER, RR>): <AL, EL, RL>(left: Stream<AL, EL, RL>) => Stream<[AL, AR], EL | ER, RL | RR>
  <AL, ER, RR, AR, EL, RL>(left: Stream<AL, ER, RR>, right: Stream<AR, EL, RL>): Stream<[AL, AR], EL | ER, RL | RR>
} = dual(2, <AL, EL, RL, AR, ER, RR>(
  left: Stream<AL, EL, RL>,
  right: Stream<AR, ER, RR>
): Stream<[AL, AR], EL | ER, RL | RR> => crossWith(left, right, (l, r) => [l, r]))

/**
 * Creates a cartesian product of elements from two streams using a function.
 *
 * The `right` stream is rerun for every element in the `left` stream.
 *
 * See also `Stream.zipWith` for the more common point-wise variant.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const left = Stream.make(1, 2)
 *   const right = Stream.make("a", "b")
 *   const combined = Stream.crossWith(left, right, (n, s) => `${n}-${s}`)
 *   const result = yield* Stream.runCollect(combined)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "1-a", "1-b", "2-a", "2-b" ]
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const crossWith: {
  <AR, ER, RR, AL, A>(
    right: Stream<AR, ER, RR>,
    f: (left: AL, right: AR) => A
  ): <EL, RL>(left: Stream<AL, EL, RL>) => Stream<A, EL | ER, RL | RR>
  <AL, EL, RL, AR, ER, RR, A>(
    left: Stream<AL, EL, RL>,
    right: Stream<AR, ER, RR>,
    f: (left: AL, right: AR) => A
  ): Stream<A, EL | ER, RL | RR>
} = dual(3, <AL, EL, RL, AR, ER, RR, A>(
  left: Stream<AL, EL, RL>,
  right: Stream<AR, ER, RR>,
  f: (left: AL, right: AR) => A
): Stream<A, EL | ER, RL | RR> => flatMap(left, (l) => map(right, (r) => f(l, r))))

/**
 * Zips two streams point-wise with a combining function, ending when either stream ends.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream1 = Stream.make(1, 2, 3, 4, 5, 6)
 * const stream2 = Stream.make("a", "b", "c")
 *
 * const zipped = Stream.zipWith(stream1, stream2, (n, s) => `${n}-${s}`)
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(zipped)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "1-a", "2-b", "3-c" ]
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const zipWith: {
  <AR, ER, RR, AL, A>(
    right: Stream<AR, ER, RR>,
    f: (left: AL, right: AR) => A
  ): <EL, RL>(left: Stream<AL, EL, RL>) => Stream<A, EL | ER, RL | RR>
  <AL, EL, RL, AR, ER, RR, A>(
    left: Stream<AL, EL, RL>,
    right: Stream<AR, ER, RR>,
    f: (left: AL, right: AR) => A
  ): Stream<A, EL | ER, RL | RR>
} = dual(3, <AL, EL, RL, AR, ER, RR, A>(
  left: Stream<AL, EL, RL>,
  right: Stream<AR, ER, RR>,
  f: (left: AL, right: AR) => A
): Stream<A, EL | ER, RL | RR> => zipWithArray(left, right, zipArrays(f)))

const zipArrays = <AL, AR, A>(
  f: (left: AL, right: AR) => A
) =>
(
  leftArr: Arr.NonEmptyReadonlyArray<AL>,
  rightArr: Arr.NonEmptyReadonlyArray<AR>
) => {
  const minLength = Math.min(leftArr.length, rightArr.length)
  const result: Arr.NonEmptyArray<A> = [] as any

  for (let i = 0; i < minLength; i++) {
    result.push(f(leftArr[i], rightArr[i]))
  }

  return [result, leftArr.slice(minLength), rightArr.slice(minLength)] as const
}

/**
 * Zips two streams by applying a function to non-empty arrays of elements.
 *
 * The function returns output plus leftover arrays that carry into the next pull.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.zipWithChunks`
 *
 * @example
 * ```ts
 * import { Array, Console, Effect, Stream } from "effect"
 *
 * const left = Stream.fromArrays([1, 2, 3], [4, 5])
 * const right = Stream.fromArrays(["a", "b"], ["c", "d", "e"])
 *
 * const zipped = Stream.zipWithArray(left, right, (leftChunk, rightChunk) => {
 *   const minLength = Math.min(leftChunk.length, rightChunk.length)
 *   const output = Array.makeBy(minLength, (i) => [leftChunk[i], rightChunk[i]] as const)
 *
 *   return [output, leftChunk.slice(minLength), rightChunk.slice(minLength)]
 * })
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(zipped)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [[1, "a"], [2, "b"], [3, "c"], [4, "d"], [5, "e"]]
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const zipWithArray: {
  <AR, ER, RR, AL, A>(
    right: Stream<AR, ER, RR>,
    f: (
      left: Arr.NonEmptyReadonlyArray<AL>,
      right: Arr.NonEmptyReadonlyArray<AR>
    ) => readonly [
      output: Arr.NonEmptyReadonlyArray<A>,
      leftoverLeft: ReadonlyArray<AL>,
      leftoverRight: ReadonlyArray<AR>
    ]
  ): <EL, RL>(left: Stream<AL, EL, RL>) => Stream<A, EL | ER, RL | RR>
  <AL, EL, RL, AR, ER, RR, A>(
    left: Stream<AL, EL, RL>,
    right: Stream<AR, ER, RR>,
    f: (
      left: Arr.NonEmptyReadonlyArray<AL>,
      right: Arr.NonEmptyReadonlyArray<AR>
    ) => readonly [
      output: Arr.NonEmptyReadonlyArray<A>,
      leftoverLeft: ReadonlyArray<AL>,
      leftoverRight: ReadonlyArray<AR>
    ]
  ): Stream<A, EL | ER, RL | RR>
} = dual(3, <AL, EL, RL, AR, ER, RR, A>(
  left: Stream<AL, EL, RL>,
  right: Stream<AR, ER, RR>,
  f: (
    left: Arr.NonEmptyReadonlyArray<AL>,
    right: Arr.NonEmptyReadonlyArray<AR>
  ) => readonly [
    output: Arr.NonEmptyReadonlyArray<A>,
    leftoverLeft: ReadonlyArray<AL>,
    leftoverRight: ReadonlyArray<AR>
  ]
): Stream<A, EL | ER, RL | RR> =>
  fromChannel(Channel.fromTransformBracket(Effect.fnUntraced(function*(_, scope) {
    const pullLeft = yield* Channel.toPullScoped(left.channel, scope)
    const pullRight = yield* Channel.toPullScoped(right.channel, scope)
    const pullBoth = Effect.gen(function*() {
      const fiberLeft = yield* Effect.forkIn(pullLeft, scope)
      const fiberRight = yield* Effect.forkIn(pullRight, scope)
      return (yield* Fiber.joinAll([fiberLeft, fiberRight])) as [
        Arr.NonEmptyReadonlyArray<AL>,
        Arr.NonEmptyReadonlyArray<AR>
      ]
    })

    type State =
      | { _tag: "PullBoth" }
      | { _tag: "PullLeft"; rightArray: Arr.NonEmptyReadonlyArray<AR> }
      | { _tag: "PullRight"; leftArray: Arr.NonEmptyReadonlyArray<AL> }
    let state: State = { _tag: "PullBoth" }

    const pull: Effect.Effect<
      Arr.NonEmptyReadonlyArray<A>,
      EL | ER | Cause.Done,
      RL | RR
    > = Effect.gen(function*() {
      const [left, right] = state._tag === "PullBoth"
        ? yield* pullBoth
        : state._tag === "PullLeft"
        ? [yield* pullLeft, state.rightArray]
        : [state.leftArray, yield* pullRight]
      const result = f(left, right)
      if (Arr.isReadonlyArrayNonEmpty(result[1])) {
        state = { _tag: "PullRight", leftArray: result[1] }
      } else if (Arr.isReadonlyArrayNonEmpty(result[2])) {
        state = { _tag: "PullLeft", rightArray: result[2] }
      } else {
        state = { _tag: "PullBoth" }
      }
      return result[0]
    })

    return pull
  }))))

/**
 * Zips this stream with another point-wise and emits tuples of elements from
 * both streams. The new stream ends when either stream ends.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream1 = Stream.make(1, 2, 3)
 * const stream2 = Stream.make("a", "b", "c")
 *
 * const zipped = Stream.zip(stream1, stream2)
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(zipped)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [[1, "a"], [2, "b"], [3, "c"]]
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const zip: {
  <A2, E2, R2>(that: Stream<A2, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<[A, A2], E2 | E, R2 | R>
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<[A, A2], E | E2, R | R2>
} = dual(
  2,
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    that: Stream<A2, E2, R2>
  ): Stream<[A, A2], E | E2, R | R2> => zipWith(self, that, (a, a2) => [a, a2])
)

/**
 * Zips this stream with another point-wise and keeps only the values from
 * the left stream.
 *
 * The resulting stream ends when either side ends.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream1 = Stream.make(1, 2, 3, 4)
 * const stream2 = Stream.make("a", "b")
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.zipLeft(stream1, stream2).pipe(Stream.runCollect)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [1, 2]
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const zipLeft: {
  <AR, ER, RR>(right: Stream<AR, ER, RR>): <AL, EL, RL>(left: Stream<AL, EL, RL>) => Stream<AL, ER | EL, RR | RL>
  <AL, EL, RL, AR, ER, RR>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>): Stream<AL, EL | ER, RL | RR>
} = dual(
  2,
  <AL, EL, RL, AR, ER, RR>(
    left: Stream<AL, EL, RL>,
    right: Stream<AR, ER, RR>
  ): Stream<AL, EL | ER, RL | RR> =>
    zipWithArray(left, right, (leftArr, rightArr) => {
      const minLength = Math.min(leftArr.length, rightArr.length)
      const output = leftArr.slice(0, minLength) as Arr.NonEmptyArray<AL>
      const leftoverLeft = leftArr.slice(minLength)
      const leftoverRight = rightArr.slice(minLength)

      return [output, leftoverLeft, leftoverRight] as const
    })
)

/**
 * Zips this stream with another point-wise, keeping only right values and ending when either stream ends.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream1 = Stream.make(1, 2)
 * const stream2 = Stream.make("a", "b", "c", "d")
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.zipRight(stream1, stream2).pipe(Stream.runCollect)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: ["a", "b"]
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const zipRight: {
  <AR, ER, RR>(right: Stream<AR, ER, RR>): <AL, EL, RL>(left: Stream<AL, EL, RL>) => Stream<AR, ER | EL, RR | RL>
  <AL, EL, RL, AR, ER, RR>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>): Stream<AR, EL | ER, RL | RR>
} = dual(
  2,
  <AL, EL, RL, AR, ER, RR>(
    left: Stream<AL, EL, RL>,
    right: Stream<AR, ER, RR>
  ): Stream<AR, EL | ER, RL | RR> =>
    zipWithArray(left, right, (leftArr, rightArr) => {
      const minLength = Math.min(leftArr.length, rightArr.length)
      const output = rightArr.slice(0, minLength) as Arr.NonEmptyArray<AR>
      const leftoverLeft = leftArr.slice(minLength)
      const leftoverRight = rightArr.slice(minLength)

      return [output, leftoverLeft, leftoverRight] as const
    })
)

/**
 * Zips this stream with another point-wise and emits tuples of elements from
 * both streams, flattening the left tuple.
 *
 * The new stream will end when one of the sides ends.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream1 = Stream.make(
 *     [1, "a"] as const,
 *     [2, "b"] as const,
 *     [3, "c"] as const
 *   )
 *   const stream2 = Stream.make("x", "y", "z")
 *   const result = yield* Stream.zipFlatten(stream1, stream2).pipe(Stream.runCollect)
 *
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [[1, "a", "x"], [2, "b", "y"], [3, "c", "z"]]
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const zipFlatten: {
  <A2, E2, R2>(
    that: Stream<A2, E2, R2>
  ): <A extends ReadonlyArray<any>, E, R>(self: Stream<A, E, R>) => Stream<[...A, A2], E2 | E, R2 | R>
  <A extends ReadonlyArray<any>, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    that: Stream<A2, E2, R2>
  ): Stream<[...A, A2], E | E2, R | R2>
} = dual(
  2,
  <A extends ReadonlyArray<any>, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    that: Stream<A2, E2, R2>
  ): Stream<[...A, A2], E | E2, R | R2> => zipWith(self, that, (a, a2) => [...a, a2])
)

/**
 * Zips this stream together with the index of elements.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const indexed = yield* Stream.make("a", "b", "c", "d").pipe(
 *     Stream.zipWithIndex,
 *     Stream.runCollect
 *   )
 *   yield* Console.log(indexed)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [["a", 0], ["b", 1], ["c", 2], ["d", 3]]
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const zipWithIndex = <A, E, R>(self: Stream<A, E, R>): Stream<[A, number], E, R> => map(self, (a, i) => [a, i])

/**
 * Zips each element with the next element, pairing the final element with
 * `Option.none()`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.zipWithNext(Stream.make(1, 2, 3, 4))
 *
 * Effect.runPromise(Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * }))
 * // Output: [
 * //   [ 1, { _id: 'Option', _tag: 'Some', value: 2 } ],
 * //   [ 2, { _id: 'Option', _tag: 'Some', value: 3 } ],
 * //   [ 3, { _id: 'Option', _tag: 'Some', value: 4 } ],
 * //   [ 4, { _id: 'Option', _tag: 'None' } ]
 * // ]
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const zipWithNext = <A, E, R>(self: Stream<A, E, R>): Stream<[A, Option.Option<A>], E, R> =>
  mapAccumArray(self, Option.none<A>, (acc, arr) => {
    let i = 0
    if (acc._tag === "None") {
      i = 1
      acc = Option.some(arr[0]) as Option.Some<A>
    }
    const pairs = Arr.empty<[A, Option.Option<A>]>()
    for (; i < arr.length; i++) {
      const value = acc.value
      acc = Option.some(arr[i]) as Option.Some<A>
      pairs.push([value, acc])
    }
    return [acc, pairs]
  }, {
    onHalt(state) {
      return state._tag === "Some" ? [[state.value, Option.none<A>()]] : []
    }
  })

/**
 * Zips each element with its previous element, starting with `None`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.zipWithPrevious(Stream.make(1, 2, 3, 4))
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [
 * //   [ { _id: 'Option', _tag: 'None' }, 1 ],
 * //   [ { _id: 'Option', _tag: 'Some', value: 1 }, 2 ],
 * //   [ { _id: 'Option', _tag: 'Some', value: 2 }, 3 ],
 * //   [ { _id: 'Option', _tag: 'Some', value: 3 }, 4 ]
 * // ]
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const zipWithPrevious = <A, E, R>(self: Stream<A, E, R>): Stream<[Option.Option<A>, A], E, R> =>
  mapAccumArray(self, Option.none<A>, (acc, arr) => {
    const pairs = Arr.empty<[Option.Option<A>, A]>()
    for (let i = 0; i < arr.length; i++) {
      const value = arr[i]
      pairs.push([acc, value])
      acc = Option.some(arr[i])
    }
    return [acc, pairs]
  })

/**
 * Zips each element with its previous and next values.
 *
 * @example
 * ```ts
 * import { Console, Effect, Option, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make(1, 2, 3).pipe(
 *     Stream.zipWithPreviousAndNext,
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ [Option.none(), 1, Option.some(2)], [Option.some(1), 2, Option.some(3)], [Option.some(2), 3, Option.none()] ]
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const zipWithPreviousAndNext = <A, E, R>(
  self: Stream<A, E, R>
): Stream<[Option.Option<A>, A, Option.Option<A>], E, R> =>
  mapAccumArray(self, () => ({
    prev: Option.none<A>(),
    current: Option.none<A>()
  }), (acc, arr) => {
    let i = 0
    let current: A
    if (acc.current._tag === "None") {
      i = 1
      current = arr[0]
      acc.current = Option.some(current)
    } else {
      current = acc.current.value
    }
    const pairs = Arr.empty<[Option.Option<A>, A, Option.Option<A>]>()
    for (; i < arr.length; i++) {
      const element = arr[i]
      acc.current = Option.some(element) as Option.Some<A>
      pairs.push([acc.prev, current, acc.current])
      acc.prev = Option.some(current)
      current = element
    }
    return [acc, pairs]
  }, {
    onHalt(acc) {
      return acc.current._tag === "Some" ? [[acc.prev, acc.current.value, Option.none<A>()]] : []
    }
  })

/**
 * Zips multiple streams so that when a value is emitted by any stream, it is
 * combined with the latest values from the other streams to produce a result.
 *
 * Note: tracking the latest value is done on a per-array basis. That means
 * that emitted elements that are not the last value in arrays will never be
 * used for zipping.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.zipLatestAll(
 *   Stream.make(1, 2, 3).pipe(Stream.rechunk(1)),
 *   Stream.make("a", "b", "c").pipe(Stream.rechunk(1)),
 *   Stream.make(true, false, true).pipe(Stream.rechunk(1))
 * )
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ [ 1, "a", true ], [ 2, "a", true ], [ 3, "a", true ], [ 3, "b", true ], [ 3, "c", true ], [ 3, "c", false ], [ 3, "c", true ] ]
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const zipLatestAll = <T extends ReadonlyArray<Stream<any, any, any>>>(
  ...streams: T
): Stream<
  [T[number]] extends [never] ? never
    : { [K in keyof T]: T[K] extends Stream<infer A, infer _E, infer _R> ? A : never },
  [T[number]] extends [never] ? never : T[number] extends Stream<infer _A, infer _E, infer _R> ? _E : never,
  [T[number]] extends [never] ? never : T[number] extends Stream<infer _A, infer _E, infer _R> ? _R : never
> =>
  fromChannel(Channel.suspend(() => {
    const latest: Array<any> = []
    const emitted = new Set<number>()
    const readyLatch = Latch.makeUnsafe()
    return Channel.mergeAll(
      Channel.fromArray(
        streams.map((s, i) =>
          s.channel.pipe(
            Channel.flattenArray,
            Channel.mapEffect((a) => {
              latest[i] = a
              if (!emitted.has(i)) {
                emitted.add(i)
                if (emitted.size < streams.length) {
                  return readyLatch.await as Effect.Effect<undefined>
                }
                return Effect.as(readyLatch.open, Arr.of(latest.slice()))
              }
              return Effect.succeed(Arr.of(latest.slice()))
            }),
            Channel.filter(isNotUndefined)
          )
        )
      ),
      {
        concurrency: "unbounded",
        bufferSize: 0
      }
    )
  })) as any

/**
 * Combines two streams by emitting each new element with the latest value from the other stream.
 *
 * Note: tracking the latest value is done on a per-array basis. That means
 * that emitted elements that are not the last value in arrays will never be
 * used for zipping.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.zipLatest(
 *     Stream.make(1),
 *     Stream.make("a")
 *   ).pipe(Stream.runCollect)
 *
 *   yield* Console.log(result)
 * })
 * // Output: [ [1, "a"] ]
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const zipLatest: {
  <AR, ER, RR>(
    right: Stream<AR, ER, RR>
  ): <AL, EL, RL>(left: Stream<AL, EL, RL>) => Stream<[AL, AR], EL | ER, RL | RR>
  <AL, EL, RL, AR, ER, RR>(
    left: Stream<AL, EL, RL>,
    right: Stream<AR, ER, RR>
  ): Stream<[AL, AR], EL | ER, RL | RR>
} = dual(
  2,
  <AL, EL, RL, AR, ER, RR>(
    left: Stream<AL, EL, RL>,
    right: Stream<AR, ER, RR>
  ): Stream<[AL, AR], EL | ER, RL | RR> => zipLatestAll(left, right)
)

/**
 * Combines the latest values from both streams whenever either emits, using
 * the provided function.
 *
 * Note: tracking the latest value is done on a per-array basis. That means
 * that emitted elements that are not the last value in arrays will never be
 * used for zipping.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * Effect.gen(function*() {
 *   const result = yield* Stream.make(1, 2, 3).pipe(
 *     Stream.rechunk(1),
 *     Stream.zipLatestWith(
 *       Stream.make(10, 20).pipe(Stream.rechunk(1)),
 *       (n, m) => n + m
 *     ),
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(result)
 *   // Output: [ 11, 12, 22, 23 ]
 * })
 * ```
 *
 * @since 2.0.0
 * @category Zipping
 */
export const zipLatestWith: {
  <AR, ER, RR, AL, A>(
    right: Stream<AR, ER, RR>,
    f: (left: AL, right: AR) => A
  ): <EL, RL>(left: Stream<AL, EL, RL>) => Stream<A, EL | ER, RL | RR>
  <AL, EL, RL, AR, ER, RR, A>(
    left: Stream<AL, EL, RL>,
    right: Stream<AR, ER, RR>,
    f: (left: AL, right: AR) => A
  ): Stream<A, EL | ER, RL | RR>
} = dual(
  3,
  <AL, EL, RL, AR, ER, RR, A>(
    left: Stream<AL, EL, RL>,
    right: Stream<AR, ER, RR>,
    f: (left: AL, right: AR) => A
  ): Stream<A, EL | ER, RL | RR> => map(zipLatestAll(left, right), ([a, a2]) => f(a, a2))
)

/**
 * Races multiple streams and emits values from the first stream to produce a value, interrupting the rest.
 *
 * @since 3.7.0
 * @category Racing
 *
 * @example
 * ```ts
 * import { Console, Effect, Schedule, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.raceAll(
 *     Stream.fromSchedule(Schedule.spaced("1 second")),
 *     Stream.make(0, 1, 2)
 *   ).pipe(Stream.runCollect)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 0, 1, 2 ]
 * ```
 */
export const raceAll = <S extends ReadonlyArray<Stream<any, any, any>>>(
  ...streams: S
): Stream<Success<S[number]>, Error<S[number]>, Services<S[number]>> =>
  fromChannel(Channel.fromTransform((_, scope) =>
    Effect.sync(() => {
      let winner:
        | Pull.Pull<Arr.NonEmptyReadonlyArray<Success<S[number]>>, Error<S[number]>, void, Services<S[number]>>
        | undefined
      const race = Effect.raceAll(streams.map((stream) => {
        const childScope = Scope.forkUnsafe(scope)
        return Channel.toPullScoped(stream.channel, childScope).pipe(
          Effect.flatMap((pull) => Effect.zip(Effect.succeed(pull), pull)),
          Effect.onExit((exit) => {
            if (exit._tag === "Success") {
              if (winner) {
                return Scope.close(childScope, exit)
              }
              winner = exit.value[0]
              return Effect.void
            }
            return Scope.close(childScope, exit)
          }),
          Effect.map(([, chunk]) => chunk)
        )
      }))
      return Effect.suspend(() => winner ?? race)
    })
  ))

/**
 * Returns a stream that mirrors the first upstream to emit an item.
 * As soon as one stream emits, the other is interrupted and failures propagate.
 *
 * @example
 * ```ts
 * import { Console, Effect, Schedule, Stream } from "effect"
 *
 * const stream = Stream.race(
 *   Stream.make(0, 1, 2),
 *   Stream.fromSchedule(Schedule.spaced("1 second"))
 * )
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 0, 1, 2 ]
 * ```
 *
 * @since 3.7.0
 * @category Racing
 */
export const race: {
  <AR, ER, RR>(
    right: Stream<AR, ER, RR>
  ): <AL, EL, RL>(left: Stream<AL, EL, RL>) => Stream<AL | AR, EL | ER, RL | RR>
  <AL, EL, RL, AR, ER, RR>(
    left: Stream<AL, EL, RL>,
    right: Stream<AR, ER, RR>
  ): Stream<AL | AR, EL | ER, RL | RR>
} = dual(2, <AL, EL, RL, AR, ER, RR>(
  left: Stream<AL, EL, RL>,
  right: Stream<AR, ER, RR>
): Stream<AL | AR, EL | ER, RL | RR> => raceAll(left, right))

/**
 * Filters a stream to the elements that satisfy a predicate.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.make(1, 2, 3, 4).pipe(
 *     Stream.filter((n) => n % 2 === 0)
 *   )
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 2, 4 ]
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const filter: {
  <A, B extends A>(refinement: Refinement<NoInfer<A>, B>): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>
  <A>(predicate: Predicate<NoInfer<A>>): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R, B extends A>(self: Stream<A, E, R>, refinement: Refinement<A, B>): Stream<B, E, R>
  <A, E, R>(
    self: Stream<A, E, R>,
    predicate: Predicate<A>
  ): Stream<A, E, R>
} = dual(
  2,
  <A, E, R>(
    self: Stream<A, E, R>,
    predicate: Predicate<A>
  ): Stream<A, E, R> => fromChannel(Channel.filterArray(toChannel(self), predicate))
)

/**
 * Filters and maps stream elements in one pass using a `Filter`.
 *
 * @since 4.0.0
 * @category Filtering
 */
export const filterMap: {
  <A, B, X>(
    filter: Filter.Filter<NoInfer<A>, B, X>
  ): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>
  <A, E, R, B, X>(
    self: Stream<A, E, R>,
    filter: Filter.Filter<A, B, X>
  ): Stream<B, E, R>
} = dual(
  2,
  <A, E, R, B, X>(
    self: Stream<A, E, R>,
    filter: Filter.Filter<A, B, X>
  ): Stream<B, E, R> => fromChannel(Channel.filterMapArray(toChannel(self), filter))
)

/**
 * Effectfully filters elements in a single pass.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3, 4).pipe(Stream.filterEffect((n) => Effect.succeed(n > 2)))
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 3, 4 ]
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const filterEffect: {
  <A, EX, RX>(
    predicate: (a: NoInfer<A>, i: number) => Effect.Effect<boolean, EX, RX>
  ): <E, R>(self: Stream<A, E, R>) => Stream<A, E | EX, R | RX>
  <A, E, R, EX, RX>(
    self: Stream<A, E, R>,
    predicate: (a: NoInfer<A>, i: number) => Effect.Effect<boolean, EX, RX>
  ): Stream<A, E | EX, R | RX>
} = dual(
  2,
  <A, E, R, EX, RX>(
    self: Stream<A, E, R>,
    predicate: (a: NoInfer<A>, i: number) => Effect.Effect<boolean, EX, RX>
  ): Stream<A, E | EX, R | RX> => fromChannel(Channel.filterArrayEffect(toChannel(self), predicate))
)

/**
 * Effectfully filters and maps elements in a single pass.
 *
 * @since 4.0.0
 * @category Filtering
 */
export const filterMapEffect: {
  <A, B, X, EX, RX>(
    filter: Filter.FilterEffect<NoInfer<A>, B, X, EX, RX>
  ): <E, R>(self: Stream<A, E, R>) => Stream<B, E | EX, R | RX>
  <A, E, R, B, X, EX, RX>(
    self: Stream<A, E, R>,
    filter: Filter.FilterEffect<A, B, X, EX, RX>
  ): Stream<B, E | EX, R | RX>
} = dual(
  2,
  <A, E, R, B, X, EX, RX>(
    self: Stream<A, E, R>,
    filter: Filter.FilterEffect<A, B, X, EX, RX>
  ): Stream<B, E | EX, R | RX> => fromChannel(Channel.filterMapArrayEffect(toChannel(self), filter))
)

/**
 * Partitions a stream using a `Filter` and exposes passing and failing values as queues.
 *
 * Each queue fails with the stream error or `Cause.Done` when the source ends.
 *
 * @example
 * ```ts
 * import { Console, Effect, Result, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const [passes, fails] = yield* Stream.make(1, 2, 3, 4).pipe(
 *     Stream.partitionQueue((n) => n % 2 === 0 ? Result.succeed(n) : Result.fail(n))
 *   )
 *
 *   const passValues = yield* Stream.fromQueue(passes).pipe(Stream.runCollect)
 *   const failValues = yield* Stream.fromQueue(fails).pipe(Stream.runCollect)
 *
 *   yield* Console.log(passValues)
 *   // Output: [ 2, 4 ]
 *   yield* Console.log(failValues)
 *   // Output: [ 1, 3 ]
 * })
 *
 * Effect.runPromise(Effect.scoped(program))
 * ```
 *
 * @since 4.0.0
 * @category Filtering
 */
export const partitionQueue: {
  <A, Pass, Fail>(filter: Filter.Filter<NoInfer<A>, Pass, Fail>, options?: {
    readonly capacity?: number | "unbounded" | undefined
  }): <E, R>(self: Stream<A, E, R>) => Effect.Effect<
    [
      passes: Queue.Dequeue<Pass, E | Cause.Done>,
      fails: Queue.Dequeue<Fail, E | Cause.Done>
    ],
    never,
    R | Scope.Scope
  >
  <A, E, R, Pass, Fail>(
    self: Stream<A, E, R>,
    filter: Filter.Filter<NoInfer<A>, Pass, Fail>,
    options?: {
      readonly capacity?: number | "unbounded" | undefined
    }
  ): Effect.Effect<
    [
      passes: Queue.Dequeue<Pass, E | Cause.Done>,
      fails: Queue.Dequeue<Fail, E | Cause.Done>
    ],
    never,
    R | Scope.Scope
  >
} = dual(
  (args) => isStream(args[0]),
  Effect.fnUntraced(
    function*<A, E, R, Pass, Fail>(
      self: Stream<A, E, R>,
      filter: Filter.Filter<NoInfer<A>, Pass, Fail>,
      options?: {
        readonly capacity?: number | "unbounded" | undefined
      }
    ): Effect.fn.Return<
      [
        passes: Queue.Dequeue<Pass, E | Cause.Done>,
        fails: Queue.Dequeue<Fail, E | Cause.Done>
      ],
      never,
      R | Scope.Scope
    > {
      const scope = yield* Effect.scope
      const pull = yield* Channel.toPullScoped(self.channel, scope)
      const capacity = options?.capacity === "unbounded" ? undefined : options?.capacity ?? DefaultChunkSize
      const passes = yield* Queue.make<Pass, E | Cause.Done>({ capacity })
      const fails = yield* Queue.make<Fail, E | Cause.Done>({ capacity })

      yield* Effect.gen(function*() {
        while (true) {
          const chunk = yield* pull
          const excluded: Array<Fail> = []
          const satisfying: Array<Pass> = []
          for (let i = 0; i < chunk.length; i++) {
            const result = filter(chunk[i] as NoInfer<A>)
            if (Result.isFailure(result)) {
              excluded.push(result.failure)
            } else {
              satisfying.push(result.success)
            }
          }
          let passFiber: Fiber.Fiber<any> | undefined = undefined
          if (satisfying.length > 0) {
            const leftover = Queue.offerAllUnsafe(passes, satisfying)
            if (leftover.length > 0) {
              passFiber = yield* Effect.forkChild(Queue.offerAll(passes, leftover))
            }
          }
          if (excluded.length > 0) {
            const leftover = Queue.offerAllUnsafe(fails, excluded)
            if (leftover.length > 0) {
              yield* Queue.offerAll(fails, leftover)
            }
          }
          if (passFiber) yield* Fiber.join(passFiber)
        }
      }).pipe(
        Effect.onError((cause) => {
          Queue.failCauseUnsafe(passes, cause)
          Queue.failCauseUnsafe(fails, cause)
          return Effect.void
        }),
        Effect.forkIn(scope)
      )

      return [passes, fails]
    }
  )
)

/**
 * Splits a stream using an effectful `Filter`, producing pass and fail streams.
 *
 * @since 4.0.0
 * @category Filtering
 */
export const partitionEffect: {
  <A, Pass, Fail, EX, RX>(filter: Filter.FilterEffect<NoInfer<A>, Pass, Fail, EX, RX>, options?: {
    readonly capacity?: number | "unbounded" | undefined
    readonly concurrency?: number | "unbounded" | undefined
  }): <E, R>(self: Stream<A, E, R>) => Effect.Effect<
    [
      passes: Stream<Pass, E | EX>,
      fails: Stream<Fail, E | EX>
    ],
    never,
    R | RX | Scope.Scope
  >
  <A, E, R, Pass, Fail, EX, RX>(
    self: Stream<A, E, R>,
    filter: Filter.FilterEffect<NoInfer<A>, Pass, Fail, EX, RX>,
    options?: {
      readonly capacity?: number | "unbounded" | undefined
      readonly concurrency?: number | "unbounded" | undefined
    }
  ): Effect.Effect<
    [
      passes: Stream<Pass, E | EX>,
      fails: Stream<Fail, E | EX>
    ],
    never,
    R | RX | Scope.Scope
  >
} = dual(
  (args) => isStream(args[0]),
  <A, E, R, Pass, Fail, EX, RX>(
    self: Stream<A, E, R>,
    filter: Filter.FilterEffect<NoInfer<A>, Pass, Fail, EX, RX>,
    options?: {
      readonly capacity?: number | "unbounded" | undefined
      readonly concurrency?: number | "unbounded" | undefined
    }
  ): Effect.Effect<
    [
      passes: Stream<Pass, E | EX>,
      fails: Stream<Fail, E | EX>
    ],
    never,
    R | RX | Scope.Scope
  > =>
    Effect.map(
      partitionQueue<Result.Result<Pass, Fail>, E | EX, R | RX, Pass, Fail>(
        mapEffect(self, (a) => filter(a as NoInfer<A>), options),
        (result) => result,
        options
      ),
      ([passes, fails]) => [fromQueue(passes), fromQueue(fails)] as const
    )
)

/**
 * Splits a stream into excluded and satisfying substreams using a `Filter`.
 *
 * The faster stream may advance up to `bufferSize` elements ahead of the slower
 * one.
 *
 * @since 4.0.0
 * @category Filtering
 *
 * @example
 * ```ts
 * import { Console, Effect, Result, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const [excluded, satisfying] = yield* Stream.partition(
 *     Stream.make(1, 2, 3, 4),
 *     (n) => n % 2 === 0 ? Result.succeed(n) : Result.fail(n)
 *   )
 *   const left = yield* Stream.runCollect(excluded)
 *   const right = yield* Stream.runCollect(satisfying)
 *   yield* Console.log(left)
 *   // Output: [ 1, 3 ]
 *   yield* Console.log(right)
 *   // Output: [ 2, 4 ]
 * })
 * ```
 */
export const partition: {
  <A, Pass, Fail>(
    filter: Filter.Filter<NoInfer<A>, Pass, Fail>,
    options?: { readonly bufferSize?: number | undefined }
  ): <E, R>(
    self: Stream<A, E, R>
  ) => Effect.Effect<
    [excluded: Stream<Fail, E>, satisfying: Stream<Pass, E>],
    never,
    R | Scope.Scope
  >
  <A, E, R, Pass, Fail>(
    self: Stream<A, E, R>,
    filter: Filter.Filter<NoInfer<A>, Pass, Fail>,
    options?: { readonly bufferSize?: number | undefined }
  ): Effect.Effect<
    [excluded: Stream<Fail, E>, satisfying: Stream<Pass, E>],
    never,
    R | Scope.Scope
  >
} = dual(
  (args) => isStream(args[0]),
  <A, E, R, Pass, Fail>(
    self: Stream<A, E, R>,
    filter: Filter.Filter<NoInfer<A>, Pass, Fail>,
    options?: { readonly bufferSize?: number | undefined }
  ): Effect.Effect<
    [excluded: Stream<Fail, E>, satisfying: Stream<Pass, E>],
    never,
    R | Scope.Scope
  > =>
    Effect.map(
      partitionQueue(self, filter, { capacity: options?.bufferSize ?? 16 }),
      ([passes, fails]) => [fromQueue(fails), fromQueue(passes)] as const
    )
)

/**
 * Returns the specified stream if the given condition is satisfied, otherwise
 * returns an empty stream.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(
 *     Stream.when(Stream.make(1, 2, 3), Effect.succeed(false))
 *   )
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: []
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const when: {
  <EX = never, RX = never>(
    test: Effect.Effect<boolean, EX, RX>
  ): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | EX, R | RX>
  <A, E, R, EX = never, RX = never>(
    self: Stream<A, E, R>,
    test: Effect.Effect<boolean, EX, RX>
  ): Stream<A, E | EX, R | RX>
} = dual(2, <A, E, R, EX = never, RX = never>(
  self: Stream<A, E, R>,
  test: Effect.Effect<boolean, EX, RX>
): Stream<A, E | EX, R | RX> =>
  test.pipe(
    Effect.map((pass) => pass ? self : empty),
    unwrap
  ))

/**
 * Runs a sink to peel off enough elements to produce a value and returns that
 * value with the remaining stream in a scope.
 *
 * The returned stream is only valid within the scope.
 *
 * @example
 * ```ts
 * import { Console, Effect, Sink, Stream } from "effect"
 *
 * const stream = Stream.fromArrays([1, 2, 3], [4, 5, 6])
 * const sink = Sink.take<number>(3)
 *
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const [peeled, rest] = yield* Stream.peel(stream, sink)
 *     const remaining = yield* Stream.runCollect(rest)
 *     yield* Console.log([peeled, remaining])
 *   })
 * )
 *
 * Effect.runPromise(program)
 * // Output: [ [1, 2, 3], [4, 5, 6] ]
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const peel: {
  <A2, A, E2, R2>(
    sink: Sink.Sink<A2, A, A, E2, R2>
  ): <E, R>(self: Stream<A, E, R>) => Effect.Effect<[A2, Stream<A, E, never>], E2 | E, Scope.Scope | R2 | R>
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    sink: Sink.Sink<A2, A, A, E2, R2>
  ): Effect.Effect<[A2, Stream<A, E, never>], E | E2, Scope.Scope | R | R2>
} = dual(
  2,
  Effect.fnUntraced(function*<A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    sink: Sink.Sink<A2, A, A, E2, R2>
  ): Effect.fn.Return<[A2, Stream<A, E, never>], E | E2, Scope.Scope | R | R2> {
    let cause: Cause.Cause<E | Cause.Done<void>> | undefined = undefined
    const originalPull = yield* Channel.toPull(self.channel)
    const pull: Pull.Pull<
      Arr.NonEmptyReadonlyArray<A>,
      E
    > = Effect.catchCause(originalPull, (cause_) => {
      cause = cause_
      return Effect.failCause(cause_)
    })

    let stream = fromPull(Effect.succeed(pull)) as Stream<A, E>
    const leftover = yield* run(stream, sink)
    if (cause) return [leftover, empty]

    stream = fromPull(Effect.succeed(originalPull))
    return [leftover, stream]
  })
)

/**
 * Buffers up to `capacity` elements so a faster producer can progress
 * independently of a slower consumer.
 *
 * Note: This combinator destroys chunking. Use `Stream.rechunk` afterwards if
 * you need fixed chunk sizes.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make(1, 2, 3).pipe(
 *     Stream.buffer({ capacity: 1 }),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Rate Limiting
 */
export const buffer: {
  (
    options: { readonly capacity: "unbounded" } | {
      readonly capacity: number
      readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
    }
  ): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R>(
    self: Stream<A, E, R>,
    options: { readonly capacity: "unbounded" } | {
      readonly capacity: number
      readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
    }
  ): Stream<A, E, R>
} = dual(2, <A, E, R>(
  self: Stream<A, E, R>,
  options: { readonly capacity: "unbounded" } | {
    readonly capacity: number
    readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
  }
): Stream<A, E, R> => fromChannel(Channel.bufferArray(self.channel, options)))

/**
 * Allows a faster producer to progress independently of a slower consumer by
 * buffering up to `capacity` chunks in a queue.
 *
 * This combinator preserves chunking and is best with power-of-2 capacities.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.bufferChunks`
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.fromArrays([1, 2], [3, 4]).pipe(
 *     Stream.bufferArray({ capacity: 2 }),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(result)
 * })
 *
 * // Output: [ 1, 2, 3, 4 ]
 * ```
 *
 * @since 2.0.0
 * @category Rate Limiting
 */
export const bufferArray: {
  (
    options: { readonly capacity: "unbounded" } | {
      readonly capacity: number
      readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
    }
  ): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R>(
    self: Stream<A, E, R>,
    options: { readonly capacity: "unbounded" } | {
      readonly capacity: number
      readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
    }
  ): Stream<A, E, R>
} = dual(2, <A, E, R>(
  self: Stream<A, E, R>,
  options: { readonly capacity: "unbounded" } | {
    readonly capacity: number
    readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
  }
): Stream<A, E, R> => fromChannel(Channel.buffer(self.channel, options)))

/**
 * Switches over to the stream produced by the provided function in case this
 * one fails. Allows recovery from all causes of failure, including
 * interruption if the stream is uninterruptible.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.catchAllCause`
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2).pipe(
 *   Stream.concat(Stream.fail("Oops!")),
 *   Stream.concat(Stream.make(3, 4))
 * )
 *
 * const recovered = stream.pipe(
 *   Stream.catchCause(() => Stream.make(999))
 * )
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(recovered)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 999 ]
 * ```
 *
 * @since 4.0.0
 * @category Error Handling
 */
export const catchCause: {
  <E, A2, E2, R2>(
    f: (cause: Cause.Cause<E>) => Stream<A2, E2, R2>
  ): <A, R>(self: Stream<A, E, R>) => Stream<A | A2, E2, R2 | R>
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    f: (cause: Cause.Cause<E>) => Stream<A2, E2, R2>
  ): Stream<A | A2, E2, R | R2>
} = dual(2, <A, E, R, A2, E2, R2>(
  self: Stream<A, E, R>,
  f: (cause: Cause.Cause<E>) => Stream<A2, E2, R2>
): Stream<A | A2, E2, R | R2> =>
  self.channel.pipe(
    Channel.catchCause((cause) => f(cause).channel),
    fromChannel
  ))

/**
 * Runs an effect when the stream fails without changing its values or error,
 * unless the tap effect itself fails.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.tapErrorCause`
 *
 * @example
 * ```ts
 * import { Cause, Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2).pipe(
 *   Stream.concat(Stream.fail("boom")),
 *   Stream.tapCause((cause) => Console.log(Cause.isReason(cause))),
 *   Stream.catch(() => Stream.succeed(0))
 * )
 *
 * const program = Effect.gen(function* () {
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: true
 * // Output: [ 1, 2, 0 ]
 * ```
 *
 * @since 4.0.0
 * @category Error Handling
 */
export const tapCause: {
  <E, A2, E2, R2>(
    f: (cause: Cause.Cause<E>) => Effect.Effect<A2, E2, R2>
  ): <A, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R2 | R>
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    f: (cause: Cause.Cause<E>) => Effect.Effect<A2, E2, R2>
  ): Stream<A, E | E2, R | R2>
} = dual(2, <A, E, R, A2, E2, R2>(
  self: Stream<A, E, R>,
  f: (cause: Cause.Cause<E>) => Effect.Effect<A2, E2, R2>
): Stream<A, E | E2, R | R2> =>
  self.channel.pipe(
    Channel.tapCause(f),
    fromChannel
  ))

const catch_: {
  <E, A2, E2, R2>(
    f: (error: E) => Stream<A2, E2, R2>
  ): <A, R>(self: Stream<A, E, R>) => Stream<A | A2, E2, R2 | R>
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    f: (error: E) => Stream<A2, E2, R2>
  ): Stream<A | A2, E2, R | R2>
} = dual(2, <A, E, R, A2, E2, R2>(
  self: Stream<A, E, R>,
  f: (error: E) => Stream<A2, E2, R2>
): Stream<A | A2, E2, R | R2> => fromChannel(Channel.catch(self.channel, (error) => f(error).channel)))

export {
  /**
   * Switches over to the stream produced by the provided function if this one fails.
   *
   * **Previously Known As**
   *
   * This API replaces the following from Effect 3.x:
   *
   * - `Stream.catchAll`
   *
   * @example
   * ```ts
   * import { Console, Effect, Stream } from "effect"
   *
   * const stream = Stream.make(1, 2).pipe(
   *   Stream.concat(Stream.fail("Oops!")),
   *   Stream.catch(() => Stream.make(999))
   * )
   *
   * const program = Effect.gen(function*() {
   *   const values = yield* Stream.runCollect(stream)
   *   yield* Console.log(values)
   * })
   *
   * Effect.runPromise(program)
   * // Output: [ 1, 2, 999 ]
   * ```
   *
   * @since 4.0.0
   * @category Error Handling
   */
  catch_ as catch
}

/**
 * Effectfully peeks at errors without changing the stream unless the tap fails.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2).pipe(
 *   Stream.concat(Stream.fail("boom")),
 *   Stream.tapError((error) => Console.log(`tapError: ${error}`)),
 *   Stream.catch(() => Stream.make(999))
 * )
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // tapError: boom
 * // [ 1, 2, 999 ]
 * ```
 *
 * @since 4.0.0
 * @category Error Handling
 */
export const tapError: {
  <E, A2, E2, R2>(
    f: (error: E) => Effect.Effect<A2, E2, R2>
  ): <A, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R2 | R>
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    f: (error: E) => Effect.Effect<A2, E2, R2>
  ): Stream<A, E | E2, R | R2>
} = dual(2, <A, E, R, A2, E2, R2>(
  self: Stream<A, E, R>,
  f: (error: E) => Effect.Effect<A2, E2, R2>
): Stream<A, E | E2, R | R2> =>
  self.channel.pipe(
    Channel.tapError(f),
    fromChannel
  ))

/**
 * Recovers from errors that match a predicate by switching to a recovery stream.
 *
 * When a failure matches the filter, the stream switches to the recovery
 * stream. Non-matching failures propagate downstream, so the error type is
 * preserved unless the filter narrows it.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.catchSome`
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2).pipe(
 *   Stream.concat(Stream.fail(42)),
 *   Stream.catchIf(
 *     (error): error is 42 => error === 42,
 *     () => Stream.make(999)
 *   )
 * )
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 *   // Output: [ 1, 2, 999 ]
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @since 4.0.0
 * @category Error Handling
 */
export const catchIf: {
  <E, EB extends E, A2, E2, R2, A3 = never, E3 = Exclude<E, EB>, R3 = never>(
    refinement: Refinement<NoInfer<E>, EB>,
    f: (e: EB) => Stream<A2, E2, R2>,
    orElse?: ((e: Exclude<E, EB>) => Stream<A3, E3, R3>) | undefined
  ): <A, R>(self: Stream<A, E, R>) => Stream<A2 | A | A3, E2 | E3, R2 | R | R3>
  <E, A2, E2, R2, A3 = never, E3 = E, R3 = never>(
    predicate: Predicate<NoInfer<E>>,
    f: (e: NoInfer<E>) => Stream<A2, E2, R2>,
    orElse?: ((e: NoInfer<E>) => Stream<A3, E3, R3>) | undefined
  ): <A, R>(self: Stream<A, E, R>) => Stream<A2 | A | A3, E2 | E3, R2 | R | R3>
  <A, E, R, EB extends E, A2, E2, R2, A3 = never, E3 = Exclude<E, EB>, R3 = never>(
    self: Stream<A, E, R>,
    refinement: Refinement<E, EB>,
    f: (e: EB) => Stream<A2, E2, R2>,
    orElse?: ((e: Exclude<E, EB>) => Stream<A3, E3, R3>) | undefined
  ): Stream<A | A2 | A3, E2 | E3, R | R2 | R3>
  <A, E, R, A2, E2, R2, A3 = never, E3 = E, R3 = never>(
    self: Stream<A, E, R>,
    predicate: Predicate<E>,
    f: (e: E) => Stream<A2, E2, R2>,
    orElse?: ((e: E) => Stream<A3, E3, R3>) | undefined
  ): Stream<A | A2 | A3, E2 | E3, R | R2 | R3>
} = dual((args) => isStream(args[0]), <
  A,
  E,
  R,
  A2,
  E2,
  R2,
  A3 = never,
  E3 = E,
  R3 = never
>(
  self: Stream<A, E, R>,
  predicate: Predicate<E>,
  f: (failure: E) => Stream<A2, E2, R2>,
  orElse?: ((failure: E) => Stream<A3, E3, R3>) | undefined
): Stream<A | A2 | A3, E2 | E3, R | R2 | R3> =>
  fromChannel(
    Channel.catchIf(
      toChannel(self),
      predicate,
      (e) => f(e).channel,
      orElse && ((e) => orElse(e).channel)
    )
  ))

/**
 * Recovers from errors that match a `Filter` by switching to a recovery
 * stream.
 *
 * @since 4.0.0
 * @category Error Handling
 */
export const catchFilter: {
  <E, EB, A2, E2, R2, X, A3 = never, E3 = X, R3 = never>(
    filter: Filter.Filter<NoInfer<E>, EB, X>,
    f: (failure: EB) => Stream<A2, E2, R2>,
    orElse?: ((failure: X) => Stream<A3, E3, R3>) | undefined
  ): <A, R>(self: Stream<A, E, R>) => Stream<A | A2 | A3, E2 | E3, R | R2 | R3>
  <A, E, R, EB, A2, E2, R2, X, A3 = never, E3 = X, R3 = never>(
    self: Stream<A, E, R>,
    filter: Filter.Filter<NoInfer<E>, EB, X>,
    f: (failure: EB) => Stream<A2, E2, R2>,
    orElse?: ((failure: X) => Stream<A3, E3, R3>) | undefined
  ): Stream<A | A2 | A3, E2 | E3, R | R2 | R3>
} = dual((args) => isStream(args[0]), <
  A,
  E,
  R,
  EB,
  A2,
  E2,
  R2,
  X,
  A3 = never,
  E3 = X,
  R3 = never
>(
  self: Stream<A, E, R>,
  filter: Filter.Filter<NoInfer<E>, EB, X>,
  f: (failure: EB) => Stream<A2, E2, R2>,
  orElse?: ((failure: X) => Stream<A3, E3, R3>) | undefined
): Stream<A | A2 | A3, E2 | E3, R | R2 | R3> =>
  fromChannel(
    Channel.catchFilter(
      toChannel(self),
      filter,
      (e) => f(e).channel,
      orElse && ((e) => orElse(e).channel)
    )
  ))

/**
 * Recovers from failures whose `_tag` matches the provided value by switching to
 * the stream returned by `f`.
 *
 * **When to Use**
 *
 * Use `catchTag` when your error type is a tagged union with a readonly `_tag`
 * field and you want to handle a specific error case.
 *
 * @example
 * ```ts
 * import { Console, Data, Effect, Stream } from "effect"
 *
 * class HttpError extends Data.TaggedError("HttpError")<{ message: string }> {}
 *
 * const stream = Stream.fail(new HttpError({ message: "timeout" }))
 *
 * const recovered = Stream.catchTag(stream, "HttpError", (error) =>
 *   Stream.make(`Recovered: ${error.message}`)
 * )
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(recovered)
 *   yield* Console.log(values)
 *   // Output: [ "Recovered: timeout" ]
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @since 4.0.0
 * @category Error Handling
 */
export const catchTag: {
  <
    const K extends Tags<E> | Arr.NonEmptyReadonlyArray<Tags<E>>,
    E,
    A1,
    E1,
    R1,
    A2 = never,
    E2 = ExcludeTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>,
    R2 = never
  >(
    k: K,
    f: (
      e: ExtractTag<NoInfer<E>, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>
    ) => Stream<A1, E1, R1>,
    orElse?:
      | ((e: ExcludeTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Stream<A2, E2, R2>)
      | undefined
  ): <A, R>(
    self: Stream<A, E, R>
  ) => Stream<A1 | A | A2, E1 | E2, R1 | R | R2>
  <
    A,
    E,
    R,
    const K extends Tags<E> | Arr.NonEmptyReadonlyArray<Tags<E>>,
    R1,
    E1,
    A1,
    A2 = never,
    E2 = ExcludeTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>,
    R2 = never
  >(
    self: Stream<A, E, R>,
    k: K,
    f: (e: ExtractTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Stream<A1, E1, R1>,
    orElse?:
      | ((e: ExcludeTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Stream<A2, E2, R2>)
      | undefined
  ): Stream<A1 | A | A2, E1 | E2, R1 | R | R2>
} = dual(
  (args) => isStream(args[0]),
  <
    A,
    E,
    R,
    const K extends Tags<E> | Arr.NonEmptyReadonlyArray<Tags<E>>,
    R1,
    E1,
    A1,
    A2 = never,
    E2 = ExcludeTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>,
    R2 = never
  >(
    self: Stream<A, E, R>,
    k: K,
    f: (e: ExtractTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Stream<A1, E1, R1>,
    orElse?:
      | ((e: ExcludeTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Stream<A2, E2, R2>)
      | undefined
  ): Stream<A1 | A | A2, E1 | E2, R1 | R | R2> => {
    const pred = Array.isArray(k)
      ? ((e: E): e is any => hasProperty(e, "_tag") && k.includes(e._tag))
      : isTagged(k as string)
    return catchIf(self, pred, f, orElse as any) as any
  }
)

/**
 * Switches to a recovery stream based on matching `_tag` handlers.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * class NotFound {
 *   readonly _tag = "NotFound"
 *   constructor(readonly resource: string) {}
 * }
 *
 * class Unauthorized {
 *   readonly _tag = "Unauthorized"
 *   constructor(readonly user: string) {}
 * }
 *
 * const stream = Stream.fail(new NotFound("profile"))
 *
 * const program = Effect.gen(function* () {
 *   const result = yield* stream.pipe(
 *     Stream.catchTags({
 *       NotFound: () => Stream.succeed("fallback"),
 *       Unauthorized: () => Stream.succeed("login")
 *     }),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(result)
 * })
 *
 * // Output: [ "fallback" ]
 * ```
 *
 * @since 4.0.0
 * @category Error Handling
 */
export const catchTags: {
  <
    E,
    Cases extends (E extends { _tag: string } ? {
        [K in E["_tag"]]+?: (error: Extract<E, { _tag: K }>) => Stream<any, any, any>
      } :
      {}),
    A2 = never,
    E2 = Exclude<E, { _tag: keyof Cases }>,
    R2 = never
  >(
    cases: Cases,
    orElse?: ((e: Exclude<E, { _tag: keyof Cases }>) => Stream<A2, E2, R2>) | undefined
  ): <A, R>(self: Stream<A, E, R>) => Stream<
    | A
    | A2
    | {
      [K in keyof Cases]: Cases[K] extends ((...args: Array<any>) => Stream<infer A, any, any>) ? A : never
    }[keyof Cases],
    | E2
    | {
      [K in keyof Cases]: Cases[K] extends ((...args: Array<any>) => Stream<any, infer E, any>) ? E : never
    }[keyof Cases],
    | R
    | R2
    | {
      [K in keyof Cases]: Cases[K] extends ((...args: Array<any>) => Stream<any, any, infer R>) ? R : never
    }[keyof Cases]
  >
  <
    R,
    E,
    A,
    Cases extends (E extends { _tag: string } ? {
        [K in E["_tag"]]+?: (error: Extract<E, { _tag: K }>) => Stream<any, any, any>
      } :
      {}),
    A2 = never,
    E2 = Exclude<E, { _tag: keyof Cases }>,
    R2 = never
  >(
    self: Stream<A, E, R>,
    cases: Cases,
    orElse?: ((e: Exclude<E, { _tag: keyof Cases }>) => Stream<A2, E2, R2>) | undefined
  ): Stream<
    | A
    | A2
    | {
      [K in keyof Cases]: Cases[K] extends ((...args: Array<any>) => Stream<infer A, any, any>) ? A : never
    }[keyof Cases],
    | E2
    | {
      [K in keyof Cases]: Cases[K] extends ((...args: Array<any>) => Stream<any, infer E, any>) ? E : never
    }[keyof Cases],
    | R
    | R2
    | {
      [K in keyof Cases]: Cases[K] extends ((...args: Array<any>) => Stream<any, any, infer R>) ? R : never
    }[keyof Cases]
  >
} = dual((args) => isStream(args[0]), (self, cases, orElse) => {
  let keys: Array<string>
  return catchFilter(
    self,
    (e: any) => {
      keys ??= Object.keys(cases)
      return hasProperty(e, "_tag") && isString(e["_tag"]) && keys.includes(e["_tag"])
        ? Result.succeed(e)
        : Result.fail(e)
    },
    (e: any) => cases[e["_tag"] as string](e),
    orElse
  )
})

/**
 * Catches a specific reason within a tagged error.
 *
 * Use this to handle nested error causes without removing the parent error
 * from the error channel. The handler receives the unwrapped reason.
 *
 * @example
 * ```ts
 * import { Console, Data, Effect, Stream } from "effect"
 *
 * class RateLimitError extends Data.TaggedError("RateLimitError")<{
 *   retryAfter: number
 * }> {}
 *
 * class QuotaExceededError extends Data.TaggedError("QuotaExceededError")<{
 *   limit: number
 * }> {}
 *
 * class AiError extends Data.TaggedError("AiError")<{
 *   reason: RateLimitError | QuotaExceededError
 * }> {}
 *
 * const stream = Stream.fail(
 *   new AiError({ reason: new RateLimitError({ retryAfter: 60 }) })
 * )
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* stream.pipe(
 *     Stream.catchReason("AiError", "RateLimitError", (reason) =>
 *       Stream.succeed(`retry: ${reason.retryAfter}`)
 *     ),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "retry: 60" ]
 * ```
 *
 * @since 4.0.0
 * @category Error Handling
 */
export const catchReason: {
  <
    K extends Tags<E>,
    E,
    RK extends ReasonTags<ExtractTag<NoInfer<E>, K>>,
    A2,
    E2,
    R2,
    A3 = unassigned,
    E3 = never,
    R3 = never
  >(
    errorTag: K,
    reasonTag: RK,
    f: (
      reason: ExtractReason<ExtractTag<NoInfer<E>, K>, RK>,
      error: NarrowReason<ExtractTag<NoInfer<E>, K>, RK>
    ) => Stream<A2, E2, R2>,
    orElse?:
      | ((
        reason: ExcludeReason<ExtractTag<NoInfer<E>, K>, RK>,
        error: OmitReason<ExtractTag<NoInfer<E>, K>, RK>
      ) => Stream<A3, E3, R3>)
      | undefined
  ): <A, R>(
    self: Stream<A, E, R>
  ) => Stream<A | A2 | Exclude<A3, unassigned>, (A3 extends unassigned ? E : ExcludeTag<E, K>) | E2 | E3, R | R2 | R3>
  <
    A,
    E,
    R,
    K extends Tags<E>,
    RK extends ReasonTags<ExtractTag<E, K>>,
    A2,
    E2,
    R2,
    A3 = unassigned,
    E3 = never,
    R3 = never
  >(
    self: Stream<A, E, R>,
    errorTag: K,
    reasonTag: RK,
    f: (reason: ExtractReason<ExtractTag<E, K>, RK>, error: NarrowReason<ExtractTag<E, K>, RK>) => Stream<A2, E2, R2>,
    orElse?:
      | ((reason: ExcludeReason<ExtractTag<E, K>, RK>, error: OmitReason<ExtractTag<E, K>, RK>) => Stream<A3, E3, R3>)
      | undefined
  ): Stream<A | A2 | Exclude<A3, unassigned>, (A3 extends unassigned ? E : ExcludeTag<E, K>) | E2 | E3, R | R2 | R3>
} = dual(
  (args) => isStream(args[0]),
  <
    A,
    E,
    R,
    K extends Tags<E>,
    RK extends ReasonTags<ExtractTag<E, K>>,
    A2,
    E2,
    R2,
    A3 = unassigned,
    E3 = never,
    R3 = never
  >(
    self: Stream<A, E, R>,
    errorTag: K,
    reasonTag: RK,
    f: (reason: ExtractReason<ExtractTag<E, K>, RK>, error: NarrowReason<ExtractTag<E, K>, RK>) => Stream<A2, E2, R2>,
    orElse?:
      | ((reason: ExcludeReason<ExtractTag<E, K>, RK>, error: OmitReason<ExtractTag<E, K>, RK>) => Stream<A3, E3, R3>)
      | undefined
  ): Stream<A | A2 | Exclude<A3, unassigned>, (A3 extends unassigned ? E : ExcludeTag<E, K>) | E2 | E3, R | R2 | R3> =>
    fromChannel(
      Channel.catchReason(
        toChannel(self),
        errorTag,
        reasonTag,
        (reason, error) => f(reason, error).channel,
        orElse && ((reason, error) => orElse(reason, error).channel)
      )
    ) as any
)

/**
 * Catches multiple reasons within a tagged error using an object of handlers.
 *
 * @example
 * ```ts
 * import { Console, Data, Effect, Stream } from "effect"
 *
 * class RateLimitError extends Data.TaggedError("RateLimitError")<{
 *   retryAfter: number
 * }> {}
 *
 * class QuotaExceededError extends Data.TaggedError("QuotaExceededError")<{
 *   limit: number
 * }> {}
 *
 * class AiError extends Data.TaggedError("AiError")<{
 *   reason: RateLimitError | QuotaExceededError
 * }> {}
 *
 * const stream = Stream.fail(
 *   new AiError({ reason: new RateLimitError({ retryAfter: 60 }) })
 * )
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* stream.pipe(
 *     Stream.catchReasons("AiError", {
 *       RateLimitError: (reason) => Stream.succeed(`retry: ${reason.retryAfter}`),
 *       QuotaExceededError: (reason) => Stream.succeed(`quota: ${reason.limit}`)
 *     }),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "retry: 60" ]
 * ```
 *
 * @since 4.0.0
 * @category Error Handling
 */
export const catchReasons: {
  <
    K extends Tags<E>,
    E,
    Cases extends {
      [RK in ReasonTags<ExtractTag<NoInfer<E>, K>>]+?: (
        reason: ExtractReason<ExtractTag<NoInfer<E>, K>, RK>,
        error: NarrowReason<ExtractTag<NoInfer<E>, K>, RK>
      ) => Stream<any, any, any>
    },
    A2 = unassigned,
    E2 = never,
    R2 = never
  >(
    errorTag: K,
    cases: Cases,
    orElse?:
      | ((
        reason: ExcludeReason<ExtractTag<NoInfer<E>, K>, Extract<keyof Cases, string>>,
        error: OmitReason<ExtractTag<NoInfer<E>, K>, Extract<keyof Cases, string>>
      ) => Stream<A2, E2, R2>)
      | undefined
  ): <A, R>(self: Stream<A, E, R>) => Stream<
    | A
    | Exclude<A2, unassigned>
    | {
      [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Stream<infer A, any, any> ? A : never
    }[keyof Cases],
    | (A2 extends unassigned ? E : ExcludeTag<E, K>)
    | E2
    | {
      [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Stream<any, infer E, any> ? E : never
    }[keyof Cases],
    | R
    | R2
    | {
      [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Stream<any, any, infer R> ? R : never
    }[keyof Cases]
  >
  <
    A,
    E,
    R,
    K extends Tags<E>,
    Cases extends {
      [RK in ReasonTags<ExtractTag<E, K>>]+?: (
        reason: ExtractReason<ExtractTag<E, K>, RK>,
        error: NarrowReason<ExtractTag<E, K>, RK>
      ) => Stream<any, any, any>
    },
    A2 = unassigned,
    E2 = never,
    R2 = never
  >(
    self: Stream<A, E, R>,
    errorTag: K,
    cases: Cases,
    orElse?:
      | ((
        reason: ExcludeReason<ExtractTag<NoInfer<E>, K>, Extract<keyof Cases, string>>,
        error: OmitReason<ExtractTag<NoInfer<E>, K>, Extract<keyof Cases, string>>
      ) => Stream<A2, E2, R2>)
      | undefined
  ): Stream<
    | A
    | Exclude<A2, unassigned>
    | {
      [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Stream<infer A, any, any> ? A : never
    }[keyof Cases],
    | (A2 extends unassigned ? E : ExcludeTag<E, K>)
    | E2
    | {
      [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Stream<any, infer E, any> ? E : never
    }[keyof Cases],
    | R
    | R2
    | {
      [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Stream<any, any, infer R> ? R : never
    }[keyof Cases]
  >
} = dual((args) => isStream(args[0]), (self, errorTag, cases, orElse) => {
  const handlers: Record<string, (reason: any, error: any) => Channel.Channel<any, any, any, any, any, any, any>> = {}
  for (const key of Object.keys(cases)) {
    const handler = (cases as any)[key]
    handlers[key] = (reason, error) => handler(reason, error).channel
  }
  const orElseHandler = orElse && ((reason: any, error: any) => orElse(reason, error).channel)
  return fromChannel(
    Channel.catchReasons(self.channel, errorTag as any, handlers as any, orElseHandler as any) as Channel.Channel<
      Arr.NonEmptyReadonlyArray<any>,
      any,
      void,
      unknown,
      unknown,
      unknown,
      any
    >
  ) as any
})

/**
 * Transforms the errors emitted by this stream using `f`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.fail("bad").pipe(
 *     Stream.mapError((error) => `mapped: ${error}`),
 *     Stream.catch((error) => Stream.make(`recovered from ${error}`)),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "recovered from mapped: bad" ]
 * ```
 *
 * @since 2.0.0
 * @category Error Handling
 */
export const mapError: {
  <E, E2>(f: (error: E) => E2): <A, R>(self: Stream<A, E, R>) => Stream<A, E2, R>
  <A, E, R, E2>(self: Stream<A, E, R>, f: (error: E) => E2): Stream<A, E2, R>
} = dual(2, <A, E, R, E2>(
  self: Stream<A, E, R>,
  f: (error: E) => E2
): Stream<A, E2, R> => fromChannel(Channel.mapError(self.channel, f)))

/**
 * Recovers from stream failures by filtering the `Cause` and switching to a recovery stream.
 * Non-matching causes are re-emitted as failures.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.catchSomeCause`
 *
 * @example
 * ```ts
 * import { Cause, Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const failingStream = Stream.fail("NetworkError")
 *   const recovered = Stream.catchCauseIf(
 *     failingStream,
 *     (cause) => Cause.hasFails(cause),
 *     (cause) => Stream.make(`Recovered: ${Cause.squash(cause)}`)
 *   )
 *
 *   const output = yield* Stream.runCollect(recovered)
 *   yield* Console.log(output)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "Recovered: NetworkError" ]
 * ```
 *
 * @since 4.0.0
 * @category Error Handling
 */
export const catchCauseIf: {
  <E, A2, E2, R2>(
    predicate: Predicate<Cause.Cause<E>>,
    f: (cause: Cause.Cause<E>) => Stream<A2, E2, R2>
  ): <A, R>(
    self: Stream<A, E, R>
  ) => Stream<A | A2, E | E2, R2 | R>
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    predicate: Predicate<Cause.Cause<E>>,
    f: (cause: Cause.Cause<E>) => Stream<A2, E2, R2>
  ): Stream<A | A2, E | E2, R | R2>
} = dual(3, <A, E, R, A2, E2, R2>(
  self: Stream<A, E, R>,
  predicate: Predicate<Cause.Cause<E>>,
  f: (cause: Cause.Cause<E>) => Stream<A2, E2, R2>
): Stream<A | A2, E | E2, R | R2> =>
  fromChannel(
    Channel.catchCauseIf(
      self.channel,
      predicate,
      (cause) => f(cause).channel
    )
  ))

/**
 * Recovers from stream failures by filtering the `Cause` and switching to a
 * recovery stream.
 *
 * @since 4.0.0
 * @category Error Handling
 */
export const catchCauseFilter: {
  <E, EB, A2, E2, R2, X extends Cause.Cause<any>>(
    filter: Filter.Filter<Cause.Cause<E>, EB, X>,
    f: (failure: EB, cause: Cause.Cause<E>) => Stream<A2, E2, R2>
  ): <A, R>(
    self: Stream<A, E, R>
  ) => Stream<A | A2, Cause.Cause.Error<X> | E2, R2 | R>
  <A, E, R, EB, A2, E2, R2, X extends Cause.Cause<any>>(
    self: Stream<A, E, R>,
    filter: Filter.Filter<Cause.Cause<E>, EB, X>,
    f: (failure: EB, cause: Cause.Cause<E>) => Stream<A2, E2, R2>
  ): Stream<A | A2, Cause.Cause.Error<X> | E2, R | R2>
} = dual(3, <A, E, R, EB, A2, E2, R2, X extends Cause.Cause<any>>(
  self: Stream<A, E, R>,
  filter: Filter.Filter<Cause.Cause<E>, EB, X>,
  f: (failure: EB, cause: Cause.Cause<E>) => Stream<A2, E2, R2>
): Stream<A | A2, Cause.Cause.Error<X> | E2, R | R2> =>
  fromChannel(
    Channel.catchCauseFilter(
      self.channel,
      filter,
      (failure, cause) => f(failure, cause).channel
    )
  ))

/**
 * Switches to a fallback stream if this stream is empty.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.empty.pipe(
 *     Stream.orElseIfEmpty(() => Stream.make(1, 2)),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2 ]
 * ```
 *
 * @since 2.0.0
 * @category Error Handling
 */
export const orElseIfEmpty: {
  <E, A2, E2, R2>(
    orElse: LazyArg<Stream<A2, E2, R2>>
  ): <A, R>(self: Stream<A, E, R>) => Stream<A | A2, E | E2, R | R2>
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    orElse: LazyArg<Stream<A2, E2, R2>>
  ): Stream<A | A2, E | E2, R | R2>
} = dual(2, <A, E, R, A2, E2, R2>(
  self: Stream<A, E, R>,
  orElse: LazyArg<Stream<A2, E2, R2>>
): Stream<A | A2, E | E2, R | R2> =>
  fromChannel(Channel.orElseIfEmpty(
    self.channel,
    (_) => toChannel(orElse())
  )))

/**
 * Returns a stream that emits a fallback value when this stream fails.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.fail("NetworkError").pipe(
 *     Stream.orElseSucceed((error) => `Recovered: ${error}`)
 *   )
 *
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "Recovered: NetworkError" ]
 * ```
 *
 * @since 2.0.0
 * @category Error Handling
 */
export const orElseSucceed: {
  <E, A2>(
    f: (error: E) => A2
  ): <A, R>(self: Stream<A, E, R>) => Stream<A | A2, never, R>
  <A, E, R, A2>(
    self: Stream<A, E, R>,
    f: (error: E) => A2
  ): Stream<A | A2, never, R>
} = dual(2, <A, E, R, A2>(
  self: Stream<A, E, R>,
  f: (error: E) => A2
): Stream<A | A2, never, R> => catch_(self, (e) => succeed(f(e))))

/**
 * Turns typed failures into defects, making the stream infallible.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make(1, 2, 3).pipe(
 *     Stream.orDie,
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Error Handling
 */
export const orDie = <A, E, R>(self: Stream<A, E, R>): Stream<A, never, R> => fromChannel(Channel.orDie(self.channel))

/**
 * Ignores failures and ends the stream on error.
 *
 * Use the `log` option to emit the full {@link Cause} when the stream fails.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make(1, 2, 3).pipe(
 *     Stream.concat(Stream.fail("boom")),
 *     Stream.ignore,
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @example
 * ```ts
 * import { Stream } from "effect"
 *
 * const stream = Stream.fail("boom")
 *
 * const program = stream.pipe(Stream.ignore({ log: "Error" }))
 * ```
 *
 * @since 4.0.0
 * @category Error Handling
 */
export const ignore: <
  Arg extends Stream<any, any, any> | {
    readonly log?: boolean | Severity | undefined
  } | undefined
>(
  selfOrOptions: Arg,
  options?: {
    readonly log?: boolean | Severity | undefined
  } | undefined
) => [Arg] extends [Stream<infer A, infer _E, infer R>] ? Stream<A, never, R>
  : <A, E, R>(self: Stream<A, E, R>) => Stream<A, never, R> = dual(
    (args) => isStream(args[0]),
    <A, E, R>(
      self: Stream<A, E, R>,
      options?: {
        readonly log?: boolean | Severity | undefined
      } | undefined
    ): Stream<A, never, R> => fromChannel(Channel.ignore(self.channel, options))
  )

/**
 * Ignores the stream's failure cause, including defects, and ends the stream.
 *
 * Use the `log` option to emit the full {@link Cause} when the stream fails.
 *
 * @example
 * ```ts
 * import { Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2).pipe(
 *   Stream.concat(Stream.fail("boom")),
 *   Stream.ignoreCause({ log: "Error" })
 * )
 *
 * const program = Stream.runCollect(stream)
 * ```
 *
 * @since 4.0.0
 * @category Error Handling
 */
export const ignoreCause: <
  Arg extends Stream<any, any, any> | {
    readonly log?: boolean | Severity | undefined
  } | undefined
>(
  streamOrOptions: Arg,
  options?: {
    readonly log?: boolean | Severity | undefined
  } | undefined
) => [Arg] extends [Stream<infer A, infer _E, infer R>] ? Stream<A, never, R>
  : <A, E, R>(self: Stream<A, E, R>) => Stream<A, never, R> = dual(
    (args) => isStream(args[0]),
    <A, E, R>(
      self: Stream<A, E, R>,
      options?: { readonly log?: boolean | Severity | undefined } | undefined
    ): Stream<A, never, R> => fromChannel(Channel.ignoreCause(self.channel, options))
  )

/**
 * When the stream fails, retry it according to the given schedule.
 *
 * This retries the entire stream, so will re-execute all of the stream's
 * acquire operations.
 *
 * The schedule is reset as soon as the first element passes through the
 * stream again.
 *
 * @example
 * ```ts
 * import { Console, Effect, Schedule, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make(1).pipe(
 *     Stream.concat(Stream.fail("boom")),
 *     Stream.retry(Schedule.recurs(1)),
 *     Stream.take(2),
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 1 ]
 * ```
 *
 * @since 2.0.0
 * @category Error Handling
 */
export const retry: {
  <E, X, E2, R2>(
    policy:
      | Schedule.Schedule<X, NoInfer<E>, E2, R2>
      | ((
        $: <SO, SE, SR>(_: Schedule.Schedule<SO, NoInfer<E>, SE, SR>) => Schedule.Schedule<SO, E, SE, SR>
      ) => Schedule.Schedule<X, NoInfer<E>, E2, R2>)
  ): <A, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R2 | R>
  <A, E, R, X, E2, R2>(
    self: Stream<A, E, R>,
    policy:
      | Schedule.Schedule<X, NoInfer<E>, E2, R2>
      | ((
        $: <SO, SE, SR>(_: Schedule.Schedule<SO, NoInfer<E>, SE, SR>) => Schedule.Schedule<SO, E, SE, SR>
      ) => Schedule.Schedule<X, NoInfer<E>, E2, R2>)
  ): Stream<A, E | E2, R2 | R>
} = dual(
  2,
  <A, E, R, X, E2, R2>(
    self: Stream<A, E, R>,
    policy:
      | Schedule.Schedule<X, NoInfer<E>, E2, R2>
      | ((
        $: <SO, SE, SR>(_: Schedule.Schedule<SO, NoInfer<E>, SE, SR>) => Schedule.Schedule<SO, E, SE, SR>
      ) => Schedule.Schedule<X, NoInfer<E>, E2, R2>)
  ): Stream<A, E | E2, R2 | R> => fromChannel(Channel.retry(self.channel, policy))
)

/**
 * Apply an `ExecutionPlan` to a stream, retrying with step-provided resources
 * until it succeeds or the plan is exhausted.
 *
 * By default, a failing step can fallback even after emitting elements; set
 * `preventFallbackOnPartialStream` to fail instead of mixing partial output with
 * a later fallback.
 *
 * @example
 * ```ts
 * import { Console, Effect, ExecutionPlan, Layer, Context, Stream } from "effect"
 *
 * class Service extends Context.Service<Service>()("Service", {
 *   make: Effect.succeed({
 *     stream: Stream.fail("A") as Stream.Stream<number, string>
 *   })
 * }) {
 *   static Bad = Layer.succeed(Service, Service.of({ stream: Stream.fail("A") }))
 *   static Good = Layer.succeed(Service, Service.of({ stream: Stream.make(1, 2, 3) }))
 * }
 *
 * const plan = ExecutionPlan.make(
 *   { provide: Service.Bad },
 *   { provide: Service.Good }
 * )
 *
 * const stream = Stream.unwrap(Effect.map(Service.asEffect(), (_) => _.stream))
 *
 * const program = Effect.gen(function*() {
 *   const items = yield* stream.pipe(Stream.withExecutionPlan(plan), Stream.runCollect)
 *   yield* Console.log(items)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 3.16.0
 * @category Error Handling
 * @experimental
 */
export const withExecutionPlan: {
  <Input, R2, Provides, PolicyE>(
    policy: ExecutionPlan.ExecutionPlan<{ provides: Provides; input: Input; error: PolicyE; requirements: R2 }>,
    options?: { readonly preventFallbackOnPartialStream?: boolean | undefined }
  ): <A, E extends Input, R>(self: Stream<A, E, R>) => Stream<A, E | PolicyE, R2 | Exclude<R, Provides>>
  <A, E extends Input, R, R2, Input, Provides, PolicyE>(
    self: Stream<A, E, R>,
    policy: ExecutionPlan.ExecutionPlan<{ provides: Provides; input: Input; error: PolicyE; requirements: R2 }>,
    options?: { readonly preventFallbackOnPartialStream?: boolean | undefined }
  ): Stream<A, E | PolicyE, R2 | Exclude<R, Provides>>
} = dual((args) => isStream(args[0]), <A, E extends Input, R, R2, Input, Provides, PolicyE>(
  self: Stream<A, E, R>,
  policy: ExecutionPlan.ExecutionPlan<{
    provides: Provides
    input: Input
    error: PolicyE
    requirements: R2
  }>,
  options?: {
    readonly preventFallbackOnPartialStream?: boolean | undefined
  }
): Stream<A, E | PolicyE, R2 | Exclude<R, Provides>> =>
  suspend(() => {
    const preventFallbackOnPartialStream = options?.preventFallbackOnPartialStream ?? false
    let i = 0
    let meta: ExecutionPlan.Metadata = {
      attempt: 0,
      stepIndex: 0
    }
    const provideMeta = provideServiceEffect(
      ExecutionPlan.CurrentMetadata,
      Effect.sync(() => {
        meta = {
          attempt: meta.attempt + 1,
          stepIndex: i
        }
        return meta
      })
    )
    let lastError = Option.none<E | PolicyE>()
    const loop: Stream<
      A,
      E | PolicyE,
      R2 | Exclude<R, Provides>
    > = suspend(() => {
      const step = policy.steps[i]
      if (!step) {
        return fail(Option.getOrThrow(lastError))
      }

      let nextStream: Stream<A, E | PolicyE, R2 | Exclude<R, Provides>> = provideMeta(provide(self, step.provide))
      let receivedElements = false

      if (Option.isSome(lastError)) {
        const error = lastError.value
        let attempted = false
        const wrapped = nextStream
        // ensure the schedule is applied at least once
        nextStream = suspend(() => {
          if (attempted) return wrapped
          attempted = true
          return fail(error)
        })
        nextStream = retry(nextStream, internalExecutionPlan.scheduleFromStep(step, false) as any)
      } else {
        const schedule = internalExecutionPlan.scheduleFromStep(step, true)
        nextStream = schedule ? retry(nextStream, schedule as any) : nextStream
      }

      return catch_(
        preventFallbackOnPartialStream ?
          onFirst(nextStream, (_) => {
            receivedElements = true
            return Effect.void
          }) :
          nextStream,
        (error) => {
          i++
          if (preventFallbackOnPartialStream && receivedElements) {
            return fail(error)
          }
          lastError = Option.some(error)
          return loop
        }
      )
    })
    return loop
  }))

/**
 * Takes the first `n` elements from this stream, returning `Stream.empty` when `n < 1`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make(1, 2, 3, 4, 5).pipe(
 *     Stream.take(3),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const take: {
  (n: number): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R>
} = dual(
  2,
  <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R> =>
    n < 1 ? empty : takeUntil(self, (_, i) => i === (n - 1))
)

/**
 * Keeps the last `n` elements from this stream.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.range(1, 6).pipe(
 *     Stream.takeRight(3),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 4, 5, 6 ]
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const takeRight: {
  (n: number): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R>
} = dual(
  2,
  <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R> =>
    mapAccumArray(self, MutableList.make<A>, (list, arr) => {
      MutableList.appendAll(list, arr)
      if (list.length > n) {
        MutableList.takeNVoid(list, list.length - n)
      }
      return [list, emptyArr]
    }, {
      onHalt(list) {
        return MutableList.takeAll(list)
      }
    })
)

/**
 * Takes elements until the predicate matches.
 *
 * When `excludeLast` is `true`, the matching element is dropped.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.range(1, 5)
 *
 * const program = Effect.gen(function*() {
 *   const inclusive = yield* stream.pipe(
 *     Stream.takeUntil((n) => n % 3 === 0),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(inclusive)
 *   // Output: [ 1, 2, 3 ]
 *
 *   const exclusive = yield* stream.pipe(
 *     Stream.takeUntil((n) => n % 3 === 0, { excludeLast: true }),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(exclusive)
 *   // Output: [ 1, 2 ]
 * })
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const takeUntil: {
  <A>(predicate: (a: NoInfer<A>, n: number) => boolean, options?: {
    readonly excludeLast?: boolean | undefined
  }): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R>(self: Stream<A, E, R>, predicate: (a: A, n: number) => boolean, options?: {
    readonly excludeLast?: boolean | undefined
  }): Stream<A, E, R>
} = dual(
  (args) => isStream(args[0]),
  <A, E, R>(self: Stream<A, E, R>, predicate: (a: A, n: number) => boolean, options?: {
    readonly excludeLast?: boolean | undefined
  }): Stream<A, E, R> =>
    transformPull(self, (pull, _scope) =>
      Effect.sync(() => {
        let i = 0
        let done = false
        const pump: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void, R> = Effect.flatMap(
          Effect.suspend(() => done ? Cause.done() : pull),
          (chunk) => {
            const index = chunk.findIndex((a) => predicate(a, i++))
            if (index >= 0) {
              done = true
              const arr = chunk.slice(0, options?.excludeLast ? index : index + 1)
              return Arr.isReadonlyArrayNonEmpty(arr) ? Effect.succeed(arr) : Cause.done()
            }
            return Effect.succeed(chunk)
          }
        )
        return pump
      }))
)

/**
 * Effectful predicate version of `takeUntil`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.range(1, 5).pipe(
 *     Stream.takeUntilEffect((n) => Effect.succeed(n % 3 === 0)),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const takeUntilEffect: {
  <A, E2, R2>(
    predicate: (a: NoInfer<A>, n: number) => Effect.Effect<boolean, E2, R2>,
    options?: {
      readonly excludeLast?: boolean | undefined
    }
  ): <E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>
  <A, E, R, E2, R2>(
    self: Stream<A, E, R>,
    predicate: (a: A, n: number) => Effect.Effect<boolean, E2, R2>,
    options?: {
      readonly excludeLast?: boolean | undefined
    }
  ): Stream<A, E | E2, R | R2>
} = dual((args) => isStream(args[0]), <A, E, R, E2, R2>(
  self: Stream<A, E, R>,
  predicate: (a: A, n: number) => Effect.Effect<boolean, E2, R2>,
  options?: {
    readonly excludeLast?: boolean | undefined
  }
): Stream<A, E | E2, R | R2> =>
  transformPull(self, (pull, _scope) =>
    Effect.sync(() => {
      let i = 0
      let done = false
      return Effect.gen(function*() {
        if (done) return yield* Cause.done()
        const chunk = yield* pull
        for (let j = 0; j < chunk.length; j++) {
          if (yield* predicate(chunk[j], i++)) {
            done = true
            const arr = chunk.slice(0, options?.excludeLast ? j : j + 1)
            return Arr.isReadonlyArrayNonEmpty(arr) ? arr : yield* Cause.done()
          }
        }
        return chunk
      })
    })))

/**
 * Takes the longest initial prefix of elements that satisfy the predicate.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.range(1, 5).pipe(
 *   Stream.takeWhile((n) => n % 3 !== 0)
 * )
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2 ]
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const takeWhile: {
  <A, B extends A>(refinement: (a: NoInfer<A>, n: number) => a is B): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>
  <A>(predicate: (a: NoInfer<A>, n: number) => boolean): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R, B extends A>(self: Stream<A, E, R>, refinement: (a: NoInfer<A>, n: number) => a is B): Stream<B, E, R>
  <A, E, R>(self: Stream<A, E, R>, predicate: (a: NoInfer<A>, n: number) => boolean): Stream<A, E, R>
} = dual(
  2,
  <A, E, R>(
    self: Stream<A, E, R>,
    predicate: (a: A, n: number) => boolean
  ): Stream<A, E, R> =>
    transformPull(self, (pull, _scope) =>
      Effect.sync(() => {
        let i = 0
        let done = false
        const pump: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void, R> = Effect.flatMap(
          Effect.suspend(() => done ? Cause.done() : pull),
          (chunk) => {
            const out: Array<A> = []
            for (let j = 0; j < chunk.length; j++) {
              if (!predicate(chunk[j], i++)) {
                done = true
                break
              }
              out.push(chunk[j])
            }
            return Arr.isReadonlyArrayNonEmpty(out) ? Effect.succeed(out) : done ? Cause.done() : pump
          }
        )
        return pump
      }))
)

/**
 * Takes the longest initial prefix of elements that satisfy the filter.
 *
 * @since 4.0.0
 * @category Filtering
 */
export const takeWhileFilter: {
  <A, B, X>(f: Filter.Filter<NoInfer<A>, B, X>): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>
  <A, E, R, B, X>(self: Stream<A, E, R>, f: Filter.Filter<NoInfer<A>, B, X>): Stream<B, E, R>
} = dual(
  2,
  <A, E, R, B, X>(
    self: Stream<A, E, R>,
    filter: Filter.Filter<NoInfer<A>, B, X>
  ): Stream<B, E, R> =>
    transformPull(self, (pull, _scope) =>
      Effect.sync(() => {
        let done = false
        const pump: Pull.Pull<Arr.NonEmptyReadonlyArray<B>, E, void, R> = Effect.flatMap(
          Effect.suspend(() => done ? Cause.done() : pull),
          (chunk) => {
            const out: Array<B> = []
            for (let j = 0; j < chunk.length; j++) {
              const result = filter(chunk[j])
              if (Result.isFailure(result)) {
                done = true
                break
              }
              out.push(result.success)
            }
            return Arr.isReadonlyArrayNonEmpty(out) ? Effect.succeed(out) : done ? Cause.done() : pump
          }
        )
        return pump
      }))
)

/**
 * Takes elements from the stream while the effectful predicate is `true`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.range(1, 5).pipe(
 *     Stream.takeWhileEffect((n) => Effect.succeed(n % 3 !== 0)),
 *     Stream.runCollect
 *   )
 *   Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2 ]
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const takeWhileEffect: {
  <A, E2, R2>(
    predicate: (a: NoInfer<A>, n: number) => Effect.Effect<boolean, E2, R2>
  ): <E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R | R2>
  <A, E, R, E2, R2>(
    self: Stream<A, E, R>,
    predicate: (a: NoInfer<A>, n: number) => Effect.Effect<boolean, E2, R2>
  ): Stream<A, E | E2, R | R2>
} = dual(2, <A, E, R, E2, R2>(
  self: Stream<A, E, R>,
  predicate: (a: NoInfer<A>, n: number) => Effect.Effect<boolean, E2, R2>
) =>
  takeUntilEffect(self, (a, n) =>
    Effect.map(
      predicate(a, n),
      (b) => !b
    ), { excludeLast: true }))

/**
 * Drops the first `n` elements from this stream.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3, 4, 5)
 * const result = Stream.drop(stream, 2)
 *
 * const program = Effect.gen(function*() {
 *   const items = yield* Stream.runCollect(result)
 *   yield* Console.log(items)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 3, 4, 5 ]
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const drop: {
  (n: number): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R>
} = dual(
  2,
  <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R> =>
    transformPull(self, (pull, _scope) =>
      Effect.sync(() => {
        let dropped = 0
        const pump: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void, R> = pull.pipe(
          Effect.flatMap((chunk) => {
            if (dropped >= n) return Effect.succeed(chunk)
            dropped += chunk.length
            if (dropped <= n) return pump
            return Effect.succeed(chunk.slice(n - dropped) as Arr.NonEmptyArray<A>)
          })
        )
        return pump
      }))
)

/**
 * Drops elements until the specified predicate evaluates to `true`, then drops
 * that matching element.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3, 4, 5)
 * const result = Stream.dropUntil(stream, (n) => n >= 3)
 *
 * Effect.gen(function*() {
 *   const output = yield* Stream.runCollect(result)
 *   yield* Console.log(output) // Output: [ 4, 5 ]
 * })
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const dropUntil: {
  <A>(predicate: (a: NoInfer<A>, index: number) => boolean): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R>(self: Stream<A, E, R>, predicate: (a: NoInfer<A>, index: number) => boolean): Stream<A, E, R>
} = dual(2, <A, E, R>(
  self: Stream<A, E, R>,
  predicate: (a: NoInfer<A>, index: number) => boolean
): Stream<A, E, R> => drop(dropWhile(self, (a, i) => !predicate(a, i)), 1))

/**
 * Drops all elements of the stream until the specified effectful predicate
 * evaluates to `true`.
 *
 * The first element that satisfies the predicate is also dropped.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.range(1, 5).pipe(
 *     Stream.dropUntilEffect((n) => Effect.succeed(n % 3 === 0)),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 4, 5 ]
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const dropUntilEffect: {
  <A, E2, R2>(
    predicate: (a: NoInfer<A>, index: number) => Effect.Effect<boolean, E2, R2>
  ): <E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>
  <A, E, R, E2, R2>(
    self: Stream<A, E, R>,
    predicate: (a: NoInfer<A>, index: number) => Effect.Effect<boolean, E2, R2>
  ): Stream<A, E | E2, R | R2>
} = dual(2, <A, E, R, E2, R2>(
  self: Stream<A, E, R>,
  predicate: (a: NoInfer<A>, index: number) => Effect.Effect<boolean, E2, R2>
): Stream<A, E | E2, R | R2> =>
  drop(
    dropWhileEffect(
      self,
      (a, i) => Effect.map(predicate(a, i), (b) => !b)
    ),
    1
  ))

/**
 * Drops elements from the stream while the specified predicate evaluates to `true`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make(1, 2, 3, 4, 5).pipe(
 *     Stream.dropWhile((n) => n < 3),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 3, 4, 5 ]
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const dropWhile: {
  <A>(predicate: (a: NoInfer<A>, index: number) => boolean): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R>(self: Stream<A, E, R>, predicate: (a: NoInfer<A>, index: number) => boolean): Stream<A, E, R>
} = dual(2, <A, E, R>(
  self: Stream<A, E, R>,
  predicate: (a: A, index: number) => boolean
): Stream<A, E, R> =>
  transformPull(self, (pull, _scope) =>
    Effect.sync(() => {
      let dropping = true
      let index = 0
      const filtered: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E> = Effect.flatMap(pull, (arr) => {
        const found = arr.findIndex((a) => !predicate(a, index++))
        if (found === -1) return filtered
        dropping = false
        return Effect.succeed(arr.slice(found) as Arr.NonEmptyArray<A>)
      })
      return Effect.suspend(() => dropping ? filtered : pull)
    })))

/**
 * Drops elements while the filter succeeds.
 *
 * @since 4.0.0
 * @category Filtering
 */
export const dropWhileFilter: {
  <A, B, X>(filter: Filter.Filter<NoInfer<A>, B, X>): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R, B, X>(self: Stream<A, E, R>, filter: Filter.Filter<NoInfer<A>, B, X>): Stream<A, E, R>
} = dual(2, <A, E, R, B, X>(
  self: Stream<A, E, R>,
  filter: Filter.Filter<NoInfer<A>, B, X>
): Stream<A, E, R> =>
  transformPull(self, (pull, _scope) =>
    Effect.sync(() => {
      let dropping = true
      const filtered: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E> = Effect.flatMap(pull, (arr) => {
        const found = arr.findIndex((a) => Result.isFailure(filter(a)))
        if (found === -1) return filtered
        dropping = false
        return Effect.succeed(arr.slice(found) as Arr.NonEmptyArray<A>)
      })
      return Effect.suspend(() => dropping ? filtered : pull)
    })))

/**
 * Drops elements while the specified effectful predicate evaluates to `true`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.make(1, 2, 3, 4, 5).pipe(
 *     Stream.dropWhileEffect((n) => Effect.succeed(n < 3)),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 3, 4, 5 ]
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const dropWhileEffect: {
  <A, E2, R2>(
    predicate: (a: NoInfer<A>, index: number) => Effect.Effect<boolean, E2, R2>
  ): <E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>
  <A, E, R, E2, R2>(
    self: Stream<A, E, R>,
    predicate: (a: A, index: number) => Effect.Effect<boolean, E2, R2>
  ): Stream<A, E | E2, R | R2>
} = dual(2, <A, E, R, E2, R2>(
  self: Stream<A, E, R>,
  predicate: (a: NoInfer<A>, index: number) => Effect.Effect<boolean, E2, R2>
): Stream<A, E | E2, R | R2> =>
  transformPull(self, (pull, _scope) =>
    Effect.sync(() => {
      let dropping = true
      let index = 0
      const filtered: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E | E2, void, R2> = Effect.gen(function*() {
        while (true) {
          const arr = yield* pull
          for (let i = 0; i < arr.length; i++) {
            const drop = yield* predicate(arr[i], index++)
            if (drop) continue
            dropping = false
            return arr.slice(i) as Arr.NonEmptyArray<A>
          }
        }
      })
      return Effect.suspend((): Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E | E2, void, R | R2> =>
        dropping ? filtered : pull
      )
    })))

/**
 * Drops the last specified number of elements from this stream.
 *
 * Keeps the last `n` elements in memory to drop them on completion.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.make(1, 2, 3, 4, 5).pipe(
 *     Stream.dropRight(2),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Filtering
 */
export const dropRight: {
  (n: number): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R>
} = dual(
  2,
  <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R> => {
    if (n <= 0) return self
    return transformPull(self, (pull, _scope) =>
      Effect.sync(() => {
        const list = MutableList.make<A>()
        const emit: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E> = Effect.flatMap(pull, (arr) => {
          MutableList.appendAllUnsafe(list, arr)
          const toTake = list.length - n
          const items = MutableList.takeN(list, toTake)
          return Arr.isArrayNonEmpty(items) ? Effect.succeed(items) : emit
        })
        return emit
      }))
  }
)

/**
 * Exposes the underlying chunks as a stream of non-empty arrays.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const chunks = yield* Stream.make(1, 2, 3, 4).pipe(
 *     Stream.rechunk(2),
 *     Stream.chunks,
 *     Stream.runCollect
 *   )
 *   yield* Console.log(chunks)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ [ 1, 2 ], [ 3, 4 ] ]
 * ```
 *
 * @since 2.0.0
 * @category Grouping
 */
export const chunks = <A, E, R>(self: Stream<A, E, R>): Stream<Arr.NonEmptyReadonlyArray<A>, E, R> =>
  self.channel.pipe(
    Channel.map(Arr.of),
    fromChannel
  )

/**
 * Re-chunks the stream into arrays of the specified size, preserving element order.
 *
 * The size is clamped to at least 1.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.make(1, 2, 3, 4, 5).pipe(
 *     Stream.rechunk(2),
 *     Stream.chunks,
 *     Stream.runCollect
 *   )
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ [ 1, 2 ], [ 3, 4 ], [ 5 ] ]
 * ```
 *
 * @since 2.0.0
 * @category Grouping
 */
export const rechunk: {
  (size: number): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R>(self: Stream<A, E, R>, size: number): Stream<A, E, R>
} = dual(2, <A, E, R>(self: Stream<A, E, R>, target: number): Stream<A, E, R> => {
  target = Math.max(1, target)
  return transformPull(self, (pull, _scope) =>
    Effect.sync(() => {
      let chunk = Arr.empty<A>() as Arr.NonEmptyArray<A>
      let index = 0
      let current: Arr.NonEmptyReadonlyArray<A> | undefined
      let done = false

      return Effect.suspend(function loop(): Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void, R> {
        if (done) return Cause.done()
        else if (current === undefined) {
          return Effect.flatMap(pull, (arr) => {
            if (chunk.length === 0 && arr.length === target) {
              return Effect.succeed(arr)
            } else if (chunk.length + arr.length < target) {
              chunk.push(...arr)
              return loop()
            }
            current = arr
            return loop()
          })
        }
        for (; index < current.length;) {
          chunk.push(current[index++])
          if (chunk.length === target) {
            const result = chunk
            chunk = [] as any
            return Effect.succeed(result)
          }
        }
        index = 0
        current = undefined
        return loop()
      }).pipe(
        Pull.catchDone(() => {
          if (chunk.length === 0) return Cause.done()
          const result = chunk
          done = true
          chunk = [] as any
          return Effect.succeed(result)
        })
      )
    }))
})

/**
 * Emits a sliding window of `n` elements.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream, pipe } from "effect"
 *
 * Effect.gen(function*() {
 *   const result = yield* pipe(
 *     Stream.make(1, 2, 3, 4, 5),
 *     Stream.sliding(2),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(result)
 * })
 * // Output: [ [1, 2], [2, 3], [3, 4], [4, 5] ]
 * ```
 *
 * @since 2.0.0
 * @category Grouping
 */
export const sliding: {
  (chunkSize: number): <A, E, R>(self: Stream<A, E, R>) => Stream<Arr.NonEmptyReadonlyArray<A>, E, R>
  <A, E, R>(self: Stream<A, E, R>, chunkSize: number): Stream<Arr.NonEmptyReadonlyArray<A>, E, R>
} = dual(
  2,
  <A, E, R>(self: Stream<A, E, R>, chunkSize: number): Stream<Arr.NonEmptyReadonlyArray<A>, E, R> =>
    slidingSize(self, chunkSize, 1)
)

/**
 * Emits sliding windows of `chunkSize` elements, advancing by `stepSize`.
 *
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const chunks = yield* Stream.make(1, 2, 3, 4, 5).pipe(
 *     Stream.slidingSize(3, 2),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(chunks)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ [ 1, 2, 3 ], [ 3, 4, 5 ] ]
 * ```
 *
 * @since 2.0.0
 * @category Grouping
 */
export const slidingSize: {
  (chunkSize: number, stepSize: number): <A, E, R>(self: Stream<A, E, R>) => Stream<Arr.NonEmptyReadonlyArray<A>, E, R>
  <A, E, R>(self: Stream<A, E, R>, chunkSize: number, stepSize: number): Stream<Arr.NonEmptyReadonlyArray<A>, E, R>
} = dual(
  3,
  <A, E, R>(self: Stream<A, E, R>, chunkSize: number, stepSize: number): Stream<Arr.NonEmptyReadonlyArray<A>, E, R> =>
    transformPull(self, (upstream, _scope) =>
      Effect.sync(() => {
        let cause: Cause.Cause<E | Cause.Done> | null = null
        const list = MutableList.make<A>()
        let emitted = false
        const pull: Pull.Pull<
          Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<A>>,
          E | Cause.Done
        > = Effect.matchCauseEffect(upstream, {
          onSuccess(arr) {
            MutableList.appendAllUnsafe(list, arr)
            if (list.length < chunkSize) return pull
            emitted = true
            const chunks = [] as any as Arr.NonEmptyArray<Arr.NonEmptyReadonlyArray<A>>
            while (list.length >= chunkSize) {
              if (chunkSize === stepSize) {
                chunks.push(MutableList.takeN(list, chunkSize) as any)
              } else {
                chunks.push(MutableList.toArrayN(list, chunkSize) as any)
                if (chunkSize === 1) {
                  MutableList.take(list)
                } else {
                  MutableList.takeNVoid(list, stepSize)
                }
              }
            }
            return Effect.succeed(chunks)
          },
          onFailure(cause_) {
            if (emitted) MutableList.takeNVoid(list, chunkSize - stepSize)
            if (list.length === 0) return Effect.failCause(cause_)
            cause = cause_
            return Effect.succeed(Arr.of(MutableList.takeAll(list) as any))
          }
        })

        return Effect.suspend(() => cause ? Effect.failCause(cause) : pull)
      }))
)

/**
 * Splits the stream into non-empty groups whenever the predicate matches.
 *
 * Matching elements act as delimiters and are not included in the output.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.range(0, 9).pipe(
 *     Stream.split((n) => n % 4 === 0),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ [1, 2, 3], [5, 6, 7], [9] ]
 * ```
 *
 * @since 2.0.0
 * @category Grouping
 */
export const split: {
  <A, B extends A>(
    refinement: Refinement<NoInfer<A>, B>
  ): <E, R>(self: Stream<A, E, R>) => Stream<Arr.NonEmptyReadonlyArray<Exclude<A, B>>, E, R>
  <A>(predicate: Predicate<NoInfer<A>>): <E, R>(self: Stream<A, E, R>) => Stream<Arr.NonEmptyReadonlyArray<A>, E, R>
  <A, E, R, B extends A>(
    self: Stream<A, E, R>,
    refinement: Refinement<A, B>
  ): Stream<Arr.NonEmptyReadonlyArray<Exclude<A, B>>, E, R>
  <A, E, R>(self: Stream<A, E, R>, predicate: Predicate<A>): Stream<Arr.NonEmptyReadonlyArray<A>, E, R>
} = dual(2, <A, E, R>(
  self: Stream<A, E, R>,
  predicate: Predicate<NoInfer<A>>
): Stream<Arr.NonEmptyReadonlyArray<A>, E, R> =>
  mapAccumArray(self, Arr.empty<A>, (acc, arr) => {
    const out = Arr.empty<Arr.NonEmptyReadonlyArray<A>>()
    for (let i = 0; i < arr.length; i++) {
      if (predicate(arr[i])) {
        if (Arr.isArrayNonEmpty(acc)) {
          out.push(acc)
          acc = []
        }
      } else {
        acc.push(arr[i])
      }
    }
    return [acc, out]
  }, {
    onHalt(arr) {
      return Arr.isArrayNonEmpty(arr) ? Arr.of(arr) : emptyArr
    }
  }))

/**
 * Combines elements from this stream and the specified stream by repeatedly
 * applying a stateful function that can pull from either side.
 *
 * Where possible, prefer `Stream.combineArray` for a more efficient
 * implementation.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.combine(
 *   Stream.make("A", "B", "C"),
 *   Stream.make(1, 2, 3),
 *   () => true,
 *   (takeLeft, pullLeft, pullRight) =>
 *     takeLeft
 *       ? Effect.map(pullLeft, (value) => [`L:${value}`, false] as const)
 *       : Effect.map(pullRight, (value) => [`R:${value}`, true] as const)
 * )
 *
 * const program = Effect.gen(function*() {
 *   const output = yield* Stream.runCollect(stream)
 *   yield* Console.log(output)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ "L:A", "R:1", "L:B", "R:2", "L:C", "R:3" ]
 * ```
 *
 * @since 2.0.0
 * @category Merging
 */
export const combine: {
  <A2, E2, R2, S, E, A, A3, E3, R3>(
    that: Stream<A2, E2, R2>,
    s: LazyArg<S>,
    f: (
      s: S,
      pullLeft: Pull.Pull<A, E, void>,
      pullRight: Pull.Pull<A2, E2, void>
    ) => Effect.Effect<readonly [A3, S], E3, R3>
  ): <R>(self: Stream<A, E, R>) => Stream<A3, E3, R2 | R3 | R>
  <A, E, R, A2, E2, R2, S, A3, E3, R3>(
    self: Stream<A, E, R>,
    that: Stream<A2, E2, R2>,
    s: LazyArg<S>,
    f: (
      s: S,
      pullLeft: Pull.Pull<A, E, void>,
      pullRight: Pull.Pull<A2, E2, void>
    ) => Effect.Effect<readonly [A3, S], E3, R3>
  ): Stream<A3, E3, R | R2 | R3>
} = dual(4, <A, E, R, A2, E2, R2, S, A3, E3, R3>(
  self: Stream<A, E, R>,
  that: Stream<A2, E2, R2>,
  s: LazyArg<S>,
  f: (
    s: S,
    pullLeft: Pull.Pull<A, E, void>,
    pullRight: Pull.Pull<A2, E2, void>
  ) => Effect.Effect<readonly [A3, S], E3, R3>
): Stream<A3, E3, R | R2 | R3> =>
  Channel.combine(
    Channel.flattenArray(self.channel),
    Channel.flattenArray(that.channel),
    s,
    f
  ).pipe(
    Channel.map(Arr.of),
    fromChannel
  ))

/**
 * Combines the arrays (chunks) from this stream and the specified stream by
 * repeatedly applying the function `f` to extract an array using both sides and
 * conceptually "offer" it to the destination stream. `f` can maintain some
 * internal state to control the combining process, with the initial state
 * being specified by `s`.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Stream.combineChunks`
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2).pipe(
 *   Stream.combineArray(
 *     Stream.make(10, 20),
 *     () => true,
 *     (useLeft, pullLeft, pullRight) =>
 *       Effect.gen(function*() {
 *         const array = useLeft ? yield* pullLeft : yield* pullRight
 *         return [array, !useLeft] as const
 *       })
 *   )
 * )
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 10, 20 ]
 * ```
 *
 * @since 2.0.0
 * @category Sequencing
 */
export const combineArray: {
  <A2, E2, R2, S, E, A, A3, E3, R3>(
    that: Stream<A2, E2, R2>,
    s: LazyArg<S>,
    f: (
      s: S,
      pullLeft: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void>,
      pullRight: Pull.Pull<Arr.NonEmptyReadonlyArray<A2>, E2, void>
    ) => Effect.Effect<readonly [Arr.NonEmptyReadonlyArray<A3>, S], E3, R3>
  ): <R>(self: Stream<A, E, R>) => Stream<A3, Pull.ExcludeDone<E3>, R2 | R3 | R>
  <R, A2, E2, R2, S, E, A, A3, E3, R3>(
    self: Stream<A, E, R>,
    that: Stream<A2, E2, R2>,
    s: LazyArg<S>,
    f: (
      s: S,
      pullLeft: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void>,
      pullRight: Pull.Pull<Arr.NonEmptyReadonlyArray<A2>, E2, void>
    ) => Effect.Effect<readonly [Arr.NonEmptyReadonlyArray<A3>, S], E3, R3>
  ): Stream<A3, Pull.ExcludeDone<E3>, R | R2 | R3>
} = dual(4, <R, A2, E2, R2, S, E, A, A3, E3, R3>(
  self: Stream<A, E, R>,
  that: Stream<A2, E2, R2>,
  s: LazyArg<S>,
  f: (
    s: S,
    pullLeft: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void>,
    pullRight: Pull.Pull<Arr.NonEmptyReadonlyArray<A2>, E2, void>
  ) => Effect.Effect<readonly [Arr.NonEmptyReadonlyArray<A3>, S], E3, R3>
): Stream<A3, Pull.ExcludeDone<E3>, R | R2 | R3> =>
  fromChannel(Channel.combine(
    self.channel,
    that.channel,
    s,
    f
  )))

/**
 * Statefully maps elements, emitting zero or more outputs per input.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const totals = yield* Stream.make(0, 1, 2, 3, 4, 5, 6).pipe(
 *     Stream.mapAccum(() => 0, (total, n) => {
 *       const next = total + n
 *       return [next, [next]] as const
 *     }),
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(totals)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 0, 1, 3, 6, 10, 15, 21 ]
 * ```
 *
 * @since 2.0.0
 * @category Mapping
 */
export const mapAccum: {
  <S, A, B>(
    initial: LazyArg<S>,
    f: (s: S, a: A) => readonly [state: S, values: ReadonlyArray<B>],
    options?: {
      readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined
    }
  ): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>
  <A, E, R, S, B>(
    self: Stream<A, E, R>,
    initial: LazyArg<S>,
    f: (s: S, a: A) => readonly [state: S, values: ReadonlyArray<B>],
    options?: {
      readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined
    }
  ): Stream<B, E, R>
} = dual((args) => isStream(args[0]), <A, E, R, S, B>(
  self: Stream<A, E, R>,
  initial: LazyArg<S>,
  f: (s: S, a: A) => readonly [state: S, values: ReadonlyArray<B>],
  options?: {
    readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined
  }
): Stream<B, E, R> =>
  fromChannel(Channel.mapAccum(
    self.channel,
    initial,
    (state, arr) => {
      const acc = Arr.empty<B>()
      for (let index = 0; index < arr.length; index++) {
        const [newState, values] = f(state, arr[index])
        state = newState
        acc.push(...values)
      }
      return [state, Arr.isArrayNonEmpty(acc) ? Arr.of(acc) : emptyArr]
    },
    options?.onHalt ?
      {
        onHalt(state) {
          const arr = options.onHalt!(state)
          return Arr.isReadonlyArrayNonEmpty(arr) ? Arr.of(arr) : emptyArr
        }
      } :
      undefined
  )))

/**
 * Statefully maps over non-empty chunk arrays, emitting zero or more values per chunk.
 *
 * The mapping function runs once per chunk and the state is threaded across chunks.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const output = yield* Stream.make(1, 2, 3, 4, 5, 6).pipe(
 *     Stream.rechunk(2),
 *     Stream.mapAccumArray(() => 0, (sum: number, chunk) => {
 *       const next = chunk.reduce((acc, n) => acc + n, sum)
 *       return [next, [next]]
 *     }),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(output)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 3, 10, 21 ]
 * ```
 *
 * @since 2.0.0
 * @category Mapping
 */
export const mapAccumArray: {
  <S, A, B>(
    initial: LazyArg<S>,
    f: (s: S, a: Arr.NonEmptyReadonlyArray<A>) => readonly [state: S, values: ReadonlyArray<B>],
    options?: {
      readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined
    }
  ): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>
  <A, E, R, S, B>(
    self: Stream<A, E, R>,
    initial: LazyArg<S>,
    f: (s: S, a: Arr.NonEmptyReadonlyArray<A>) => readonly [state: S, values: ReadonlyArray<B>],
    options?: {
      readonly onHalt?: ((state: S) => Array<B>) | undefined
    }
  ): Stream<B, E, R>
} = dual((args) => isStream(args[0]), <A, E, R, S, B>(
  self: Stream<A, E, R>,
  initial: LazyArg<S>,
  f: (s: S, a: Arr.NonEmptyReadonlyArray<A>) => readonly [state: S, values: ReadonlyArray<B>],
  options?: {
    readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined
  }
): Stream<B, E, R> =>
  fromChannel(Channel.mapAccum(
    self.channel,
    initial,
    (state, arr) => {
      const [newState, values] = f(state, arr)
      state = newState
      return [state, Arr.isReadonlyArrayNonEmpty(values) ? Arr.of(values) : emptyArr]
    },
    options?.onHalt ?
      {
        onHalt(state) {
          const arr = options.onHalt!(state)
          return Arr.isReadonlyArrayNonEmpty(arr) ? Arr.of(arr) : emptyArr
        }
      } :
      undefined
  )))

const emptyArr = Arr.empty<never>()

/**
 * Statefully and effectfully maps over the elements of this stream to produce new elements.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.make(1, 1, 1).pipe(
 *     Stream.mapAccumEffect(() => 0, (total, n) =>
 *       Effect.succeed([total + n, [total + n]])
 *     ),
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Mapping
 */
export const mapAccumEffect: {
  <S, A, B, E2, R2>(
    initial: LazyArg<S>,
    f: (s: S, a: A) => Effect.Effect<readonly [state: S, values: ReadonlyArray<B>], E2, R2>,
    options?: {
      readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined
    }
  ): <E, R>(self: Stream<A, E, R>) => Stream<B, E | E2, R | R2>
  <A, E, R, S, B, E2, R2>(
    self: Stream<A, E, R>,
    initial: LazyArg<S>,
    f: (s: S, a: A) => Effect.Effect<readonly [state: S, values: ReadonlyArray<B>], E2, R2>,
    options?: {
      readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined
    }
  ): Stream<B, E | E2, R | R2>
} = dual((args) => isStream(args[0]), <A, E, R, S, B, E2, R2>(
  self: Stream<A, E, R>,
  initial: LazyArg<S>,
  f: (s: S, a: A) => Effect.Effect<readonly [state: S, values: ReadonlyArray<B>], E2, R2>,
  options?: {
    readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined
  }
): Stream<B, E | E2, R | R2> =>
  self.channel.pipe(
    Channel.flattenArray,
    Channel.mapAccum(
      initial,
      (state, a) =>
        Effect.map(
          f(state, a),
          ([state, values]) => [
            state,
            Arr.isReadonlyArrayNonEmpty(values) ? Arr.of(values) : Arr.empty<Arr.NonEmptyReadonlyArray<B>>()
          ]
        ),
      options?.onHalt ?
        {
          onHalt(state) {
            const arr = options.onHalt!(state)
            return Arr.isReadonlyArrayNonEmpty(arr) ? Arr.of(arr) : emptyArr
          }
        } :
        undefined
    ),
    fromChannel
  ))

/**
 * Statefully and effectfully maps over chunks of this stream to emit new values.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const totals = yield* Stream.make(1, 2, 3, 4).pipe(
 *     Stream.rechunk(2),
 *     Stream.mapAccumArrayEffect(() => 0, (total, chunk) =>
 *       Effect.gen(function*() {
 *         const next = chunk.reduce((sum, value) => sum + value, total)
 *         return [next, [next]] as const
 *       })
 *     ),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(totals)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 3, 10 ]
 * ```
 *
 * @since 2.0.0
 * @category Mapping
 */
export const mapAccumArrayEffect: {
  <S, A, B, E2, R2>(
    initial: LazyArg<S>,
    f: (s: S, a: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<readonly [state: S, values: ReadonlyArray<B>], E2, R2>,
    options?: {
      readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined
    }
  ): <E, R>(self: Stream<A, E, R>) => Stream<B, E | E2, R | R2>
  <A, E, R, S, B, E2, R2>(
    self: Stream<A, E, R>,
    initial: LazyArg<S>,
    f: (s: S, a: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<readonly [state: S, values: ReadonlyArray<B>], E2, R2>,
    options?: {
      readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined
    }
  ): Stream<B, E | E2, R | R2>
} = dual((args) => isStream(args), <A, E, R, S, B, E2, R2>(
  self: Stream<A, E, R>,
  initial: LazyArg<S>,
  f: (s: S, a: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<readonly [state: S, values: ReadonlyArray<B>], E2, R2>,
  options?: {
    readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined
  }
): Stream<B, E | E2, R | R2> =>
  self.channel.pipe(
    Channel.mapAccum(
      initial,
      (state, a) =>
        Effect.map(
          f(state, a),
          ([state, values]) => [
            state,
            Arr.isReadonlyArrayNonEmpty(values) ? Arr.of(values) : emptyArr
          ]
        ),
      options?.onHalt ?
        {
          onHalt(state) {
            const arr = options.onHalt!(state)
            return Arr.isReadonlyArrayNonEmpty(arr) ? Arr.of(arr) : emptyArr
          }
        } :
        undefined
    ),
    fromChannel
  ))

/**
 * Accumulates state across the stream, emitting the initial state and each updated state.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make(1, 2, 3).pipe(
 *     Stream.scan(0, (acc, n) => acc + n),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ 0, 1, 3, 6 ]
 * ```
 *
 * @since 2.0.0
 * @category Accumulation
 */
export const scan: {
  <S, A>(
    initial: S,
    f: (s: S, a: A) => S
  ): <E, R>(self: Stream<A, E, R>) => Stream<S, E, R>
  <A, E, R, S>(
    self: Stream<A, E, R>,
    initial: S,
    f: (s: S, a: A) => S
  ): Stream<S, E, R>
} = dual(3, <A, E, R, S>(
  self: Stream<A, E, R>,
  initial: S,
  f: (s: S, a: A) => S
): Stream<S, E, R> =>
  suspend(() => {
    let isFirst = true
    return fromChannel(Channel.mapAccum(self.channel, constant(initial), (state, arr) => {
      const states = Arr.empty<S>() as Arr.NonEmptyArray<S>
      if (isFirst) {
        isFirst = false
        states.push(state)
      }
      for (let index = 0; index < arr.length; index++) {
        state = f(state, arr[index])
        states.push(state)
      }
      return [state, Arr.of(states)]
    }))
  }))

/**
 * Effectfully accumulates state and emits the initial state plus each accumulated state.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const states = yield* Stream.make(1, 2, 3).pipe(
 *     Stream.scanEffect(0, (sum, n) => Effect.succeed(sum + n)),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(states)
 *   // Output: [ 0, 1, 3, 6 ]
 * })
 * ```
 *
 * @since 2.0.0
 * @category Accumulation
 */
export const scanEffect: {
  <S, A, E2, R2>(
    initial: S,
    f: (s: S, a: A) => Effect.Effect<S, E2, R2>
  ): <E, R>(self: Stream<A, E, R>) => Stream<S, E | E2, R | R2>
  <A, E, R, S, E2, R2>(
    self: Stream<A, E, R>,
    initial: S,
    f: (s: S, a: A) => Effect.Effect<S, E2, R2>
  ): Stream<S, E | E2, R | R2>
} = dual(3, <A, E, R, S, E2, R2>(
  self: Stream<A, E, R>,
  initial: S,
  f: (s: S, a: A) => Effect.Effect<S, E2, R2>
): Stream<S, E | E2, R | R2> =>
  self.channel.pipe(
    Channel.flattenArray,
    Channel.scanEffect(initial, f),
    Channel.map(Arr.of),
    fromChannel
  ))

/**
 * Drops earlier elements within the debounce window and emits only the latest element after the pause.
 *
 * @example
 * ```ts
 * import { Console, Duration, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3).pipe(
 *   Stream.concat(Stream.fromEffect(Effect.sleep(Duration.millis(50)).pipe(Effect.as(4)))),
 *   Stream.concat(Stream.make(5)),
 *   Stream.debounce(Duration.millis(30))
 * )
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 *   // Output: [ 3, 5 ]
 * })
 * ```
 *
 * @since 2.0.0
 * @category Rate Limiting
 */
export const debounce: {
  (duration: Duration.Input): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R>(self: Stream<A, E, R>, duration: Duration.Input): Stream<A, E, R>
} = dual(
  2,
  <A, E, R>(self: Stream<A, E, R>, duration: Duration.Input): Stream<A, E, R> =>
    transformPull(
      self,
      Effect.fnUntraced(function*(pull, scope) {
        const clock = yield* Clock
        const durationMs = Duration.toMillis(Duration.fromInputUnsafe(duration))
        let lastArr: Arr.NonEmptyReadonlyArray<A> | undefined
        let cause: Cause.Cause<Cause.Done | E> | undefined
        let emitAtMs = Infinity
        const pullLatch = Latch.makeUnsafe()
        const emitLatch = Latch.makeUnsafe()
        const endLatch = Latch.makeUnsafe()

        yield* pull.pipe(
          pullLatch.whenOpen,
          Effect.flatMap((arr) => {
            emitLatch.openUnsafe()
            lastArr = arr
            emitAtMs = clock.currentTimeMillisUnsafe() + durationMs
            return Effect.void
          }),
          Effect.forever({ disableYield: true }),
          Effect.onError((cause_) => {
            cause = cause_
            emitAtMs = clock.currentTimeMillisUnsafe()
            emitLatch.openUnsafe()
            endLatch.openUnsafe()
            return Effect.void
          }),
          Effect.forkIn(scope)
        )

        const sleepLoop = Effect.suspend(function loop(): Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void, R> {
          const now = clock.currentTimeMillisUnsafe()
          const timeMs = emitAtMs < now ? durationMs : Math.min(durationMs, emitAtMs - now)
          return Effect.flatMap(Effect.raceFirst(Effect.sleep(timeMs), endLatch.await), () => {
            const now = clock.currentTimeMillisUnsafe()
            if (now < emitAtMs) {
              return loop()
            } else if (lastArr) {
              emitLatch.closeUnsafe()
              pullLatch.closeUnsafe()
              const eff = Effect.succeed(Arr.of(Arr.lastNonEmpty(lastArr)))
              lastArr = undefined
              return eff
            } else if (cause) {
              return Effect.failCause(cause!)
            }
            return loop()
          })
        })

        return Effect.suspend(() => {
          if (cause) {
            if (lastArr) {
              const eff = Effect.succeed(Arr.of(Arr.lastNonEmpty(lastArr)))
              lastArr = undefined
              return eff
            }
            return Effect.failCause(cause)
          }
          pullLatch.openUnsafe()
          return emitLatch.whenOpen(sleepLoop)
        })
      })
    )
)

/**
 * Delays the arrays of this stream according to the given bandwidth
 * parameters using the token bucket algorithm. Allows for burst processing by
 * allowing the bucket to accumulate tokens up to a `units + burst` threshold.
 * The weight of each array is determined by the effectful `cost` function.
 *
 * If using the "enforce" strategy, arrays that do not meet the bandwidth
 * constraints are dropped. If using the "shape" strategy, arrays are delayed
 * until they can be emitted without exceeding the bandwidth constraints.
 *
 * Defaults to the "shape" strategy.
 *
 * @example
 * ```ts
 * import { Console, Effect, Schedule, Stream } from "effect"
 *
 * const stream = Stream.fromSchedule(Schedule.spaced("50 millis")).pipe(
 *   Stream.take(6),
 *   Stream.throttleEffect({
 *     cost: (arr) => Effect.succeed(arr.length),
 *     units: 1,
 *     duration: "100 millis",
 *     strategy: "shape"
 *   })
 * )
 *
 * Effect.runPromise(Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * }))
 * // Output: [0, 1, 2, 3, 4, 5]
 * ```
 *
 * @since 2.0.0
 * @category Rate Limiting
 */
export const throttleEffect: {
  <A, E2, R2>(options: {
    readonly cost: (arr: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<number, E2, R2>
    readonly units: number
    readonly duration: Duration.Input
    readonly burst?: number | undefined
    readonly strategy?: "enforce" | "shape" | undefined
  }): <E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>
  <A, E, R, E2, R2>(
    self: Stream<A, E, R>,
    options: {
      readonly cost: (arr: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<number, E2, R2>
      readonly units: number
      readonly duration: Duration.Input
      readonly burst?: number | undefined
      readonly strategy?: "enforce" | "shape" | undefined
    }
  ): Stream<A, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, E2, R2>(
    self: Stream<A, E, R>,
    options: {
      readonly cost: (arr: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<number, E2, R2>
      readonly units: number
      readonly duration: Duration.Input
      readonly burst?: number | undefined
      readonly strategy?: "enforce" | "shape" | undefined
    }
  ): Stream<A, E | E2, R | R2> => {
    const burst = options.burst ?? 0
    if (options.strategy === "enforce") {
      return throttleEnforceEffect(self, options.cost, options.units, options.duration, burst)
    }
    return throttleShapeEffect(self, options.cost, options.units, options.duration, burst)
  }
)

const throttleEnforceEffect = <A, E, R, E2, R2>(
  self: Stream<A, E, R>,
  cost: (arr: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<number, E2, R2>,
  units: number,
  duration: Duration.Input,
  burst: number
): Stream<A, E | E2, R | R2> =>
  transformPull(self, (pull) =>
    Effect.clockWith((clock) => {
      const durationMs = Duration.toMillis(Duration.fromInputUnsafe(duration))
      const max = units + burst < 0 ? Number.POSITIVE_INFINITY : units + burst
      let tokens = units
      let timestampMs = clock.currentTimeMillisUnsafe()

      return Effect.succeed(
        Effect.flatMap(pull, function loop(arr): Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E | E2, void, R | R2> {
          return Effect.flatMap(cost(arr), (weight) => {
            const currentMs = clock.currentTimeMillisUnsafe()
            const elapsed = currentMs - timestampMs
            const cycles = elapsed / durationMs
            const sum = tokens + (cycles * units)
            const available = sum < 0 ? max : Math.min(sum, max)

            if (weight <= available) {
              tokens = available - weight
              timestampMs = currentMs
              return Effect.succeed(arr)
            }

            // Drop the array and continue
            return Effect.flatMap(pull, loop)
          })
        })
      )
    }))

const throttleShapeEffect = <A, E, R, E2, R2>(
  self: Stream<A, E, R>,
  cost: (arr: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<number, E2, R2>,
  units: number,
  duration: Duration.Input,
  burst: number
): Stream<A, E | E2, R | R2> =>
  transformPull(self, (pull) =>
    Effect.clockWith((clock) => {
      const durationMs = Duration.toMillis(Duration.fromInputUnsafe(duration))
      const max = units + burst < 0 ? Number.POSITIVE_INFINITY : units + burst
      let tokens = units
      let timestampMs = clock.currentTimeMillisUnsafe()

      return Effect.succeed(Effect.flatMap(pull, (arr) =>
        Effect.flatMap(cost(arr), (weight) => {
          const currentMs = clock.currentTimeMillisUnsafe()
          const elapsed = currentMs - timestampMs
          const cycles = elapsed / durationMs
          const sum = tokens + (cycles * units)
          const available = sum < 0 ? max : Math.min(sum, max)
          const remaining = available - weight

          if (remaining >= 0) {
            tokens = remaining
            timestampMs = currentMs
            return Effect.succeed(arr)
          }

          // Calculate delay needed
          const waitCycles = -remaining / units
          const delayMs = Math.max(0, waitCycles * durationMs)

          if (delayMs > 0) {
            return Effect.flatMap(Effect.sleep(delayMs), () => {
              tokens = remaining
              timestampMs = currentMs
              return Effect.succeed(arr)
            })
          }

          tokens = remaining
          timestampMs = currentMs
          return Effect.succeed(arr)
        })))
    }))

/**
 * Delays the arrays of this stream using a token bucket and a per-array cost.
 * Allows bursts by letting the bucket accumulate up to a `units + burst`
 * threshold. The weight of each array is determined by the `cost` function.
 *
 * If using the "enforce" strategy, arrays that do not meet the bandwidth
 * constraints are dropped. If using the "shape" strategy, arrays are delayed
 * until they can be emitted without exceeding the bandwidth constraints.
 *
 * Defaults to the "shape" strategy.
 *
 * @example
 * ```ts
 * import { Console, Effect, Schedule, Stream } from "effect"
 *
 * const stream = Stream.fromSchedule(Schedule.spaced("50 millis")).pipe(
 *   Stream.take(6),
 *   Stream.throttle({
 *     cost: (arr) => arr.length,
 *     units: 1,
 *     duration: "100 millis",
 *     strategy: "shape"
 *   })
 * )
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 *   // Output: [ 0, 1, 2, 3, 4, 5 ]
 * })
 * ```
 *
 * @since 2.0.0
 * @category Rate Limiting
 */
export const throttle: {
  <A>(options: {
    readonly cost: (arr: Arr.NonEmptyReadonlyArray<A>) => number
    readonly units: number
    readonly duration: Duration.Input
    readonly burst?: number | undefined
    readonly strategy?: "enforce" | "shape" | undefined
  }): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R>(
    self: Stream<A, E, R>,
    options: {
      readonly cost: (arr: Arr.NonEmptyReadonlyArray<A>) => number
      readonly units: number
      readonly duration: Duration.Input
      readonly burst?: number | undefined
      readonly strategy?: "enforce" | "shape" | undefined
    }
  ): Stream<A, E, R>
} = dual(
  2,
  <A, E, R>(
    self: Stream<A, E, R>,
    options: {
      readonly cost: (arr: Arr.NonEmptyReadonlyArray<A>) => number
      readonly units: number
      readonly duration: Duration.Input
      readonly burst?: number | undefined
      readonly strategy?: "enforce" | "shape" | undefined
    }
  ): Stream<A, E, R> =>
    throttleEffect(self, {
      ...options,
      cost: (arr) => Effect.succeed(options.cost(arr))
    })
)

/**
 * Partitions the stream into non-empty arrays of the specified size.
 *
 * The final array may be smaller if there are not enough elements to fill it.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const grouped = yield* Stream.range(1, 8).pipe(
 *     Stream.grouped(3),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(grouped)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ [ 1, 2, 3 ], [ 4, 5, 6 ], [ 7, 8 ] ]
 * ```
 *
 * @since 2.0.0
 * @category Grouping
 */
export const grouped: {
  (n: number): <A, E, R>(self: Stream<A, E, R>) => Stream<Arr.NonEmptyReadonlyArray<A>, E, R>
  <A, E, R>(self: Stream<A, E, R>, n: number): Stream<Arr.NonEmptyReadonlyArray<A>, E, R>
} = dual(
  2,
  <A, E, R>(self: Stream<A, E, R>, n: number): Stream<Arr.NonEmptyReadonlyArray<A>, E, R> => chunks(rechunk(self, n))
)

/**
 * Partitions the stream into arrays, emitting when the chunk size is reached
 * or the duration passes.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make(1, 2, 3).pipe(
 *     Stream.groupedWithin(2, "5 seconds"),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ [ 1, 2 ], [ 3 ] ]
 * ```
 *
 * @since 2.0.0
 * @category Grouping
 */
export const groupedWithin: {
  (
    chunkSize: number,
    duration: Duration.Input
  ): <A, E, R>(self: Stream<A, E, R>) => Stream<Array<A>, E, R>
  <A, E, R>(self: Stream<A, E, R>, chunkSize: number, duration: Duration.Input): Stream<Array<A>, E, R>
} = dual(3, <A, E, R>(
  self: Stream<A, E, R>,
  chunkSize: number,
  duration: Duration.Input
): Stream<Array<A>, E, R> =>
  aggregateWithin(
    self,
    Sink.take(chunkSize),
    Schedule.spaced(duration)
  ))

/**
 * Groups elements into keyed substreams using an effectful classifier.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const grouped = yield* Stream.make(1, 2, 3, 4, 5).pipe(
 *     Stream.groupBy((n) =>
 *       Effect.succeed([n % 2 === 0 ? "even" : "odd", n] as const)
 *     ),
 *     Stream.mapEffect(
 *       Effect.fnUntraced(function*([key, stream]) {
 *         return [key, yield* Stream.runCollect(stream)] as const
 *       }),
 *       { concurrency: "unbounded" }
 *     ),
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(grouped)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ [ "odd", [ 1, 3, 5 ] ], [ "even", [ 2, 4 ] ] ]
 * ```
 *
 * @since 2.0.0
 * @category Grouping
 */
export const groupBy: {
  <A, K, V, E2, R2>(
    f: (a: NoInfer<A>) => Effect.Effect<readonly [K, V], E2, R2>,
    options?: {
      readonly bufferSize?: number | undefined
      readonly idleTimeToLive?: Duration.Input | undefined
    }
  ): <E, R>(self: Stream<A, E, R>) => Stream<readonly [K, Stream<V>], E | E2, R | R2>
  <A, E, R, K, V, E2, R2>(
    self: Stream<A, E, R>,
    f: (a: NoInfer<A>) => Effect.Effect<readonly [K, V], E2, R2>,
    options?: {
      readonly bufferSize?: number | undefined
      readonly idleTimeToLive?: Duration.Input | undefined
    }
  ): Stream<readonly [K, Stream<V>], E | E2, R | R2>
} = dual((args) => isStream(args[0]), <A, E, R, K, V, E2, R2>(
  self: Stream<A, E, R>,
  f: (a: NoInfer<A>) => Effect.Effect<readonly [K, V], E2, R2>,
  options?: {
    readonly bufferSize?: number | undefined
    readonly idleTimeToLive?: Duration.Input | undefined
  }
): Stream<readonly [K, Stream<V>], E | E2, R | R2> =>
  groupByImpl(
    self,
    Effect.fnUntraced(function*(arr, queues, queueMap) {
      for (let i = 0; i < arr.length; i++) {
        const [key, value] = yield* f(arr[i])
        const oentry = MutableHashMap.get(queueMap, key)
        const queue = Option.isSome(oentry)
          ? oentry.value
          : yield* Effect.scoped(RcMap.get(queues, key))
        yield* RcMap.touch(queues, key)
        yield* Queue.offer(queue, value)
      }
    }),
    options
  ))

/**
 * Groups elements by a key and emits a stream per key.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const grouped = yield* Stream.make(1, 2, 3, 4, 5).pipe(
 *     Stream.groupByKey((n) => n % 2 === 0 ? "even" : "odd"),
 *     Stream.mapEffect(
 *       ([key, stream]) =>
 *         Stream.runCollect(stream).pipe(
 *           Effect.map((values) => [key, values] as const)
 *         ),
 *       { concurrency: "unbounded" }
 *     ),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(grouped)
 * })
 *
 * Effect.runPromise(program)
 * // Output: [ [ "odd", [ 1, 3, 5 ] ], [ "even", [ 2, 4 ] ] ]
 * ```
 *
 * @since 2.0.0
 * @category Grouping
 */
export const groupByKey: {
  <A, K>(
    f: (a: NoInfer<A>) => K,
    options?: {
      readonly bufferSize?: number | undefined
      readonly idleTimeToLive?: Duration.Input | undefined
    }
  ): <E, R>(self: Stream<A, E, R>) => Stream<readonly [K, Stream<A>], E, R>
  <A, E, R, K>(
    self: Stream<A, E, R>,
    f: (a: NoInfer<A>) => K,
    options?: {
      readonly bufferSize?: number | undefined
      readonly idleTimeToLive?: Duration.Input | undefined
    }
  ): Stream<readonly [K, Stream<A>], E, R>
} = dual((args) => isStream(args[0]), <A, E, R, K>(
  self: Stream<A, E, R>,
  f: (a: NoInfer<A>) => K,
  options?: {
    readonly bufferSize?: number | undefined
    readonly idleTimeToLive?: Duration.Input | undefined
  }
): Stream<readonly [K, Stream<A>], E, R> =>
  suspend(() => {
    const batch = MutableHashMap.empty<K, Arr.NonEmptyArray<A>>()
    return groupByImpl(
      self,
      Effect.fnUntraced(function*(arr, queues, queueMap) {
        for (let i = 0; i < arr.length; i++) {
          const key = f(arr[i])
          const ovalues = MutableHashMap.get(batch, key)
          if (Option.isNone(ovalues)) {
            MutableHashMap.set(batch, key, [arr[i]])
          } else {
            ovalues.value.push(arr[i])
          }
        }
        for (const [key, values] of batch) {
          const oentry = MutableHashMap.get(queueMap, key)
          const queue = Option.isSome(oentry)
            ? oentry.value
            : yield* Effect.scoped(RcMap.get(queues, key))
          yield* RcMap.touch(queues, key)
          yield* Queue.offerAll(queue, values)
        }
        MutableHashMap.clear(batch)
      }),
      options
    )
  }))

const groupByImpl = <A, E, R, K, V, E2, R2>(
  self: Stream<A, E, R>,
  f: (
    arr: Arr.NonEmptyReadonlyArray<A>,
    queues: RcMap.RcMap<K, Queue.Queue<V, Cause.Done>>,
    queueMap: MutableHashMap.MutableHashMap<K, Queue.Queue<V, Cause.Done>>
  ) => Effect.Effect<void, E2, R2>,
  options?: {
    readonly bufferSize?: number | undefined
    readonly idleTimeToLive?: Duration.Input | undefined
  }
): Stream<readonly [K, Stream<V>], E | E2, R | R2> =>
  transformPullBracket(
    self,
    Effect.fnUntraced(function*(pull, scope, forkedScope) {
      const out = yield* Queue.unbounded<readonly [K, Stream<V>], E | E2 | Cause.Done<void>>()
      yield* Scope.addFinalizer(scope, Queue.shutdown(out))

      const queueMap = MutableHashMap.empty<K, Queue.Queue<V, Cause.Done>>()
      const queues = yield* RcMap.make({
        lookup: (key: K) =>
          Effect.acquireRelease(
            Queue.make<V, Cause.Done>({ capacity: options?.bufferSize ?? 4096 }).pipe(
              Effect.tap((queue) => {
                MutableHashMap.set(queueMap, key, queue)
                return Queue.offer(out, [key, fromQueue(queue)])
              })
            ),
            (queue) => {
              MutableHashMap.remove(queueMap, key)
              return Queue.end(queue)
            }
          ),
        idleTimeToLive: options?.idleTimeToLive ?? Duration.infinity
      }).pipe(Scope.provide(forkedScope))

      yield* Effect.whileLoop({
        while: constTrue,
        body: constant(Effect.flatMap(pull, (arr) => f(arr, queues, queueMap))),
        step: constVoid
      }).pipe(
        Effect.catchCause((cause) => Queue.failCause(out, cause)),
        Effect.forkIn(scope)
      )

      return Queue.takeAll(out)
    })
  )

/**
 * @since 2.0.0
 * @category Grouping
 */
export const groupAdjacentBy: {
  <A, K>(
    f: (a: NoInfer<A>) => K
  ): <E, R>(self: Stream<A, E, R>) => Stream<readonly [K, Arr.NonEmptyArray<A>], E, R>
  <A, E, R, K>(
    self: Stream<A, E, R>,
    f: (a: NoInfer<A>) => K
  ): Stream<readonly [K, Arr.NonEmptyArray<A>], E, R>
} = dual(2, <A, E, R, K>(
  self: Stream<A, E, R>,
  f: (a: NoInfer<A>) => K
): Stream<readonly [K, Arr.NonEmptyArray<A>], E, R> =>
  transformPull(self, (pull, _scope) =>
    Effect.sync(() => {
      let currentKey: K = undefined as any
      let group: Arr.NonEmptyArray<A> | undefined
      let toEmit = Arr.empty<readonly [K, Arr.NonEmptyArray<A>]>()
      const loop: Pull.Pull<
        Arr.NonEmptyReadonlyArray<readonly [K, Arr.NonEmptyArray<A>]>,
        E
      > = pull.pipe(
        Effect.flatMap((chunk) => {
          for (let i = 0; i < chunk.length; i++) {
            const item = chunk[i]
            const key = f(item)
            if (group === undefined) {
              currentKey = key
              group = [item]
              continue
            } else if (Equal.equals(key, currentKey)) {
              group.push(item)
              continue
            }
            toEmit.push([currentKey, group])
            currentKey = key
            group = [item]
          }
          if (Arr.isArrayNonEmpty(toEmit)) {
            const out = toEmit
            toEmit = []
            return Effect.succeed(out)
          }
          return loop
        })
      )
      let done = false
      return Pull.catchDone(Effect.suspend(() => done ? Cause.done() : loop), () => {
        done = true
        const out = group
        group = undefined
        return out && Arr.isArrayNonEmpty(out) ? Effect.succeed(Arr.of([currentKey, out])) : Cause.done()
      })
    })))

/**
 * Applies a sink transducer to the stream and emits each sink result.
 *
 * @example
 * ```ts
 * import { Console, Effect, Sink, Stream } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const result = yield* Stream.make(1, 2, 3, 4).pipe(
 *     Stream.transduce(Sink.take(2)),
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(result)
 *   // Output: [ [ 1, 2 ], [ 3, 4 ] ]
 * })
 * ```
 *
 * @since 2.0.0
 * @category Aggregation
 */
export const transduce = dual<
  <A2, A, E2, R2>(
    sink: Sink.Sink<A2, A, A, E2, R2>
  ) => <E, R>(self: Stream<A, E, R>) => Stream<A2, E2 | E, R2 | R>,
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    sink: Sink.Sink<A2, A, A, E2, R2>
  ) => Stream<A2, E2 | E, R2 | R>
>(
  2,
  <A, E, R, A2, E2, R2>(
    self: Stream<A, E, R>,
    sink: Sink.Sink<A2, A, A, E2, R2>
  ): Stream<A2, E2 | E, R2 | R> =>
    transformPull(self, (upstream, scope) =>
      Effect.sync(() => {
        let done: Exit.Exit<never, Cause.Done<void> | E> | undefined
        let leftover: Arr.NonEmptyReadonlyArray<A> | undefined
        const upstreamWithLeftover = Effect.suspend(() => {
          if (leftover !== undefined) {
            const chunk = leftover
            leftover = undefined
            return Effect.succeed(chunk)
          }
          return upstream
        }).pipe(
          Effect.catch((error) => {
            done = Exit.fail(error)
            return Cause.done()
          })
        )
        const pull = Effect.map(
          Effect.suspend(() => sink.transform(upstreamWithLeftover, scope)),
          ([value, leftover_]) => {
            leftover = leftover_
            return Arr.of(value)
          }
        )
        return Effect.suspend((): Pull.Pull<
          Arr.NonEmptyReadonlyArray<A2>,
          E | E2,
          void,
          R2
        > => done ? done : pull)
      }))
)

/**
 * Aggregates elements using the provided sink and emits each sink result as a stream element.
 *
 * The stream runs the upstream and downstream in separate fibers, so the sink can keep
 * consuming input while downstream is busy processing the previous output.
 *
 * @example
 * ```ts
 * import { Console, Effect, Sink, Stream } from "effect"
 *
 * Effect.runPromise(Effect.gen(function* () {
 *   const aggregated = yield* Stream.runCollect(
 *     Stream.make(1, 2, 3, 4, 5, 6).pipe(
 *       Stream.aggregate(
 *         Sink.foldUntil(() => 0, 3, (sum, n) => Effect.succeed(sum + n))
 *       )
 *     )
 *   )
 *   yield* Console.log(aggregated)
 * }))
 * // [ 6, 15 ]
 * ```
 *
 * @since 2.0.0
 * @category Aggregation
 */
export const aggregate: {
  <B, A, A2, E2, R2>(
    sink: Sink.Sink<B, A | A2, A2, E2, R2>
  ): <E, R>(self: Stream<A, E, R>) => Stream<B, E2 | E, R2 | R>
  <A, E, R, B, A2, E2, R2>(
    self: Stream<A, E, R>,
    sink: Sink.Sink<B, A | A2, A2, E2, R2>
  ): Stream<B, E | E2, R | R2>
} = dual(2, <A, E, R, B, A2, E2, R2>(
  self: Stream<A, E, R>,
  sink: Sink.Sink<B, A | A2, A2, E2, R2>
): Stream<B, E | E2, R | R2> => aggregateWithin(self, sink, Schedule.forever))

/**
 * Aggregates elements with a sink, emitting each result when the sink completes or the schedule triggers.
 *
 * The schedule can flush the current aggregation even if the sink has not finished.
 *
 * @example
 * ```ts
 * import { Console, Effect, Schedule, Sink, Stream } from "effect"
 *
 * Effect.runPromise(Effect.gen(function* () {
 *   const aggregated = yield* Stream.runCollect(
 *     Stream.make(1, 2, 3, 4, 5, 6).pipe(
 *       Stream.aggregateWithin(
 *         Sink.foldUntil(() => 0, 3, (sum, n) => Effect.succeed(sum + n)),
 *         Schedule.spaced("1 minute")
 *       )
 *     )
 *   )
 *   yield* Console.log(aggregated)
 * }))
 * // Output: [ 6, 15 ]
 * ```
 *
 * @since 2.0.0
 * @category Aggregation
 */
export const aggregateWithin: {
  <B, A, A2, E2, R2, C, E3, R3>(
    sink: Sink.Sink<B, A | A2, A2, E2, R2>,
    schedule: Schedule.Schedule<C, Option.Option<B>, E3, R3>
  ): <E, R>(self: Stream<A, E, R>) => Stream<B, E2 | E | E3, R2 | R3 | R>
  <A, E, R, B, A2, E2, R2, C, E3, R3>(
    self: Stream<A, E, R>,
    sink: Sink.Sink<B, A | A2, A2, E2, R2>,
    schedule: Schedule.Schedule<C, Option.Option<B>, E3, R3>
  ): Stream<B, E | E2 | E3, R | R2 | R3>
} = dual(3, <A, E, R, B, A2, E2, R2, C, E3, R3>(
  self: Stream<A, E, R>,
  sink: Sink.Sink<B, A | A2, A2, E2, R2>,
  schedule: Schedule.Schedule<C, Option.Option<B>, E3, R3>
): Stream<B, E | E2 | E3, R | R2 | R3> =>
  fromChannel(Channel.fromTransformBracket(Effect.fnUntraced(function*(_upstream, _, scope) {
    const pull = yield* Channel.toPullScoped(self.channel, _)

    const pullLatch = Latch.makeUnsafe(false)
    const scheduleStep = Symbol()
    const buffer = yield* Queue.make<Arr.NonEmptyReadonlyArray<A> | typeof scheduleStep, E | Cause.Done<void>>({
      capacity: 0
    })

    // upstream -> buffer
    yield* pull.pipe(
      pullLatch.whenOpen,
      Effect.flatMap((arr) => {
        pullLatch.closeUnsafe()
        return Queue.offer(buffer, arr)
      }),
      Effect.forever, // don't disable autoYield to prevent choking the schedule
      Effect.catchCause((cause) => Queue.failCause(buffer, cause)),
      Effect.forkIn(scope)
    )

    // schedule -> buffer
    let lastOutput = Option.none<B>()
    let leftover: Arr.NonEmptyReadonlyArray<A2> | undefined
    let sinkHasInput = false
    const step = yield* Schedule.toStepWithSleep(schedule)
    const stepToBuffer = Effect.suspend(function loop(): Pull.Pull<never, E3, void, R3> {
      return step(lastOutput).pipe(
        Effect.flatMap(() => !sinkHasInput ? loop() : Queue.offer(buffer, scheduleStep)),
        Effect.flatMap(() => Effect.never),
        Pull.catchDone(() => Cause.done())
      )
    })

    // buffer -> sink
    const pullFromBuffer: Pull.Pull<
      Arr.NonEmptyReadonlyArray<A>,
      E
    > = Queue.take(buffer).pipe(
      Effect.flatMap((arr) => {
        if (arr === scheduleStep) {
          return Cause.done()
        }
        sinkHasInput = true
        return Effect.succeed(arr)
      })
    )

    const sinkUpstream = Effect.suspend((): Pull.Pull<Arr.NonEmptyReadonlyArray<A | A2>, E> => {
      if (leftover !== undefined) {
        const chunk = leftover
        leftover = undefined
        sinkHasInput = true
        return Effect.succeed(chunk)
      }
      pullLatch.openUnsafe()
      return pullFromBuffer
    })
    const catchSinkHalt = Effect.flatMap(([value, leftover_]: Sink.End<B, A2>) => {
      // ignore the last output if the upstream only pulled a halt
      if (!sinkHasInput && buffer.state._tag === "Done") return Cause.done()
      lastOutput = Option.some(value)
      leftover = leftover_
      return Effect.succeed(Arr.of(value))
    })

    return Effect.suspend(() => {
      // if the buffer has exited and there is no more data to process
      if (buffer.state._tag === "Done" && leftover === undefined) {
        return buffer.state.exit as Exit.Exit<never, Cause.Done<void> | E>
      }
      sinkHasInput = leftover !== undefined
      return Effect.succeed(Effect.suspend(() => sink.transform(sinkUpstream as any, scope)))
    }).pipe(
      Effect.flatMap((pull) => Effect.raceFirst(catchSinkHalt(pull), stepToBuffer))
    )
  }))))

/**
 * Creates a PubSub-backed stream that multicasts the source to all subscribers.
 *
 * The returned stream is scoped and uses the provided PubSub capacity and replay settings.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.scoped(
 *   Effect.gen(function* () {
 *     const broadcasted = yield* Stream.broadcast(Stream.fromArray([1, 2, 3]), {
 *       capacity: 8,
 *       replay: 3
 *     })
 *
 *     const [left, right] = yield* Effect.all([
 *       Stream.runCollect(broadcasted),
 *       Stream.runCollect(broadcasted)
 *     ], { concurrency: "unbounded" })
 *
 *     yield* Console.log([left, right])
 *   })
 * )
 *
 * Effect.runPromise(program)
 * // Output: [[1, 2, 3], [1, 2, 3]]
 * ```
 *
 * @since 2.0.0
 * @category Broadcast
 */
export const broadcast: {
  (
    options: {
      readonly capacity: "unbounded"
      readonly replay?: number | undefined
    } | {
      readonly capacity: number
      readonly strategy?: "sliding" | "dropping" | "suspend" | undefined
      readonly replay?: number | undefined
    }
  ): <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<Stream<A, E>, never, Scope.Scope | R>
  <A, E, R>(
    self: Stream<A, E, R>,
    options: {
      readonly capacity: "unbounded"
      readonly replay?: number | undefined
    } | {
      readonly capacity: number
      readonly strategy?: "sliding" | "dropping" | "suspend" | undefined
      readonly replay?: number | undefined
    }
  ): Effect.Effect<Stream<A, E>, never, Scope.Scope | R>
} = dual(2, <A, E, R>(
  self: Stream<A, E, R>,
  options: {
    readonly capacity: "unbounded"
    readonly replay?: number | undefined
  } | {
    readonly capacity: number
    readonly strategy?: "sliding" | "dropping" | "suspend" | undefined
    readonly replay?: number | undefined
  }
): Effect.Effect<Stream<A, E>, never, Scope.Scope | R> => Effect.map(toPubSubTake(self, options), fromPubSubTake))

/**
 * Returns a new Stream that multicasts the original stream, subscribing when the first consumer starts.
 *
 * The upstream continues running while there is at least one consumer and is finalized after the last one exits.
 * If `idleTimeToLive` is set, the upstream is kept alive for that duration so a later subscriber can continue from
 * the next element instead of restarting.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * Effect.runPromise(
 *   Effect.scoped(
 *     Effect.gen(function*() {
 *       const shared = yield* Stream.make(1, 2, 3).pipe(
 *         Stream.share({ capacity: 16 })
 *       )
 *
 *       const first = yield* shared.pipe(Stream.take(1), Stream.runCollect)
 *       const second = yield* shared.pipe(Stream.take(1), Stream.runCollect)
 *
 *       yield* Console.log([first, second])
 *     })
 *   )
 * )
 * // output: [[1], [1]]
 * ```
 *
 * @since 2.0.0
 * @category Broadcast
 */
export const share: {
  (
    options: {
      readonly capacity: "unbounded"
      readonly replay?: number | undefined
      readonly idleTimeToLive?: Duration.Input | undefined
    } | {
      readonly capacity: number
      readonly strategy?: "sliding" | "dropping" | "suspend" | undefined
      readonly replay?: number | undefined
      readonly idleTimeToLive?: Duration.Input | undefined
    }
  ): <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<Stream<A, E>, never, Scope.Scope | R>
  <A, E, R>(
    self: Stream<A, E, R>,
    options: {
      readonly capacity: "unbounded"
      readonly replay?: number | undefined
      readonly idleTimeToLive?: Duration.Input | undefined
    } | {
      readonly capacity: number
      readonly strategy?: "sliding" | "dropping" | "suspend" | undefined
      readonly replay?: number | undefined
      readonly idleTimeToLive?: Duration.Input | undefined
    }
  ): Effect.Effect<Stream<A, E>, never, Scope.Scope | R>
} = dual(2, <A, E, R>(
  self: Stream<A, E, R>,
  options: {
    readonly capacity: "unbounded"
    readonly replay?: number | undefined
    readonly idleTimeToLive?: Duration.Input | undefined
  } | {
    readonly capacity: number
    readonly strategy?: "sliding" | "dropping" | "suspend" | undefined
    readonly replay?: number | undefined
    readonly idleTimeToLive?: Duration.Input | undefined
  }
): Effect.Effect<Stream<A, E>, never, Scope.Scope | R> =>
  Effect.map(
    RcRef.make({
      acquire: broadcast(self, options),
      idleTimeToLive: options.idleTimeToLive
    }),
    (ref) => unwrap(RcRef.get(ref))
  ))

/**
 * Pipes this stream through a channel that consumes and emits chunked elements.
 *
 * The channel receives `NonEmptyReadonlyArray` chunks and can transform both the
 * output elements and error type.
 *
 * @example
 * ```ts
 * import { Array, Channel, Console, Effect, Stream } from "effect"
 *
 * type NumberChunk = readonly [number, ...Array<number>]
 *
 * const doubleChunks = Channel.identity<NumberChunk, never, unknown>().pipe(
 *   Channel.map((chunk) => Array.map(chunk, (n) => n * 2))
 * )
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.fromArray([1, 2, 3]).pipe(
 *     Stream.rechunk(2),
 *     Stream.pipeThroughChannel(doubleChunks),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // => [2, 4, 6]
 * ```
 *
 * @since 2.0.0
 * @category Pipe
 */
export const pipeThroughChannel: {
  <R2, E, E2, A, A2>(
    channel: Channel.Channel<Arr.NonEmptyReadonlyArray<A2>, E2, unknown, Arr.NonEmptyReadonlyArray<A>, E, unknown, R2>
  ): <R>(self: Stream<A, E, R>) => Stream<A2, E2, R2 | R>
  <R, R2, E, E2, A, A2>(
    self: Stream<A, E, R>,
    channel: Channel.Channel<Arr.NonEmptyReadonlyArray<A2>, E2, unknown, Arr.NonEmptyReadonlyArray<A>, E, unknown, R2>
  ): Stream<A2, E2, R | R2>
} = dual(2, <R, R2, E, E2, A, A2>(
  self: Stream<A, E, R>,
  channel: Channel.Channel<Arr.NonEmptyReadonlyArray<A2>, E2, unknown, Arr.NonEmptyReadonlyArray<A>, E, unknown, R2>
): Stream<A2, E2, R | R2> => fromChannel(Channel.pipeTo(self.channel, channel)))

/**
 * Pipes values through the provided channel while preserving this stream's
 * failures alongside any channel failures.
 *
 * Upstream failures are not passed to the channel, so the resulting stream can
 * fail with either the original stream error or the channel error.
 *
 * @example
 * ```ts
 * import type { Channel } from "effect"
 * import { Console, Effect, Stream } from "effect"
 *
 * declare const transformChannel: Channel.Channel<
 *   readonly [string, ...Array<string>],
 *   "ChannelError",
 *   unknown,
 *   readonly [number, ...Array<number>],
 *   "StreamError",
 *   unknown,
 *   never
 * >
 *
 * Effect.runPromise(Effect.gen(function*() {
 *   const result = yield* Stream.make(1, 2, 3).pipe(
 *     Stream.pipeThroughChannelOrFail(transformChannel),
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(result)
 * }))
 * // Output:
 * // ["1", "2", "3"]
 * ```
 *
 * @since 2.0.0
 * @category Pipe
 */
export const pipeThroughChannelOrFail: {
  <R2, E, E2, A, A2>(
    channel: Channel.Channel<Arr.NonEmptyReadonlyArray<A2>, E2, unknown, Arr.NonEmptyReadonlyArray<A>, E, unknown, R2>
  ): <R>(self: Stream<A, E, R>) => Stream<A2, E | E2, R2 | R>
  <R, R2, E, E2, A, A2>(
    self: Stream<A, E, R>,
    channel: Channel.Channel<Arr.NonEmptyReadonlyArray<A2>, E2, unknown, Arr.NonEmptyReadonlyArray<A>, E, unknown, R2>
  ): Stream<A2, E | E2, R | R2>
} = dual(2, <R, R2, E, E2, A, A2>(
  self: Stream<A, E, R>,
  channel: Channel.Channel<Arr.NonEmptyReadonlyArray<A2>, E2, unknown, Arr.NonEmptyReadonlyArray<A>, E, unknown, R2>
): Stream<A2, E | E2, R | R2> => fromChannel(Channel.pipeToOrFail(self.channel, channel)))

/**
 * Pipes the stream through `Sink.toChannel`, emitting only the sink leftovers.
 *
 * If the sink completes mid-chunk, the remaining elements become the output stream.
 *
 * @example
 * ```ts
 * import { Console, Effect, Sink, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const leftovers = yield* Stream.make(1, 2, 3, 4).pipe(
 *     Stream.pipeThrough(Sink.take(2)),
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(leftovers)
 * })
 *
 * Effect.runPromise(program)
 * //=> [ 3, 4 ]
 * ```
 *
 * @since 2.0.0
 * @category Pipe
 */
export const pipeThrough: {
  <A2, A, L, E2, R2>(sink: Sink.Sink<A2, A, L, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<L, E2 | E, R2 | R>
  <A, E, R, A2, L, E2, R2>(self: Stream<A, E, R>, sink: Sink.Sink<A2, A, L, E2, R2>): Stream<L, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, A2, L, E2, R2>(self: Stream<A, E, R>, sink: Sink.Sink<A2, A, L, E2, R2>): Stream<L, E | E2, R | R2> =>
    self.channel.pipe(
      Channel.pipeToOrFail(Sink.toChannel(sink)),
      Channel.concatWith(([_, leftover]) => leftover ? Channel.succeed(leftover) : Channel.empty),
      fromChannel
    )
)

/**
 * Collects all elements into an array and emits it as a single element.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3)
 *
 * const program = Effect.gen(function*() {
 *   const collected = yield* stream.pipe(Stream.collect, Stream.runCollect)
 *   yield* Console.log(collected[0])
 * })
 *
 * Effect.runPromise(program)
 * // [1, 2, 3]
 * ```
 *
 * @since 2.0.0
 * @category Accumulation
 */
export const collect = <A, E, R>(self: Stream<A, E, R>): Stream<Array<A>, E, R> => fromEffect(runCollect(self))

/**
 * Accumulates elements into a growing array, emitting the cumulative array for each input chunk.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const accumulated = yield* Stream.runCollect(
 *     Stream.fromArray([1, 2, 3]).pipe(
 *       Stream.rechunk(1),
 *       Stream.accumulate
 *     )
 *   )
 *   yield* Console.log(accumulated)
 * })
 *
 * Effect.runPromise(program)
 * //=> { _id: 'Chunk', values: [ [ 1 ], [ 1, 2 ], [ 1, 2, 3 ] ] }
 * ```
 *
 * @since 2.0.0
 * @category Accumulation
 */
export const accumulate = <A, E, R>(self: Stream<A, E, R>): Stream<Arr.NonEmptyArray<A>, E, R> =>
  mapAccumArray(self, Arr.empty<A>, (acc, as) => {
    const combined = Arr.appendAll(acc, as)
    return [combined, [combined]]
  })

/**
 * Emits only elements that differ from the previous one.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.fromIterable([1, 1, 2, 2, 3]).pipe(
 *     Stream.changes,
 *     Stream.runCollect
 *   )
 *
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // [1, 2, 3]
 * ```
 *
 * @since 2.0.0
 * @category Deduplication
 */
export const changes = <A, E, R>(self: Stream<A, E, R>): Stream<A, E, R> => changesWith(self, Equal.equals)

/**
 * Returns a stream that only emits elements that are not equal to the previously emitted element, as determined by the specified predicate.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make("A", "a", "B", "b", "b").pipe(
 *   Stream.changesWith((left, right) => left.toLowerCase() === right.toLowerCase())
 * )
 *
 * Effect.runPromise(
 *   Effect.gen(function*() {
 *     const values = yield* Stream.runCollect(stream)
 *     yield* Console.log(values)
 *   })
 * )
 * // ["A", "B"]
 * ```
 *
 * @since 2.0.0
 * @category Deduplication
 */
export const changesWith: {
  <A>(f: (x: A, y: A) => boolean): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>
  <A, E, R>(self: Stream<A, E, R>, f: (x: A, y: A) => boolean): Stream<A, E, R>
} = dual(
  2,
  <A, E, R>(self: Stream<A, E, R>, f: (x: A, y: A) => boolean): Stream<A, E, R> =>
    transformPull(self, (pull, _scope) =>
      Effect.sync(() => {
        let first = true
        let last: A
        return Effect.flatMap(pull, function loop(arr): Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E> {
          const out: Array<A> = []
          let i = 0
          if (first) {
            first = false
            last = arr[0]
            i = 1
            out.push(last)
          }
          for (; i < arr.length; i++) {
            const a = arr[i]
            if (f(a, last)) continue
            last = a
            out.push(a)
          }
          return Arr.isArrayNonEmpty(out) ? Effect.succeed(out) : Effect.flatMap(pull, loop)
        })
      }))
)

/**
 * Emits only elements that differ from the previous element, using an effectful equality check.
 *
 * The predicate runs for each element after the first; returning `true` treats it as equal and skips it.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.make(1, 1, 2, 2, 3, 3).pipe(
 *     Stream.changesWithEffect((a, b) => Effect.succeed(a === b))
 *   )
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // { _id: "Chunk", values: [ 1, 2, 3 ] }
 * ```
 *
 * @since 2.0.0
 * @category Deduplication
 */
export const changesWithEffect: {
  <A, E2, R2>(
    f: (x: A, y: A) => Effect.Effect<boolean, E2, R2>
  ): <E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R | R2>
  <A, E, R, E2, R2>(
    self: Stream<A, E, R>,
    f: (x: A, y: A) => Effect.Effect<boolean, E2, R2>
  ): Stream<A, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, E2, R2>(
    self: Stream<A, E, R>,
    f: (x: A, y: A) => Effect.Effect<boolean, E2, R2>
  ): Stream<A, E | E2, R | R2> =>
    transformPull(self, (pull, _scope) =>
      Effect.sync(() => {
        let first = true
        let last: A
        return Effect.flatMap(
          pull,
          Effect.fnUntraced(function* loop(arr): Generator<
            Pull.Pull<any, E | E2, void, R2>,
            Arr.NonEmptyReadonlyArray<A>,
            any
          > {
            const out: Array<A> = []
            let i = 0
            if (first) {
              first = false
              last = arr[0]
              i = 1
              out.push(last)
            }
            for (; i < arr.length; i++) {
              const a = arr[i]
              if (yield* f(a, last)) continue
              last = a
              out.push(a)
            }
            return Arr.isArrayNonEmpty(out) ? out : yield* Effect.flatMap(pull, Effect.fnUntraced(loop))
          })
        )
      }))
)

/**
 * Decodes Uint8Array chunks into strings using TextDecoder with an optional encoding.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const encoder = new TextEncoder()
 * const stream = Stream.make(
 *   encoder.encode("Hello"),
 *   encoder.encode(" World")
 * )
 *
 * const program = Effect.gen(function*() {
 *   const decoded = yield* stream.pipe(
 *     Stream.decodeText,
 *     Stream.runCollect
 *   )
 *   yield* Console.log(decoded)
 * })
 *
 * Effect.runPromise(program)
 * // ["Hello", " World"]
 * ```
 *
 * @since 2.0.0
 * @category Encoding
 */
export const decodeText: <
  Arg extends Stream<Uint8Array, any, any> | {
    readonly encoding?: string | undefined
  } | undefined = {
    readonly encoding?: string | undefined
  }
>(
  streamOrOptions?: Arg,
  options?: {
    readonly encoding?: string | undefined
  } | undefined
) => [Arg] extends [Stream<Uint8Array, infer _E, infer _R>] ? Stream<string, _E, _R>
  : <E, R>(self: Stream<Uint8Array, E, R>) => Stream<string, E, R> = dual(
    (args) => isStream(args[0]),
    <E, R>(self: Stream<Uint8Array, E, R>, options?: {
      readonly encoding?: string | undefined
    }): Stream<string, E, R> =>
      suspend(() => {
        const decoder = new TextDecoder(options?.encoding)
        return map(self, (chunk) => decoder.decode(chunk, { stream: true }))
      })
  )

/**
 * Encodes a stream of strings into UTF-8 `Uint8Array` chunks.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make("Hello", " ", "World")
 * const program = Effect.gen(function*() {
 *   const encoded = Stream.encodeText(stream)
 *   const chunks = yield* Stream.runCollect(encoded)
 *   const bytes = chunks.map((chunk) => [...chunk])
 *   yield* Console.log(bytes)
 * })
 *
 * Effect.runPromise(program)
 * // [[72, 101, 108, 108, 111], [32], [87, 111, 114, 108, 100]]
 * ```
 *
 * @since 2.0.0
 * @category Encoding
 */
export const encodeText = <E, R>(self: Stream<string, E, R>): Stream<Uint8Array, E, R> =>
  suspend(() => {
    const encoder = new TextEncoder()
    return map(self, (chunk) => encoder.encode(chunk))
  })

/**
 * Splits a stream of strings into lines, handling `\n`, `\r`, and `\r\n` delimiters across chunks.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * Effect.runPromise(Effect.gen(function* () {
 *   const lines = yield* Stream.runCollect(
 *     Stream.make("a\nb\r\n", "c\n").pipe(Stream.splitLines)
 *   )
 *   yield* Console.log(lines)
 * }))
 * // ["a", "b", "c"]
 * ```
 *
 * @since 2.0.0
 * @category Encoding
 */
export const splitLines = <E, R>(self: Stream<string, E, R>): Stream<string, E, R> =>
  self.channel.pipe(
    Channel.pipeTo(Channel.splitLines()),
    fromChannel
  )

/**
 * Inserts the provided element between emitted elements.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.make(1, 2, 3, 4).pipe(Stream.intersperse(0))
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // [1, 0, 2, 0, 3, 0, 4]
 * ```
 *
 * @since 2.0.0
 * @category Sequencing
 */
export const intersperse: {
  <A2>(element: A2): <A, E, R>(self: Stream<A, E, R>) => Stream<A2 | A, E, R>
  <A, E, R, A2>(self: Stream<A, E, R>, element: A2): Stream<A | A2, E, R>
} = dual(2, <A, E, R, A2>(self: Stream<A, E, R>, element: A2): Stream<A | A2, E, R> =>
  mapArray(self, (arr, i) => {
    const out: Arr.NonEmptyArray<A | A2> = i === 0 ? [] as any : [element]
    const lastIndex = arr.length - 1
    for (let j = 0; j < arr.length; j++) {
      if (j === lastIndex) {
        out.push(arr[j])
      } else {
        out.push(arr[j], element)
      }
    }
    return out
  }))

/**
 * Intersperse stream elements with a middle value, adding a start and end value.
 *
 * The start and end values are always emitted, even when the stream is empty.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make("a", "b", "c").pipe(
 *   Stream.intersperseAffixes({ start: "[", middle: ",", end: "]" })
 * )
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // [ "[", "a", ",", "b", ",", "c", "]" ]
 * ```
 *
 * @since 2.0.0
 * @category Sequencing
 */
export const intersperseAffixes: {
  <A2, A3, A4>(
    options: { readonly start: A2; readonly middle: A3; readonly end: A4 }
  ): <A, E, R>(self: Stream<A, E, R>) => Stream<A2 | A3 | A4 | A, E, R>
  <A, E, R, A2, A3, A4>(
    self: Stream<A, E, R>,
    options: { readonly start: A2; readonly middle: A3; readonly end: A4 }
  ): Stream<A | A2 | A3 | A4, E, R>
} = dual(2, <A, E, R, A2, A3, A4>(
  self: Stream<A, E, R>,
  options: { readonly start: A2; readonly middle: A3; readonly end: A4 }
): Stream<A | A2 | A3 | A4, E, R> =>
  succeed(options.start).pipe(
    concat(intersperse(self, options.middle)),
    concat(succeed(options.end))
  ))

/**
 * Interleaves this stream with the specified stream by alternating pulls from
 * each stream; when one ends, the remaining values from the other stream are
 * emitted.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.interleave(
 *   Stream.make(2, 3),
 *   Stream.make(5, 6, 7)
 * )
 *
 * const program = Effect.gen(function*() {
 *   const collected = yield* Stream.runCollect(stream)
 *   yield* Console.log(collected)
 * })
 *
 * Effect.runPromise(program)
 * // [2, 5, 3, 6, 7]
 * ```
 * @since 2.0.0
 * @category Merging
 */
export const interleave: {
  <A2, E2, R2>(that: Stream<A2, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A2 | A, E2 | E, R2 | R>
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<A | A2, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<A | A2, E | E2, R | R2> =>
    interleaveWith(
      self,
      that,
      fromIterable(Iterable.forever([true, false]))
    )
)

/**
 * Interleaves two streams deterministically by following a boolean decider stream.
 *
 * The decider controls how many elements are pulled; if one side ends, pulls for
 * that side are ignored.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const left = Stream.make(1, 3, 5)
 *   const right = Stream.make(2, 4, 6)
 *   const decider = Stream.make(true, false, false, true, true)
 *
 *   const values = yield* Stream.runCollect(
 *     Stream.interleaveWith(left, right, decider)
 *   )
 *
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // [ 1, 2, 4, 3, 5 ]
 * ```
 *
 * @since 2.0.0
 * @category Merging
 */
export const interleaveWith: {
  <A2, E2, R2, E3, R3>(
    that: Stream<A2, E2, R2>,
    decider: Stream<boolean, E3, R3>
  ): <A, E, R>(self: Stream<A, E, R>) => Stream<A2 | A, E2 | E3 | E, R2 | R3 | R>
  <A, E, R, A2, E2, R2, E3, R3>(
    self: Stream<A, E, R>,
    that: Stream<A2, E2, R2>,
    decider: Stream<boolean, E3, R3>
  ): Stream<A | A2, E | E2 | E3, R | R2 | R3>
} = dual(3, <A, E, R, A2, E2, R2, E3, R3>(
  self: Stream<A, E, R>,
  that: Stream<A2, E2, R2>,
  decider: Stream<boolean, E3, R3>
): Stream<A | A2, E | E2 | E3, R | R2 | R3> =>
  fromChannel(Channel.fromTransform(Effect.fnUntraced(function*(upstream, scope) {
    const pullDecider = yield* Channel.toTransform(Channel.flattenArray(decider.channel))(upstream, scope)
    const retry = Symbol()
    type retry = typeof retry
    let leftDone = false
    let rightDone = false
    const pullLeft = (yield* Channel.toTransform(Channel.flattenArray(self.channel))(
      upstream,
      scope
    )).pipe(
      Pull.catchDone(() => {
        leftDone = true
        return Effect.succeed<retry>(retry)
      })
    )
    const pullRight = (yield* Channel.toTransform(Channel.flattenArray(that.channel))(
      upstream,
      scope
    )).pipe(
      Pull.catchDone(() => {
        rightDone = true
        return Effect.succeed<retry>(retry)
      })
    )

    return Effect.gen(function*() {
      while (true) {
        if (leftDone && rightDone) {
          return yield* Cause.done()
        }
        const side = yield* pullDecider
        if (side && leftDone) continue
        if (!side && rightDone) continue
        const elem = yield* (side ? pullLeft : pullRight)
        if (elem === retry) continue
        return Arr.of(elem)
      }
    })
  }))))

/**
 * Interrupts the evaluation of this stream when the provided effect
 * completes. The given effect will be forked as part of this stream, and its
 * success will be discarded. This combinator will also interrupt any
 * in-progress element being pulled from upstream.
 *
 * If the effect completes with a failure before the stream completes, the
 * returned stream will emit that failure.
 *
 * @example
 * ```ts
 * import { Console, Deferred, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const interrupt = yield* Deferred.make<void>()
 *   const stream = Stream.make(1, 2, 3).pipe(
 *     Stream.tap((value) =>
 *       value === 2
 *         ? Deferred.succeed(interrupt, void 0)
 *         : Effect.void
 *     ),
 *     Stream.interruptWhen(Deferred.await(interrupt))
 *   )
 *
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // => [1, 2]
 * ```
 *
 * @since 2.0.0
 * @category Interruption
 */
export const interruptWhen: {
  <X, E2, R2>(effect: Effect.Effect<X, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>
  <A, E, R, X, E2, R2>(self: Stream<A, E, R>, effect: Effect.Effect<X, E2, R2>): Stream<A, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, X, E2, R2>(self: Stream<A, E, R>, effect: Effect.Effect<X, E2, R2>): Stream<A, E | E2, R | R2> =>
    fromChannel(Channel.interruptWhen(self.channel, effect))
)

/**
 * Halts evaluation after the current element once the provided effect completes; the effect is forked, its success is discarded, failures fail the stream, and it does not interrupt an in-progress pull (use `interruptWhen` for that).
 *
 * @example
 * ```ts
 * import { Console, Deferred, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const halt = yield* Deferred.make<void>()
 *   const values = yield* Stream.fromArray([1, 2, 3]).pipe(
 *     Stream.tap((value) => value === 2 ? Deferred.succeed(halt, void 0) : Effect.void),
 *     Stream.haltWhen(Deferred.await(halt)),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // [1, 2]
 * ```
 *
 * @since 2.0.0
 * @category Interruption
 */
export const haltWhen: {
  <X, E2, R2>(effect: Effect.Effect<X, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>
  <A, E, R, X, E2, R2>(self: Stream<A, E, R>, effect: Effect.Effect<X, E2, R2>): Stream<A, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, X, E2, R2>(self: Stream<A, E, R>, effect: Effect.Effect<X, E2, R2>): Stream<A, E | E2, R | R2> =>
    fromChannel(Channel.haltWhen(self.channel, effect))
)

/**
 * Runs the provided finalizer when the stream exits, passing the exit value.
 *
 * @example
 * ```ts
 * import { Console, Effect, Exit, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3).pipe(
 *   Stream.onExit((exit) =>
 *     Exit.isSuccess(exit)
 *       ? Console.log("Stream completed successfully")
 *       : Console.log("Stream failed")
 *   )
 * )
 *
 * Effect.runPromise(Effect.gen(function*() {
 *   yield* Stream.runCollect(stream)
 * }))
 * // Output:
 * // Stream completed successfully
 * ```
 *
 * @since 4.0.0
 * @category Finalization
 */
export const onExit: {
  <E, R2>(
    finalizer: (exit: Exit.Exit<unknown, E>) => Effect.Effect<unknown, never, R2>
  ): <A, R>(self: Stream<A, E, R>) => Stream<A, E, R | R2>
  <A, E, R, R2>(
    self: Stream<A, E, R>,
    finalizer: (exit: Exit.Exit<unknown, E>) => Effect.Effect<unknown, never, R2>
  ): Stream<A, E, R | R2>
} = dual(2, <A, E, R, R2>(
  self: Stream<A, E, R>,
  finalizer: (exit: Exit.Exit<unknown, E>) => Effect.Effect<unknown, never, R2>
): Stream<A, E, R | R2> => fromChannel(Channel.onExit(self.channel, finalizer)))

/**
 * Runs the provided effect when the stream fails, passing the failure cause.
 *
 * Note: Unlike `Effect.onError` there is no guarantee that the provided
 * effect will not be interrupted.
 *
 * @example
 * ```ts
 * import { Cause, Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.make(1, 2, 3).pipe(
 *     Stream.concat(Stream.fail("boom")),
 *     Stream.onError((cause) => Console.log(`Stream failed: ${Cause.squash(cause)}`))
 *   )
 *
 *   yield* Stream.runCollect(stream)
 * })
 *
 * Effect.runPromiseExit(program)
 * // Output:
 * // Stream failed: boom
 * ```
 *
 * @since 2.0.0
 * @category Error Handling
 */
export const onError: {
  <E, X, R2>(
    cleanup: (cause: Cause.Cause<E>) => Effect.Effect<X, never, R2>
  ): <A, R>(self: Stream<A, E, R>) => Stream<A, E, R2 | R>
  <A, E, R, X, R2>(
    self: Stream<A, E, R>,
    cleanup: (cause: Cause.Cause<E>) => Effect.Effect<X, never, R2>
  ): Stream<A, E, R | R2>
} = dual(2, <A, E, R, X, R2>(
  self: Stream<A, E, R>,
  cleanup: (cause: Cause.Cause<E>) => Effect.Effect<X, never, R2>
): Stream<A, E, R | R2> => fromChannel(Channel.onError(self.channel, cleanup)))

/**
 * Runs the provided effect before this stream starts.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.fromArray([1, 2, 3]).pipe(
 *     Stream.onStart(Console.log("Stream started"))
 *   )
 *
 *   const values = yield* Stream.runCollect(stream)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // Stream started
 * // [1, 2, 3]
 * ```
 *
 * @since 4.0.0
 * @category Sequencing
 */
export const onStart: {
  <X, EX, RX>(
    onStart: Effect.Effect<X, EX, RX>
  ): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | EX, R | RX>
  <A, E, R, X, EX, RX>(
    self: Stream<A, E, R>,
    onStart: Effect.Effect<X, EX, RX>
  ): Stream<A, E | EX, R | RX>
} = dual(2, <A, E, R, X, EX, RX>(
  self: Stream<A, E, R>,
  onStart: Effect.Effect<X, EX, RX>
): Stream<A, E | EX, R | RX> => fromChannel(Channel.onStart(self.channel, onStart)))

/**
 * Runs the provided effect with the first element emitted by the stream.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * Effect.runPromise(Effect.gen(function* () {
 *   yield* Stream.fromArray([1, 2, 3]).pipe(
 *     Stream.onFirst((value) => Console.log(`first=${value}`)),
 *     Stream.runDrain
 *   )
 * }))
 * // Output: first=1
 * ```
 *
 * @since 4.0.0
 * @category Sequencing
 */
export const onFirst: {
  <A, X, EX, RX>(
    onFirst: (element: NoInfer<A>) => Effect.Effect<X, EX, RX>
  ): <E, R>(self: Stream<A, E, R>) => Stream<A, E | EX, R | RX>
  <A, E, R, X, EX, RX>(
    self: Stream<A, E, R>,
    onFirst: (element: NoInfer<A>) => Effect.Effect<X, EX, RX>
  ): Stream<A, E | EX, R | RX>
} = dual(2, <A, E, R, X, EX, RX>(
  self: Stream<A, E, R>,
  onFirst: (element: NoInfer<A>) => Effect.Effect<X, EX, RX>
): Stream<A, E | EX, R | RX> => fromChannel(Channel.onFirst(self.channel, (arr) => onFirst(arr[0]))))

/**
 * Runs the provided effect when the stream ends successfully.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.make(1, 2, 3).pipe(
 *     Stream.onEnd(Console.log("Stream ended")),
 *     Stream.runCollect
 *   )
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * // Stream ended
 * // [1, 2, 3]
 * ```
 *
 * @since 4.0.0
 * @category Sequencing
 */
export const onEnd: {
  <X, EX, RX>(
    onEnd: Effect.Effect<X, EX, RX>
  ): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | EX, R | RX>
  <A, E, R, X, EX, RX>(
    self: Stream<A, E, R>,
    onEnd: Effect.Effect<X, EX, RX>
  ): Stream<A, E | EX, R | RX>
} = dual(2, <A, E, R, X, EX, RX>(
  self: Stream<A, E, R>,
  onEnd: Effect.Effect<X, EX, RX>
): Stream<A, E | EX, R | RX> => fromChannel(Channel.onEnd(self.channel, onEnd)))

/**
 * Executes the provided finalizer after this stream's finalizers run.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.fromArray([1, 2]).pipe(
 *   Stream.ensuring(Effect.orDie(Console.log("cleanup")))
 * )
 *
 * const program = Effect.gen(function*() {
 *   const collected = yield* Stream.runCollect(stream)
 *   yield* Console.log(collected)
 * })
 *
 * Effect.runPromise(program)
 * //=> cleanup
 * //=> [1, 2]
 * ```
 *
 * @since 4.0.0
 * @category Finalization
 */
export const ensuring: {
  <R2>(finalizer: Effect.Effect<unknown, never, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R | R2>
  <A, E, R, R2>(self: Stream<A, E, R>, finalizer: Effect.Effect<unknown, never, R2>): Stream<A, E, R | R2>
} = dual(
  2,
  <A, E, R, R2>(self: Stream<A, E, R>, finalizer: Effect.Effect<unknown, never, R2>): Stream<A, E, R | R2> =>
    fromChannel(Channel.ensuring(self.channel, finalizer))
)

/**
 * Provides a layer or context to the stream, removing the corresponding
 * service requirements. Use `options.local` to build the layer every time; by
 * default, layers are shared between provide calls.
 *
 * **Previously Known As:** `provideSomeLayer`, `provideSomeContext`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Layer, Context, Stream } from "effect"
 *
 * class Env extends Context.Service<Env, { readonly name: string }>()("Env") {}
 *
 * const layer = Layer.succeed(Env)({ name: "Ada" })
 *
 * const stream = Stream.fromEffect(
 *   Effect.gen(function*() {
 *     const env = yield* Effect.service(Env)
 *     return `Hello, ${env.name}`
 *   })
 * )
 *
 * const withEnv = stream.pipe(Stream.provide(layer))
 *
 * const program = Stream.runCollect(withEnv).pipe(
 *   Effect.flatMap((values) => Console.log(values))
 * )
 *
 * Effect.runPromise(program)
 * // Output:
 * // ["Hello, Ada"]
 * ```
 *
 * @since 4.0.0
 * @category Services
 */
export const provide: {
  <AL, EL = never, RL = never>(
    layer: Layer.Layer<AL, EL, RL> | Context.Context<AL>,
    options?: {
      readonly local?: boolean | undefined
    } | undefined
  ): <A, E, R>(
    self: Stream<A, E, R>
  ) => Stream<A, E | EL, Exclude<R, AL> | RL>
  <A, E, R, AL, EL = never, RL = never>(
    self: Stream<A, E, R>,
    layer: Layer.Layer<AL, EL, RL> | Context.Context<AL>,
    options?: {
      readonly local?: boolean | undefined
    } | undefined
  ): Stream<A, E | EL, Exclude<R, AL> | RL>
} = dual((args) => isStream(args[0]), <A, E, R, AL, EL = never, RL = never>(
  self: Stream<A, E, R>,
  layer: Layer.Layer<AL, EL, RL> | Context.Context<AL>,
  options?: {
    readonly local?: boolean | undefined
  } | undefined
): Stream<A, E | EL, Exclude<R, AL> | RL> => fromChannel(Channel.provide(self.channel, layer, options)))

/**
 * Provides multiple services to the stream using a context.
 *
 * @example
 * ```ts
 * import { Console, Effect, Context, Stream } from "effect"
 *
 * class Config extends Context.Service<Config, { readonly prefix: string }>()("Config") {}
 * class Greeter extends Context.Service<Greeter, { greet: (name: string) => string }>()("Greeter") {}
 *
 * const context = Context.make(Config, { prefix: "Hello" }).pipe(
 *   Context.add(Greeter, { greet: (name: string) => `${name}!` })
 * )
 *
 * const stream = Stream.fromEffect(
 *   Effect.gen(function*() {
 *     const config = yield* Effect.service(Config)
 *     const greeter = yield* Effect.service(Greeter)
 *     return greeter.greet(config.prefix)
 *   })
 * )
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(Stream.provideContext(stream, context))
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // ["Hello!"]
 * ```
 *
 * @since 4.0.0
 * @category Services
 */
export const provideContext: {
  <R2>(context: Context.Context<R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, Exclude<R, R2>>
  <A, E, R, R2>(self: Stream<A, E, R>, context: Context.Context<R2>): Stream<A, E, Exclude<R, R2>>
} = dual(
  2,
  <A, E, R, R2>(self: Stream<A, E, R>, context: Context.Context<R2>): Stream<A, E, Exclude<R, R2>> =>
    fromChannel(Channel.provideContext(self.channel, context))
)

/**
 * Provides the stream with a single required service, eliminating that
 * requirement from its environment.
 *
 * @example
 * ```ts
 * import { Console, Effect, Context, Stream } from "effect"
 *
 * class Greeter extends Context.Service<Greeter, {
 *   greet: (name: string) => string
 * }>()("Greeter") {}
 *
 * const stream = Stream.fromEffect(
 *   Effect.service(Greeter).pipe(
 *     Effect.map((greeter) => greeter.greet("Ada"))
 *   )
 * )
 *
 * const program = Effect.gen(function*() {
 *   const collected = yield* Stream.runCollect(
 *     stream.pipe(
 *       Stream.provideService(Greeter, {
 *         greet: (name) => `Hello, ${name}`
 *       })
 *     )
 *   )
 *   yield* Console.log(collected)
 * })
 *
 * Effect.runPromise(program)
 * //=> ["Hello, Ada"]
 * ```
 *
 * @since 4.0.0
 * @category Services
 */
export const provideService: {
  <I, S>(
    key: Context.Key<I, S>,
    service: NoInfer<S>
  ): <A, E, R>(
    self: Stream<A, E, R>
  ) => Stream<A, E, Exclude<R, I>>
  <A, E, R, I, S>(
    self: Stream<A, E, R>,
    key: Context.Key<I, S>,
    service: NoInfer<S>
  ): Stream<A, E, Exclude<R, I>>
} = dual(3, <A, E, R, I, S>(
  self: Stream<A, E, R>,
  key: Context.Key<I, S>,
  service: NoInfer<S>
): Stream<A, E, Exclude<R, I>> => fromChannel(Channel.provideService(self.channel, key, service)))

/**
 * Provides a service to the stream using an effect, removing the requirement and adding the effect's error and environment.
 *
 * @example
 * ```ts
 * import { Console, Effect, Context, Stream } from "effect"
 *
 * class ApiConfig extends Context.Service<ApiConfig, { readonly baseUrl: string }>()("ApiConfig") {}
 *
 * const stream = Stream.fromEffect(
 *   Effect.gen(function*() {
 *     const config = yield* Effect.service(ApiConfig)
 *     return config.baseUrl
 *   })
 * )
 *
 * const withConfig = stream.pipe(
 *   Stream.provideServiceEffect(
 *     ApiConfig,
 *     Effect.succeed({ baseUrl: "https://example.com" }).pipe(
 *       Effect.tap(() => Console.log("Loading config..."))
 *     )
 *   )
 * )
 *
 * const program = Stream.runCollect(withConfig).pipe(
 *   Effect.flatMap((values) => Console.log(values))
 * )
 *
 * Effect.runPromise(program)
 * // Output:
 * // Loading config...
 * // ["https://example.com"]
 * ```
 *
 * @since 4.0.0
 * @category Services
 */
export const provideServiceEffect: {
  <I, S, ES, RS>(
    key: Context.Key<I, S>,
    service: Effect.Effect<NoInfer<S>, ES, RS>
  ): <A, E, R>(
    self: Stream<A, E, R>
  ) => Stream<A, E | ES, Exclude<R, I> | RS>
  <A, E, R, I, S, ES, RS>(
    self: Stream<A, E, R>,
    key: Context.Key<I, S>,
    service: Effect.Effect<NoInfer<S>, ES, RS>
  ): Stream<A, E | ES, Exclude<R, I> | RS>
} = dual(3, <A, E, R, I, S, ES, RS>(
  self: Stream<A, E, R>,
  key: Context.Key<I, S>,
  service: Effect.Effect<NoInfer<S>, ES, RS>
): Stream<A, E | ES, Exclude<R, I> | RS> => fromChannel(Channel.provideServiceEffect(self.channel, key, service)))

/**
 * Transforms the stream's required services by mapping the current context
 * to a new one.
 *
 * @example
 * ```ts
 * import { Console, Effect, Context, Stream } from "effect"
 *
 * class Logger extends Context.Service<Logger, { prefix: string }>()("Logger") {}
 * class Config extends Context.Service<Config, { name: string }>()("Config") {}
 *
 * const stream = Stream.fromEffect(
 *   Effect.gen(function*() {
 *     const logger = yield* Effect.service(Logger)
 *     const config = yield* Effect.service(Config)
 *     return `${logger.prefix}${config.name}`
 *   })
 * )
 *
 * const updated = stream.pipe(
 *   Stream.updateContext((context: Context.Context<Logger>) =>
 *     Context.add(context, Config, { name: "World" })
 *   )
 * )
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Stream.runCollect(updated)
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(
 *   Effect.provideService(program, Logger, { prefix: "Hello " })
 * )
 * //=> [ "Hello World" ]
 * ```
 *
 * @since 2.0.0
 * @category Services
 */
export const updateContext: {
  <R, R2>(
    f: (context: Context.Context<R2>) => Context.Context<R>
  ): <A, E>(
    self: Stream<A, E, R>
  ) => Stream<A, E, R2>
  <A, E, R, R2>(
    self: Stream<A, E, R>,
    f: (context: Context.Context<R2>) => Context.Context<R>
  ): Stream<A, E, R2>
} = dual(2, <A, E, R, R2>(
  self: Stream<A, E, R>,
  f: (context: Context.Context<R2>) => Context.Context<R>
): Stream<A, E, R2> => fromChannel(Channel.updateContext(self.channel, f)))

/**
 * Updates a single service in the stream environment by applying a function.
 *
 * @example
 * ```ts
 * import { Console, Effect, Context, Stream } from "effect"
 *
 * class Counter extends Context.Service<Counter, { count: number }>()("Counter") {}
 *
 * const stream = Stream.fromEffect(Effect.service(Counter)).pipe(
 *   Stream.updateService(Counter, (counter) => ({ count: counter.count + 1 }))
 * )
 *
 * const program = Effect.gen(function*() {
 *   const counters = yield* Stream.runCollect(stream)
 *   yield* Console.log(`Updated count: ${counters[0].count}`)
 * })
 *
 * Effect.runPromise(Effect.provideService(program, Counter, { count: 0 }))
 * // Output: Updated count: 1
 * ```
 *
 * @since 2.0.0
 * @category Services
 */
export const updateService: {
  <I, S>(
    key: Context.Key<I, S>,
    f: (service: NoInfer<S>) => S
  ): <A, E, R>(
    self: Stream<A, E, R>
  ) => Stream<A, E, R | I>
  <A, E, R, I, S>(
    self: Stream<A, E, R>,
    key: Context.Key<I, S>,
    f: (service: NoInfer<S>) => S
  ): Stream<A, E, R | I>
} = dual(3, <A, E, R, I, S>(
  self: Stream<A, E, R>,
  service: Context.Key<I, S>,
  f: (service: NoInfer<S>) => S
): Stream<A, E, R | I> =>
  updateContext(self, (context) =>
    Context.add(
      context,
      service,
      f(Context.get(context, service))
    )))

/**
 * Wraps the stream with a new span for tracing.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.fromArray([1, 2, 3]).pipe(Stream.withSpan("numbers"))
 *
 * Effect.runPromise(
 *   Effect.gen(function*() {
 *     const values = yield* Stream.runCollect(stream)
 *     yield* Console.log(values)
 *   })
 * )
 * // [1, 2, 3]
 * ```
 *
 * @since 4.0.0
 * @category Tracing
 */
export const withSpan: {
  (name: string, options?: SpanOptions): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, Exclude<R, ParentSpan>>
  <A, E, R>(self: Stream<A, E, R>, name: string, options?: SpanOptions): Stream<A, E, Exclude<R, ParentSpan>>
} = function() {
  const dataFirst = isStream(arguments[0])
  const name = dataFirst ? arguments[1] : arguments[0]
  const options = addSpanStackTrace(dataFirst ? arguments[2] : arguments[1])
  if (dataFirst) {
    const self = arguments[0] as Stream<any, any, any>
    return fromChannel(Channel.withSpan(self.channel, name, options))
  }
  return (self: Stream<any, any, any>) => fromChannel(Channel.withSpan(self.channel, name, options))
} as any

/**
 * Provides the entry point for do-notation style stream composition.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream, pipe } from "effect"
 *
 * const program = pipe(
 *   Stream.Do,
 *   Stream.bind("value", () => Stream.fromArray([1, 2])),
 *   Stream.let("next", ({ value }) => value + 1)
 * )
 *
 * const effect = Effect.gen(function*() {
 *   const collected = yield* Stream.runCollect(program)
 *   yield* Console.log(collected)
 * })
 *
 * Effect.runPromise(effect)
 * //=> [{ value: 1, next: 2 }, { value: 2, next: 3 }]
 * ```
 *
 * @since 4.0.0
 * @category Do Notation
 */
export const Do: Stream<{}> = succeed({})

const let_: {
  <N extends string, A extends object, B>(
    name: Exclude<N, keyof A>,
    f: (a: NoInfer<A>) => B
  ): <E, R>(self: Stream<A, E, R>) => Stream<{ [K in N | keyof A]: K extends keyof A ? A[K] : B }, E, R>
  <A extends object, E, R, N extends string, B>(
    self: Stream<A, E, R>,
    name: Exclude<N, keyof A>,
    f: (a: NoInfer<A>) => B
  ): Stream<{ [K in N | keyof A]: K extends keyof A ? A[K] : B }, E, R>
} = dual(3, <A extends object, E, R, N extends string, B>(
  self: Stream<A, E, R>,
  name: Exclude<N, keyof A>,
  f: (a: NoInfer<A>) => B
): Stream<{ [K in N | keyof A]: K extends keyof A ? A[K] : B }, E, R> =>
  map(self, (a) => ({ ...a, [name]: f(a) } as any)))
export {
  /**
   * Adds a computed field to the current Do-notation record.
   *
   * @example
   * ```ts
   * import { Console, Effect, Stream } from "effect"
   *
   * const stream = Stream.Do.pipe(
   *   Stream.let("x", () => 2),
   *   Stream.let("y", ({ x }) => x * 3)
   * )
   *
   * const program = Effect.gen(function*() {
   *   const records = yield* Stream.runCollect(stream)
   *   yield* Console.log(records)
   * })
   *
   * Effect.runPromise(program)
   * // [{ x: 2, y: 6 }]
   * ```
   *
   * @since 4.0.0
   * @category Do Notation
   */
  let_ as let
}

/**
 * Binds the result of a stream to a field in the do-notation record.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Stream.Do.pipe(
 *   Stream.bind("a", () => Stream.make(1, 2)),
 *   Stream.bind("b", ({ a }) => Stream.succeed(a + 1))
 * )
 *
 * const result = Stream.runCollect(program)
 *
 * Effect.runPromise(Effect.flatMap(result, Console.log))
 * // [{ a: 1, b: 2 }, { a: 2, b: 3 }]
 * ```
 *
 * @since 4.0.0
 * @category Do Notation
 */
export const bind: {
  <N extends string, A, B, E2, R2>(
    tag: Exclude<N, keyof A>,
    f: (_: NoInfer<A>) => Stream<B, E2, R2>,
    options?: {
      readonly concurrency?: number | "unbounded" | undefined
      readonly bufferSize?: number | undefined
    } | undefined
  ): <E, R>(self: Stream<A, E, R>) => Stream<{ [K in N | keyof A]: K extends keyof A ? A[K] : B }, E2 | E, R2 | R>
  <A, E, R, N extends string, B, E2, R2>(
    self: Stream<A, E, R>,
    tag: Exclude<N, keyof A>,
    f: (_: NoInfer<A>) => Stream<B, E2, R2>,
    options?: {
      readonly concurrency?: number | "unbounded" | undefined
      readonly bufferSize?: number | undefined
    } | undefined
  ): Stream<{ [K in N | keyof A]: K extends keyof A ? A[K] : B }, E | E2, R | R2>
} = dual((args) => isStream(args[0]), <A, E, R, N extends string, B, E2, R2>(
  self: Stream<A, E, R>,
  tag: Exclude<N, keyof A>,
  f: (_: NoInfer<A>) => Stream<B, E2, R2>,
  options?: {
    readonly concurrency?: number | "unbounded" | undefined
    readonly bufferSize?: number | undefined
  } | undefined
): Stream<{ [K in N | keyof A]: K extends keyof A ? A[K] : B }, E | E2, R | R2> =>
  flatMap(self, (a) => map(f(a), (b) => ({ ...a, [tag]: b } as any)), options))

/**
 * Binds an Effect-produced value into the do-notation record for each stream element.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.Do.pipe(
 *   Stream.bind("value", () => Stream.make(1, 2)),
 *   Stream.bindEffect("double", ({ value }) => Effect.succeed(value * 2))
 * )
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Stream.runCollect(stream)
 *   yield* Console.log(result)
 * })
 *
 * Effect.runPromise(program)
 * // [{ value: 1, double: 2 }, { value: 2, double: 4 }]
 * ```
 *
 * @since 4.0.0
 * @category Do Notation
 */
export const bindEffect: {
  <N extends string, A, B, E2, R2>(
    tag: Exclude<N, keyof A>,
    f: (_: NoInfer<A>) => Effect.Effect<B, E2, R2>,
    options?: {
      readonly concurrency?: number | "unbounded" | undefined
      readonly bufferSize?: number | undefined
      readonly unordered?: boolean | undefined
    }
  ): <E, R>(self: Stream<A, E, R>) => Stream<{ [K in keyof A | N]: K extends keyof A ? A[K] : B }, E | E2, R | R2>
  <A, E, R, N extends string, B, E2, R2>(
    self: Stream<A, E, R>,
    tag: Exclude<N, keyof A>,
    f: (_: NoInfer<A>) => Effect.Effect<B, E2, R2>,
    options?: {
      readonly concurrency?: number | "unbounded" | undefined
      readonly bufferSize?: number | undefined
      readonly unordered?: boolean | undefined
    }
  ): Stream<{ [K in keyof A | N]: K extends keyof A ? A[K] : B }, E | E2, R | R2>
} = dual((args) => isStream(args[0]), <A, E, R, N extends string, B, E2, R2>(
  self: Stream<A, E, R>,
  tag: Exclude<N, keyof A>,
  f: (_: NoInfer<A>) => Effect.Effect<B, E2, R2>,
  options?: {
    readonly concurrency?: number | "unbounded" | undefined
    readonly bufferSize?: number | undefined
    readonly unordered?: boolean | undefined
  } | undefined
): Stream<{ [K in keyof A | N]: K extends keyof A ? A[K] : B }, E | E2, R | R2> =>
  mapEffect(self, (a) => Effect.map(f(a), (b) => ({ ...a, [tag]: b } as any)), options))

/**
 * Maps each element into a record keyed by the provided name.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3).pipe(Stream.bindTo("value"))
 *
 * const program = Stream.runCollect(stream).pipe(Effect.flatMap(Console.log))
 *
 * Effect.runPromise(program)
 * // [{ value: 1 }, { value: 2 }, { value: 3 }]
 * ```
 *
 * @category Do Notation
 * @since 4.0.0
 */
export const bindTo: {
  <N extends string>(name: N): <A, E, R>(self: Stream<A, E, R>) => Stream<{ [K in N]: A }, E, R>
  <A, E, R, N extends string>(self: Stream<A, E, R>, name: N): Stream<{ [K in N]: A }, E, R>
} = dual(2, <A, E, R, N extends string>(
  self: Stream<A, E, R>,
  name: N
): Stream<{ [K in N]: A }, E, R> => map(self, (a) => ({ [name]: a } as any)))

/**
 * Runs a stream with a sink and returns the sink result.
 *
 * @example
 * ```ts
 * import { Console, Effect, Sink, Stream } from "effect"
 *
 * const program = Stream.run(Stream.make(1, 2, 3), Sink.sum)
 *
 * Effect.runPromise(Effect.flatMap(program, Console.log))
 * // 6
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const run: {
  <A2, A, L, E2, R2>(
    sink: Sink.Sink<A2, A, L, E2, R2>
  ): <E, R>(self: Stream<A, E, R>) => Effect.Effect<A2, E2 | E, R | R2>
  <A, E, R, L, A2, E2, R2>(
    self: Stream<A, E, R>,
    sink: Sink.Sink<A2, A, L, E2, R2>
  ): Effect.Effect<A2, E | E2, R | R2>
} = dual(2, <A, E, R, L, A2, E2, R2>(
  self: Stream<A, E, R>,
  sink: Sink.Sink<A2, A, L, E2, R2>
): Effect.Effect<A2, E | E2, R | R2> =>
  Effect.scopedWith((scope) =>
    Channel.toPullScoped(self.channel, scope).pipe(
      Effect.flatMap((upstream) => sink.transform(upstream as any, scope)),
      Effect.map(([a]) => a)
    )
  ))

/**
 * Runs the stream and collects all elements into an array.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3, 4, 5)
 *
 * const program = Effect.gen(function*() {
 *   const collected = yield* Stream.runCollect(stream)
 *   yield* Console.log(collected)
 * })
 *
 * Effect.runPromise(program)
 * // [1, 2, 3, 4, 5]
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const runCollect = <A, E, R>(self: Stream<A, E, R>): Effect.Effect<Array<A>, E, R> =>
  Channel.runFold(
    self.channel,
    () => [] as Array<A>,
    (acc, chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        acc.push(chunk[i])
      }
      return acc
    }
  )

/**
 * Runs the stream and returns the number of elements emitted.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3, 4, 5)
 *
 * const program = Effect.gen(function* () {
 *   const count = yield* Stream.runCount(stream)
 *   yield* Console.log(count)
 * })
 *
 * Effect.runPromise(program)
 * // 5
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const runCount = <A, E, R>(self: Stream<A, E, R>): Effect.Effect<number, E, R> =>
  Channel.runFold(self.channel, () => 0, (acc, chunk) => acc + chunk.length)

/**
 * Runs the stream and returns the numeric sum of its elements.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const total = yield* Stream.runSum(Stream.make(1, 2, 3))
 *   yield* Console.log(total)
 * })
 *
 * Effect.runPromise(program)
 * // 6
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const runSum = <E, R>(self: Stream<number, E, R>): Effect.Effect<number, E, R> =>
  Channel.runFold(self.channel, () => 0, (acc, chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      acc += chunk[i]
    }
    return acc
  })

/**
 * Runs the stream and folds elements using a pure reducer.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const total = yield* Stream.runFold(
 *     Stream.make(1, 2, 3),
 *     () => 0,
 *     (acc, n) => acc + n
 *   )
 *   yield* Console.log(total)
 * })
 *
 * Effect.runPromise(program)
 * // 6
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const runFold: {
  <Z, A>(
    initial: LazyArg<Z>,
    f: (acc: Z, a: A) => Z
  ): <E, R>(
    self: Stream<A, E, R>
  ) => Effect.Effect<Z, E, R>
  <A, E, R, Z>(
    self: Stream<A, E, R>,
    initial: LazyArg<Z>,
    f: (acc: Z, a: A) => Z
  ): Effect.Effect<Z, E, R>
} = dual(3, <A, E, R, Z>(
  self: Stream<A, E, R>,
  initial: LazyArg<Z>,
  f: (acc: Z, a: A) => Z
): Effect.Effect<Z, E, R> =>
  Channel.runFold(self.channel, initial, (acc, arr) => {
    for (let i = 0; i < arr.length; i++) {
      acc = f(acc, arr[i])
    }
    return acc
  }))

/**
 * Runs the stream and folds elements using an effectful reducer.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const total = yield* Stream.runFoldEffect(
 *     Stream.make(1, 2, 3),
 *     () => 0,
 *     (acc, n) => Effect.succeed(acc + n)
 *   )
 *   yield* Console.log(total)
 * })
 *
 * Effect.runPromise(program)
 * // 6
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const runFoldEffect: {
  <Z, A, EX, RX>(
    initial: LazyArg<Z>,
    f: (acc: Z, a: A) => Effect.Effect<Z, EX, RX>
  ): <E, R>(
    self: Stream<A, E, R>
  ) => Effect.Effect<Z, E | EX, R | RX>
  <A, E, R, Z, EX, RX>(
    self: Stream<A, E, R>,
    initial: LazyArg<Z>,
    f: (acc: Z, a: A) => Effect.Effect<Z, EX, RX>
  ): Effect.Effect<Z, E | EX, R | RX>
} = dual(3, <A, E, R, Z, EX, RX>(
  self: Stream<A, E, R>,
  initial: LazyArg<Z>,
  f: (acc: Z, a: A) => Effect.Effect<Z, EX, RX>
): Effect.Effect<Z, E | EX, R | RX> =>
  Channel.runFoldEffect(self.channel, initial, (acc, arr) => {
    let i = 0
    let s = acc
    return Effect.map(
      Effect.whileLoop({
        while: () => i < arr.length,
        body: () => f(s, arr[i]),
        step(z) {
          s = z
          i++
        }
      }),
      () => s
    )
  }))

/**
 * Runs the stream and returns the first element as an `Option`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Option, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const head = yield* Stream.runHead(Stream.make(1, 2, 3))
 *   yield* Console.log(Option.getOrThrow(head))
 * })
 *
 * Effect.runPromise(program)
 * // 1
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const runHead = <A, E, R>(self: Stream<A, E, R>): Effect.Effect<Option.Option<A>, E, R> =>
  Effect.map(Channel.runHead(self.channel), Option.map(Arr.getUnsafe(0)))

/**
 * Runs the stream and returns the last element as an `Option`.
 *
 * @since 2.0.0
 * @category Destructors
 */
export const runLast = <A, E, R>(self: Stream<A, E, R>): Effect.Effect<Option.Option<A>, E, R> =>
  Effect.map(Channel.runLast(self.channel), Option.map(Arr.lastNonEmpty))

/**
 * Runs the provided effectful callback for each element of the stream.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3)
 *
 * const program = Effect.gen(function*() {
 *   yield* Stream.runForEach(stream, (n) => Console.log(`Processing: ${n}`))
 * })
 *
 * Effect.runPromise(program)
 * // Processing: 1
 * // Processing: 2
 * // Processing: 3
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const runForEach: {
  <A, X, E2, R2>(
    f: (a: A) => Effect.Effect<X, E2, R2>
  ): <E, R>(self: Stream<A, E, R>) => Effect.Effect<void, E2 | E, R2 | R>
  <A, E, R, X, E2, R2>(
    self: Stream<A, E, R>,
    f: (a: A) => Effect.Effect<X, E2, R2>
  ): Effect.Effect<void, E | E2, R | R2>
} = dual(2, <A, E, R, X, E2, R2>(
  self: Stream<A, E, R>,
  f: (a: A) => Effect.Effect<X, E2, R2>
): Effect.Effect<void, E | E2, R | R2> =>
  Channel.runForEach(self.channel, (arr) => {
    let i = 0
    return Effect.whileLoop({
      while: () => i < arr.length,
      body: () => f(arr[i++]),
      step: constVoid
    })
  }))

/**
 * Runs the stream, applying the effectful predicate to each element and
 * stopping when it returns `false`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.make(1, 2, 3, 4, 5)
 *
 *   yield* Stream.runForEachWhile(stream, (n) =>
 *     Effect.gen(function*() {
 *       yield* Console.log(`Processing: ${n}`)
 *       return n < 3
 *     })
 *   )
 * })
 *
 * Effect.runPromise(program)
 * // Processing: 1
 * // Processing: 2
 * // Processing: 3
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const runForEachWhile: {
  <A, E2, R2>(
    f: (a: A) => Effect.Effect<boolean, E2, R2>
  ): <E, R>(self: Stream<A, E, R>) => Effect.Effect<void, E2 | E, R2 | R>
  <A, E, R, E2, R2>(
    self: Stream<A, E, R>,
    f: (a: A) => Effect.Effect<boolean, E2, R2>
  ): Effect.Effect<void, E | E2, R | R2>
} = dual(2, <A, E, R, E2, R2>(
  self: Stream<A, E, R>,
  f: (a: A) => Effect.Effect<boolean, E2, R2>
): Effect.Effect<void, E | E2, R | R2> =>
  Channel.runForEachWhile(self.channel, (arr) => {
    let done = false
    let i = 0
    return Effect.map(
      Effect.whileLoop({
        while: () => !done && i < arr.length,
        body: () => f(arr[i]),
        step(b) {
          i++
          if (!b) done = true
        }
      }),
      () => done
    )
  }))

/**
 * Consumes the stream in chunks, passing each non-empty array to the callback.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3, 4, 5)
 * const program = Effect.gen(function*() {
 *   yield* Stream.runForEachArray(
 *     stream,
 *     (chunk) => Console.log(`Processing chunk: ${chunk.join(", ")}`)
 *   )
 * })
 *
 * Effect.runPromise(program)
 * // Processing chunk: 1, 2, 3, 4, 5
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const runForEachArray: {
  <A, X, E2, R2>(
    f: (a: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<X, E2, R2>
  ): <E, R>(self: Stream<A, E, R>) => Effect.Effect<void, E2 | E, R2 | R>
  <A, E, R, X, E2, R2>(
    self: Stream<A, E, R>,
    f: (a: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<X, E2, R2>
  ): Effect.Effect<void, E | E2, R | R2>
} = dual(2, <A, E, R, X, E2, R2>(
  self: Stream<A, E, R>,
  f: (a: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<X, E2, R2>
): Effect.Effect<void, E | E2, R | R2> => Channel.runForEach(self.channel, f))

/**
 * Runs the stream for its effects, discarding emitted elements.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const stream = Stream.make(1, 2, 3).pipe(
 *     Stream.mapEffect((n) => Console.log(`Processing: ${n}`))
 *   )
 *
 *   yield* Stream.runDrain(stream)
 * })
 *
 * Effect.runPromise(program)
 * // Processing: 1
 * // Processing: 2
 * // Processing: 3
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const runDrain = <A, E, R>(self: Stream<A, E, R>): Effect.Effect<void, E, R> => Channel.runDrain(self.channel)

/**
 * Returns a scoped pull for manually consuming the stream's output chunks.
 *
 * The pull fails with `Cause.Done` when the stream ends and with the stream
 * error on failure.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3)
 *
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const pull = yield* Stream.toPull(stream)
 *     const chunk = yield* pull
 *     yield* Console.log(chunk)
 *   })
 * )
 *
 * Effect.runPromise(program)
 * // [1, 2, 3]
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const toPull = <A, E, R>(
  self: Stream<A, E, R>
): Effect.Effect<Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E>, never, R | Scope.Scope> => Channel.toPull(self.channel)

/**
 * Concatenates all emitted strings into a single string.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make("Hello", " ", "World", "!")
 * const program = Effect.gen(function*() {
 *   const text = yield* Stream.mkString(stream)
 *   yield* Console.log(text)
 * })
 *
 * Effect.runPromise(program)
 * // Hello World!
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const mkString = <E, R>(self: Stream<string, E, R>): Effect.Effect<string, E, R> =>
  Channel.runFold(
    self.channel,
    () => "",
    (acc, chunk) => acc + chunk.join("")
  )

/**
 * Concatenates the stream's `Uint8Array` chunks into a single `Uint8Array`.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(new Uint8Array([1, 2]), new Uint8Array([3, 4]))
 * const program = Effect.gen(function*() {
 *   const bytes = yield* Stream.mkUint8Array(stream)
 *   yield* Console.log([...bytes])
 * })
 *
 * Effect.runPromise(program)
 * // [1, 2, 3, 4]
 * ```
 *
 * @since 4.0.0
 * @category Destructors
 */
export const mkUint8Array = <E, R>(self: Stream<Uint8Array, E, R>): Effect.Effect<Uint8Array, E, R> =>
  Channel.runFold(
    self.channel,
    () => new Uint8Array(0),
    (acc, chunk) => {
      let chunkLength = 0
      for (let i = 0; i < chunk.length; i++) {
        chunkLength += chunk[i].length
      }
      const result = new Uint8Array(acc.length + chunkLength)
      result.set(acc, 0)
      let offset = acc.length
      for (let i = 0; i < chunk.length; i++) {
        result.set(chunk[i], offset)
        offset += chunk[i].length
      }
      return result
    }
  )

/**
 * Converts the stream to a `ReadableStream` using the provided services.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream.
 *
 * @example
 * ```ts
 * import { Context, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3, 4, 5)
 * const readableStream = Stream.toReadableStreamWith(stream, Context.empty())
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const toReadableStreamWith = dual<
  <A, XR>(
    context: Context.Context<XR>,
    options?: { readonly strategy?: QueuingStrategy<A> | undefined }
  ) => <E, R extends XR>(self: Stream<A, E, R>) => ReadableStream<A>,
  <A, E, XR, R extends XR>(
    self: Stream<A, E, R>,
    context: Context.Context<XR>,
    options?: { readonly strategy?: QueuingStrategy<A> | undefined }
  ) => ReadableStream<A>
>(
  (args) => isStream(args[0]),
  <A, E, XR, R extends XR>(
    self: Stream<A, E, R>,
    context: Context.Context<XR>,
    options?: { readonly strategy?: QueuingStrategy<A> | undefined }
  ): ReadableStream<A> => {
    let currentResolve: (() => void) | undefined = undefined
    let fiber: Fiber.Fiber<void, E> | undefined = undefined
    const latch = Latch.makeUnsafe(false)

    return new ReadableStream<A>({
      start(controller) {
        fiber = Effect.runFork(Effect.provideContext(
          runForEachArray(self, (chunk) =>
            latch.whenOpen(Effect.sync(() => {
              latch.closeUnsafe()
              for (let i = 0; i < chunk.length; i++) {
                controller.enqueue(chunk[i])
              }
              currentResolve!()
              currentResolve = undefined
            }))),
          context
        ))
        fiber.addObserver((exit) => {
          if (exit._tag === "Failure") {
            controller.error(Cause.squash(exit.cause))
          } else {
            controller.close()
          }
        })
      },
      pull() {
        return new Promise<void>((resolve) => {
          currentResolve = resolve
          latch.openUnsafe()
        })
      },
      cancel() {
        if (!fiber) return
        return Effect.runPromise(Effect.asVoid(Fiber.interrupt(fiber)))
      }
    }, options?.strategy)
  }
)

/**
 * Converts a stream to a `ReadableStream`.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream.
 *
 * @example
 * ```ts
 * import { Stream } from "effect"
 *
 * const readableStream = Stream.toReadableStream(Stream.make(1, 2, 3))
 * const reader = readableStream.getReader()
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const toReadableStream: {
  <A>(
    options?: { readonly strategy?: QueuingStrategy<A> | undefined }
  ): <E>(
    self: Stream<A, E>
  ) => ReadableStream<A>
  <A, E>(
    self: Stream<A, E>,
    options?: { readonly strategy?: QueuingStrategy<A> | undefined }
  ): ReadableStream<A>
} = dual(
  (args) => isStream(args[0]),
  <A, E>(
    self: Stream<A, E>,
    options?: { readonly strategy?: QueuingStrategy<A> | undefined }
  ): ReadableStream<A> => toReadableStreamWith(self, Context.empty(), options)
)

/**
 * Creates an Effect that builds a ReadableStream from the stream.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3, 4, 5)
 *
 * const effect = Effect.gen(function*() {
 *   const readableStream = yield* Stream.toReadableStreamEffect(stream)
 *   yield* Console.log(readableStream instanceof ReadableStream) // true
 * })
 *
 * Effect.runPromise(effect)
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const toReadableStreamEffect: {
  <A>(
    options?: { readonly strategy?: QueuingStrategy<A> | undefined }
  ): <E, R>(
    self: Stream<A, E, R>
  ) => Effect.Effect<ReadableStream<A>, never, R>
  <A, E, R>(
    self: Stream<A, E, R>,
    options?: { readonly strategy?: QueuingStrategy<A> | undefined }
  ): Effect.Effect<ReadableStream<A>, never, R>
} = dual(
  (args) => isStream(args[0]),
  <A, E, R>(
    self: Stream<A, E, R>,
    options?: { readonly strategy?: QueuingStrategy<A> | undefined }
  ): Effect.Effect<ReadableStream<A>, never, R> =>
    Effect.map(
      Effect.context<R>(),
      (context) => toReadableStreamWith(self, context, options)
    )
)

/**
 * Converts the stream to an `AsyncIterable` using the provided services.
 *
 * @example
 * ```ts
 * import { Context, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3)
 * const iterable = Stream.toAsyncIterableWith(stream, Context.empty())
 *
 * const collect = async () => {
 *   const results: Array<number> = []
 *   for await (const value of iterable) {
 *     results.push(value)
 *   }
 *   return results
 * }
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const toAsyncIterableWith: {
  <XR>(context: Context.Context<XR>): <A, E, R extends XR>(self: Stream<A, E, R>) => AsyncIterable<A>
  <A, E, XR, R extends XR>(
    self: Stream<A, E, R>,
    context: Context.Context<XR>
  ): AsyncIterable<A>
} = dual(
  2,
  <A, E, XR, R extends XR>(
    self: Stream<A, E, R>,
    context: Context.Context<XR>
  ): AsyncIterable<A> => ({
    [Symbol.asyncIterator]() {
      const runPromise = Effect.runPromiseWith(context)
      const runPromiseExit = Effect.runPromiseExitWith(context)
      const scope = Scope.makeUnsafe()
      let pull: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void, R> | undefined
      let currentIter: Iterator<A> | undefined
      return {
        async next(): Promise<IteratorResult<A>> {
          if (currentIter) {
            const next = currentIter.next()
            if (!next.done) return next
            currentIter = undefined
          }
          pull ??= await runPromise(Channel.toPullScoped(self.channel, scope))
          const exit = await runPromiseExit(pull)
          if (Exit.isSuccess(exit)) {
            currentIter = exit.value[Symbol.iterator]()
            return currentIter.next()
          } else if (Pull.isDoneCause(exit.cause)) {
            return { done: true, value: undefined }
          }
          throw Cause.squash(exit.cause)
        },
        return(_) {
          return runPromise(Effect.as(
            Scope.close(scope, Exit.void),
            { done: true, value: undefined }
          ))
        }
      }
    }
  })
)

/**
 * Creates an effect that yields an `AsyncIterable` using the current services.
 *
 * @example
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3)
 *
 * const program = Effect.gen(function*() {
 *   const iterable = yield* Stream.toAsyncIterableEffect(stream)
 *   const values = yield* Effect.promise(async () => {
 *     const collected: Array<number> = []
 *     for await (const value of iterable) {
 *       collected.push(value)
 *     }
 *     return collected
 *   })
 *   yield* Console.log(values)
 * })
 *
 * Effect.runPromise(program)
 * //=> [ 1, 2, 3 ]
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const toAsyncIterableEffect = <A, E, R>(self: Stream<A, E, R>): Effect.Effect<AsyncIterable<A>, never, R> =>
  Effect.map(
    Effect.context<R>(),
    (context) => toAsyncIterableWith(self, context)
  )

/**
 * Converts a stream to an `AsyncIterable` for `for await...of` consumption.
 *
 * @example
 * ```ts
 * import { Effect, Stream } from "effect"
 *
 * const stream = Stream.make(1, 2, 3)
 *
 * const program = Effect.gen(function* () {
 *   const iterable = Stream.toAsyncIterable(stream)
 *   const results = yield* Effect.promise(async () => {
 *     const values: Array<number> = []
 *     for await (const value of iterable) {
 *       values.push(value)
 *     }
 *     return values
 *   })
 *   return results
 * })
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const toAsyncIterable = <A, E>(self: Stream<A, E>): AsyncIterable<A> =>
  toAsyncIterableWith(self, Context.empty())

/**
 * Runs the stream, publishing elements into the provided PubSub.
 *
 * `shutdownOnEnd` controls whether the PubSub is shut down when the stream ends.
 * It only shuts down when set to `true`.
 *
 * @example
 * ```ts
 * import { Console, Effect, PubSub, Stream } from "effect"
 *
 * const program = Effect.scoped(Effect.gen(function* () {
 *   const pubsub = yield* PubSub.unbounded<number>()
 *   const subscription = yield* PubSub.subscribe(pubsub)
 *
 *   yield* Stream.runIntoPubSub(Stream.fromIterable([1, 2]), pubsub)
 *
 *   const first = yield* PubSub.take(subscription)
 *   const second = yield* PubSub.take(subscription)
 *
 *   yield* Console.log(first)
 *   yield* Console.log(second)
 * }))
 *
 * Effect.runPromise(program)
 * //=> 1
 * //=> 2
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const runIntoPubSub: {
  <A>(
    pubsub: PubSub.PubSub<A>,
    options?: {
      readonly shutdownOnEnd?: boolean | undefined
    } | undefined
  ): <E, R>(self: Stream<A, E, R>) => Effect.Effect<void, E, R>
  <A, E, R>(
    self: Stream<A, E, R>,
    pubsub: PubSub.PubSub<A>,
    options?: {
      readonly shutdownOnEnd?: boolean | undefined
    } | undefined
  ): Effect.Effect<void, never, R>
} = dual((args) => isStream(args[0]), <A, E, R>(
  self: Stream<A, E, R>,
  pubsub: PubSub.PubSub<A>,
  options?: {
    readonly shutdownOnEnd?: boolean | undefined
  } | undefined
): Effect.Effect<void, E, R> => Channel.runIntoPubSubArray(self.channel, pubsub, options))

/**
 * Converts a stream to a PubSub for concurrent consumption.
 *
 * `shutdownOnEnd` indicates whether the PubSub should be shut down when the
 * stream ends. By default this is `true`.
 *
 * @example
 * ```ts
 * import { Console, Effect, PubSub, Stream } from "effect"
 *
 * const program = Effect.scoped(Effect.gen(function* () {
 *   const pubsub = yield* Stream.fromArray([1, 2]).pipe(
 *     Stream.toPubSub({ capacity: 8 })
 *   )
 *   const subscription = yield* PubSub.subscribe(pubsub)
 *   const first = yield* PubSub.take(subscription)
 *
 *   yield* Console.log(first)
 * }))
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const toPubSub: {
  (
    options: {
      readonly capacity: "unbounded"
      readonly replay?: number | undefined
      readonly shutdownOnEnd?: boolean | undefined
    } | {
      readonly capacity: number
      readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
      readonly replay?: number | undefined
      readonly shutdownOnEnd?: boolean | undefined
    }
  ): <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<PubSub.PubSub<A>, never, R | Scope.Scope>
  <A, E, R>(
    self: Stream<A, E, R>,
    options: {
      readonly capacity: "unbounded"
      readonly replay?: number | undefined
      readonly shutdownOnEnd?: boolean | undefined
    } | {
      readonly capacity: number
      readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
      readonly replay?: number | undefined
      readonly shutdownOnEnd?: boolean | undefined
    }
  ): Effect.Effect<PubSub.PubSub<A>, never, R | Scope.Scope>
} = dual(
  2,
  <A, E, R>(
    self: Stream<A, E, R>,
    options: {
      readonly capacity: "unbounded"
      readonly replay?: number | undefined
      readonly shutdownOnEnd?: boolean | undefined
    } | {
      readonly capacity: number
      readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
      readonly replay?: number | undefined
      readonly shutdownOnEnd?: boolean | undefined
    }
  ): Effect.Effect<PubSub.PubSub<A>, never, R | Scope.Scope> => Channel.toPubSubArray(self.channel, options)
)

/**
 * Converts a stream to a PubSub for concurrent consumption.
 *
 * `Take` values include the stream's end and failure signals.
 *
 * @example
 * ```ts
 * import { Console, Effect, PubSub, Stream } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const pubsub = yield* Stream.fromArray([1, 2, 3]).pipe(
 *     Stream.toPubSubTake({ capacity: 8 })
 *   )
 *   const subscription = yield* PubSub.subscribe(pubsub)
 *   const take = yield* PubSub.take(subscription)
 *
 *   if (Array.isArray(take)) {
 *     yield* Console.log(take)
 *   }
 * })
 * ```
 *
 * @since 4.0.0
 * @category Destructors
 */
export const toPubSubTake: {
  (
    options: {
      readonly capacity: "unbounded"
      readonly replay?: number | undefined
    } | {
      readonly capacity: number
      readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
      readonly replay?: number | undefined
    }
  ): <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<PubSub.PubSub<Take.Take<A, E>>, never, R | Scope.Scope>
  <A, E, R>(
    self: Stream<A, E, R>,
    options: {
      readonly capacity: "unbounded"
      readonly replay?: number | undefined
    } | {
      readonly capacity: number
      readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
      readonly replay?: number | undefined
    }
  ): Effect.Effect<PubSub.PubSub<Take.Take<A, E>>, never, R | Scope.Scope>
} = dual(
  2,
  <A, E, R>(
    self: Stream<A, E, R>,
    options: {
      readonly capacity: "unbounded"
      readonly replay?: number | undefined
    } | {
      readonly capacity: number
      readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
      readonly replay?: number | undefined
    }
  ): Effect.Effect<PubSub.PubSub<Take.Take<A, E>>, never, R | Scope.Scope> =>
    Channel.toPubSubTake(self.channel, options)
)

/**
 * Converts a stream to a Queue for concurrent consumption.
 *
 * @example
 * ```ts
 * import { Effect, Queue, Stream } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const queue = yield* Stream.toQueue(Stream.fromIterable([1, 2, 3]), { capacity: 8 })
 *   const chunk = yield* Queue.takeBetween(queue, 1, 3)
 *   return chunk
 * })
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const toQueue: {
  (
    options: {
      readonly capacity: "unbounded"
    } | {
      readonly capacity: number
      readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
    }
  ): <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<Queue.Dequeue<A, E | Cause.Done>, never, R | Scope.Scope>
  <A, E, R>(
    self: Stream<A, E, R>,
    options: {
      readonly capacity: "unbounded"
    } | {
      readonly capacity: number
      readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
    }
  ): Effect.Effect<Queue.Dequeue<A, E | Cause.Done>, never, R | Scope.Scope>
} = dual(
  2,
  <A, E, R>(
    self: Stream<A, E, R>,
    options: {
      readonly capacity: "unbounded"
    } | {
      readonly capacity: number
      readonly strategy?: "dropping" | "sliding" | "suspend" | undefined
    }
  ): Effect.Effect<Queue.Dequeue<A, E | Cause.Done>, never, R | Scope.Scope> =>
    Channel.toQueueArray(self.channel, options)
)

/**
 * Runs the stream, offering each element to the provided queue and ending it
 * with `Cause.Done` when the stream completes.
 *
 * @example
 * ```ts
 * import { Cause, Effect, Queue, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, Cause.Done>(4)
 *
 *   yield* Effect.forkChild(
 *     Stream.runIntoQueue(Stream.fromIterable([1, 2, 3]), queue)
 *   )
 *
 *   const values = [
 *     yield* Queue.take(queue),
 *     yield* Queue.take(queue),
 *     yield* Queue.take(queue)
 *   ]
 *   const done = yield* Effect.flip(Queue.take(queue))
 *
 *   return { values, done }
 * })
 * ```
 *
 * @since 2.0.0
 * @category Destructors
 */
export const runIntoQueue: {
  <A, E>(queue: Queue.Queue<A, E | Cause.Done>): <R>(self: Stream<A, E, R>) => Effect.Effect<void, never, R>
  <A, E, R>(self: Stream<A, E, R>, queue: Queue.Queue<A, E | Cause.Done>): Effect.Effect<void, never, R>
} = dual(2, <A, E, R>(
  self: Stream<A, E, R>,
  queue: Queue.Queue<A, E | Cause.Done>
): Effect.Effect<void, never, R> => Channel.runIntoQueueArray(self.channel, queue))

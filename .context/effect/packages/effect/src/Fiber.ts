/**
 * This module provides utilities for working with `Fiber`, the fundamental unit of
 * concurrency in Effect. Fibers are lightweight, user-space threads that allow
 * multiple Effects to run concurrently with structured concurrency guarantees.
 *
 * Key characteristics of Fibers:
 * - **Lightweight**: Much lighter than OS threads, you can create millions
 * - **Structured concurrency**: Parent fibers manage child fiber lifecycles
 * - **Cancellation safety**: Proper resource cleanup when interrupted
 * - **Cooperative**: Fibers yield control at effect boundaries
 * - **Traceable**: Each fiber has an ID for debugging and monitoring
 *
 * Common patterns:
 * - **Fork and join**: Start concurrent work and wait for results
 * - **Race conditions**: Run multiple effects, take the first to complete
 * - **Supervision**: Monitor and restart failed fibers
 * - **Resource management**: Ensure proper cleanup on interruption
 *
 * @example
 * ```ts
 * import { Console, Effect, Fiber } from "effect"
 *
 * // Basic fiber operations
 * const basicExample = Effect.gen(function*() {
 *   // Fork an effect to run concurrently
 *   const fiber = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       yield* Effect.sleep("2 seconds")
 *       yield* Console.log("Background task completed")
 *       return "background result"
 *     })
 *   )
 *
 *   // Do other work while the fiber runs
 *   yield* Console.log("Doing other work...")
 *   yield* Effect.sleep("1 second")
 *
 *   // Wait for the fiber to complete
 *   const result = yield* Fiber.join(fiber)
 *   yield* Console.log(`Fiber result: ${result}`)
 * })
 *
 * // Joining multiple fibers
 * const joinExample = Effect.gen(function*() {
 *   const task1 = Effect.delay(Effect.succeed("task1"), "1 second")
 *   const task2 = Effect.delay(Effect.succeed("task2"), "2 seconds")
 *
 *   // Start both effects as fibers
 *   const fiber1 = yield* Effect.forkChild(task1)
 *   const fiber2 = yield* Effect.forkChild(task2)
 *
 *   // Wait for both to complete
 *   const result1 = yield* Fiber.join(fiber1)
 *   const result2 = yield* Fiber.join(fiber2)
 *   return [result1, result2] // ["task1", "task2"]
 * })
 *
 * // Parallel execution with structured concurrency
 * const parallelExample = Effect.gen(function*() {
 *   const tasks = [1, 2, 3, 4, 5].map((n) =>
 *     Effect.gen(function*() {
 *       yield* Effect.sleep(`${n * 100} millis`)
 *       return n * n
 *     })
 *   )
 *
 *   // Run all tasks in parallel, wait for all to complete
 *   const results = yield* Effect.all(tasks, { concurrency: "unbounded" })
 *   return results // [1, 4, 9, 16, 25]
 * })
 * ```
 *
 * @since 2.0.0
 */
import type * as Arr from "./Array.ts"
import type { Effect } from "./Effect.ts"
import type { Exit } from "./Exit.ts"
import * as effect from "./internal/effect.ts"
import { version } from "./internal/version.ts"
import type { LogLevel } from "./LogLevel.ts"
import type { Pipeable } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import type { StackFrame } from "./References.ts"
import type { Scheduler, SchedulerDispatcher } from "./Scheduler.ts"
import type { Scope } from "./Scope.ts"
import type * as ServiceMap from "./ServiceMap.ts"
import type { AnySpan } from "./Tracer.ts"
import type { Covariant } from "./Types.ts"

const TypeId = `~effect/Fiber/${version}`

/**
 * A runtime fiber is a lightweight thread that executes Effects. Fibers are
 * the unit of concurrency in Effect. They provide a way to run multiple
 * Effects concurrently while maintaining structured concurrency and
 * cancellation safety.
 *
 * @example
 * ```ts
 * import { Effect, Fiber } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Fork an effect to run in a new fiber
 *   const fiber = yield* Effect.forkChild(Effect.succeed(42))
 *
 *   // Wait for the fiber to complete and get its result
 *   const result = yield* Fiber.await(fiber)
 *   console.log(result) // Exit.succeed(42)
 *
 *   return result
 * })
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface Fiber<out A, out E = never> extends Pipeable {
  readonly [TypeId]: Fiber.Variance<A, E>

  readonly id: number
  readonly currentOpCount: number
  readonly getRef: <A>(ref: ServiceMap.Reference<A>) => A
  readonly services: ServiceMap.ServiceMap<never>
  setServices(services: ServiceMap.ServiceMap<never>): void
  readonly currentScheduler: Scheduler
  readonly currentDispatcher: SchedulerDispatcher
  readonly currentSpan?: AnySpan | undefined
  readonly currentLogLevel: LogLevel
  readonly minimumLogLevel: LogLevel
  readonly currentStackFrame?: StackFrame | undefined
  readonly maxOpsBeforeYield: number
  readonly currentPreventYield: boolean
  readonly addObserver: (cb: (exit: Exit<A, E>) => void) => () => void
  readonly interruptUnsafe: (
    fiberId?: number | undefined,
    annotations?: ServiceMap.ServiceMap<never> | undefined
  ) => void
  readonly pollUnsafe: () => Exit<A, E> | undefined
}

/**
 * The Fiber namespace contains utility types and functions for working with fibers.
 * It provides type-level utilities for fiber operations and variance encoding.
 *
 * @example
 * ```ts
 * import { Effect, Fiber } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a fiber
 *   const fiber = yield* Effect.forkChild(Effect.succeed(42))
 *
 *   // Use namespace types for variance
 *   const typedFiber: Fiber.Fiber<number, never> = fiber
 *
 *   // Access fiber properties
 *   console.log(`Fiber ID: ${fiber.id}`)
 *
 *   // Join the fiber
 *   const result = yield* Fiber.join(fiber)
 *   return result // 42
 * })
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export declare namespace Fiber {
  /**
   * Variance encoding for the Fiber type, specifying covariance in both the
   * success type `A` and the error type `E`.
   *
   * @example
   * ```ts
   * import type { Fiber } from "effect"
   *
   * // Variance allows safe subtyping
   * declare const fiber: Fiber.Fiber<number, Error>
   * const upcast: Fiber.Fiber<unknown, unknown> = fiber
   * ```
   *
   * @since 2.0.0
   * @category models
   */
  export interface Variance<out A, out E = never> {
    readonly _A: Covariant<A>
    readonly _E: Covariant<E>
  }
}

const await_: <A, E>(self: Fiber<A, E>) => Effect<Exit<A, E>> = effect.fiberAwait
export {
  /**
   * Waits for a fiber to complete and returns its exit value.
   *
   * @example
   * ```ts
   * import { Effect, Fiber } from "effect"
   *
   * const program = Effect.gen(function*() {
   *   const fiber = yield* Effect.forkChild(Effect.succeed(42))
   *   const exit = yield* Fiber.await(fiber)
   *   console.log(exit) // Exit.succeed(42)
   * })
   * ```
   *
   * @since 2.0.0
   * @category combinators
   */
  await_ as await
}
/**
 * Waits for all fibers in the provided iterable to complete and returns
 * an array of their exit values.
 *
 * @example
 * ```ts
 * import { Effect, Fiber } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fiber1 = yield* Effect.forkChild(Effect.succeed(1))
 *   const fiber2 = yield* Effect.forkChild(Effect.succeed(2))
 *   const exits = yield* Fiber.awaitAll([fiber1, fiber2])
 *   console.log(exits) // [Exit.succeed(1), Exit.succeed(2)]
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const awaitAll: <A extends Fiber<any, any>>(
  self: Iterable<A>
) => Effect<
  Array<
    Exit<
      A extends Fiber<infer _A, infer _E> ? _A : never,
      A extends Fiber<infer _A, infer _E> ? _E : never
    >
  >
> = effect.fiberAwaitAll

/**
 * Joins a fiber, blocking until it completes. If the fiber succeeds,
 * returns its value. If it fails, the error is propagated.
 *
 * @example
 * ```ts
 * import { Effect, Fiber } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fiber = yield* Effect.forkChild(Effect.succeed(42))
 *   const result = yield* Fiber.join(fiber)
 *   console.log(result) // 42
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const join: <A, E>(self: Fiber<A, E>) => Effect<A, E> = effect.fiberJoin

/**
 * @since 2.0.0
 * @category combinators
 */
export const joinAll: <A extends Iterable<Fiber<any, any>>>(
  self: A
) => Effect<
  Arr.ReadonlyArray.With<
    A,
    A extends Iterable<Fiber<infer _A, infer _E>> ? _A : never
  >,
  A extends Fiber<infer _A, infer _E> ? _E : never
> = effect.fiberJoinAll

/**
 * Interrupts a fiber, causing it to stop executing and clean up any
 * acquired resources.
 *
 * @example
 * ```ts
 * import { Effect, Fiber } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fiber = yield* Effect.forkChild(
 *     Effect.delay("1 second")(Effect.succeed(42))
 *   )
 *   yield* Fiber.interrupt(fiber)
 *   console.log("Fiber interrupted")
 * })
 * ```
 *
 * @since 2.0.0
 * @category interruption
 */
export const interrupt: <A, E>(self: Fiber<A, E>) => Effect<void> = effect.fiberInterrupt

/**
 * Interrupts a fiber with a specific fiber ID as the interruptor. This allows
 * tracking which fiber initiated the interruption.
 *
 * @example
 * ```ts
 * import { Effect, Fiber } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const targetFiber = yield* Effect.forkChild(
 *     Effect.delay("5 seconds")(Effect.succeed("task completed"))
 *   )
 *
 *   // Interrupt the fiber, specifying fiber ID 123 as the interruptor
 *   yield* Fiber.interruptAs(targetFiber, 123)
 *   console.log("Fiber interrupted by fiber #123")
 * })
 * ```
 *
 * @since 2.0.0
 * @category interruption
 */
export const interruptAs: {
  (
    fiberId: number | undefined,
    annotations?: ServiceMap.ServiceMap<never> | undefined
  ): <A, E>(self: Fiber<A, E>) => Effect<void>
  <A, E>(
    self: Fiber<A, E>,
    fiberId: number | undefined,
    annotations?: ServiceMap.ServiceMap<never> | undefined
  ): Effect<void>
} = effect.fiberInterruptAs

/**
 * Interrupts all fibers in the provided iterable, causing them to stop executing
 * and clean up any acquired resources.
 *
 * @example
 * ```ts
 * import { Console, Effect, Fiber } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create multiple long-running fibers
 *   const fiber1 = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       yield* Effect.sleep("5 seconds")
 *       yield* Console.log("Task 1 completed")
 *       return "result1"
 *     })
 *   )
 *
 *   const fiber2 = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       yield* Effect.sleep("3 seconds")
 *       yield* Console.log("Task 2 completed")
 *       return "result2"
 *     })
 *   )
 *
 *   const fiber3 = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       yield* Effect.sleep("4 seconds")
 *       yield* Console.log("Task 3 completed")
 *       return "result3"
 *     })
 *   )
 *
 *   // Wait a bit, then interrupt all fibers
 *   yield* Effect.sleep("1 second")
 *   yield* Console.log("Interrupting all fibers...")
 *   yield* Fiber.interruptAll([fiber1, fiber2, fiber3])
 *   yield* Console.log("All fibers have been interrupted")
 * })
 * ```
 *
 * @since 2.0.0
 * @category interruption
 */
export const interruptAll: <A extends Iterable<Fiber<any, any>>>(
  fibers: A
) => Effect<void> = effect.fiberInterruptAll

/**
 * Interrupts all fibers in the provided iterable using the specified fiber ID as the
 * interrupting fiber. This allows you to control which fiber is considered the source
 * of the interruption, which can be useful for debugging and tracing.
 *
 * @example
 * ```ts
 * import { Console, Effect, Fiber } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a controlling fiber
 *   const controllerFiber = yield* Effect.forkChild(Effect.succeed("controller"))
 *
 *   // Create multiple worker fibers
 *   const worker1 = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       yield* Effect.sleep("5 seconds")
 *       yield* Console.log("Worker 1 completed")
 *       return "worker1"
 *     })
 *   )
 *
 *   const worker2 = yield* Effect.forkChild(
 *     Effect.gen(function*() {
 *       yield* Effect.sleep("3 seconds")
 *       yield* Console.log("Worker 2 completed")
 *       return "worker2"
 *     })
 *   )
 *
 *   // Interrupt all workers using the controller fiber's ID
 *   yield* Effect.sleep("1 second")
 *   yield* Console.log("Interrupting workers from controller...")
 *   yield* Fiber.interruptAllAs([worker1, worker2], controllerFiber.id)
 *   yield* Console.log("All workers interrupted by controller")
 * })
 * ```
 *
 * @since 2.0.0
 * @category interruption
 */
export const interruptAllAs: {
  (fiberId: number): <A extends Iterable<Fiber<any, any>>>(fibers: A) => Effect<void>
  <A extends Iterable<Fiber<any, any>>>(fibers: A, fiberId: number): Effect<void>
} = effect.fiberInterruptAllAs

/**
 * Tests if a value is a Fiber. This is a type guard that can be used to
 * determine if an unknown value is a Fiber instance.
 *
 * @example
 * ```ts
 * import { Effect, Fiber } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a fiber
 *   const fiber = yield* Effect.forkChild(Effect.succeed(42))
 *
 *   // Test if values are fibers
 *   console.log(Fiber.isFiber(fiber)) // true
 *   console.log(Fiber.isFiber("hello")) // false
 *   console.log(Fiber.isFiber(42)) // false
 *   console.log(Fiber.isFiber(null)) // false
 *
 *   // Use as a type guard
 *   const maybeValue: unknown = fiber
 *   if (Fiber.isFiber(maybeValue)) {
 *     // TypeScript knows maybeValue is a Fiber here
 *     console.log(`Fiber ID: ${maybeValue.id}`)
 *   }
 * })
 * ```
 *
 * @since 2.0.0
 * @category guards
 */
export const isFiber = (
  u: unknown
): u is Fiber<unknown, unknown> => hasProperty(u, effect.FiberTypeId)

/**
 * Returns the current fiber if called from within a fiber context,
 * otherwise returns `undefined`.
 *
 * @example
 * ```ts
 * import { Effect, Fiber } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const current = Fiber.getCurrent()
 *   if (current) {
 *     console.log(`Current fiber ID: ${current.id}`)
 *   }
 * })
 * ```
 *
 * @since 2.0.0
 * @category accessors
 */
export const getCurrent: () => Fiber<any, any> | undefined = effect.getCurrentFiber

/**
 * Links the lifetime of a fiber to the provided scope.
 *
 * @since 4.0.0
 * @category Scope
 */
export const runIn: {
  (scope: Scope): <A, E>(self: Fiber<A, E>) => Fiber<A, E>
  <A, E>(self: Fiber<A, E>, scope: Scope): Fiber<A, E>
} = effect.fiberRunIn

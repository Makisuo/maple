/**
 * The `Clock` module provides functionality for time-based operations in Effect applications.
 * It offers precise time measurements, scheduling capabilities, and controlled time management
 * for testing scenarios.
 *
 * The Clock service is a core component of the Effect runtime, providing:
 * - Current time access in milliseconds and nanoseconds
 * - Sleep operations for delaying execution
 * - Time-based scheduling primitives
 * - Testable time control through `TestClock`
 *
 * ## Key Features
 *
 * - **Precise timing**: Access to both millisecond and nanosecond precision
 * - **Sleep operations**: Non-blocking sleep with proper interruption handling
 * - **Service integration**: Seamless integration with Effect's dependency injection
 * - **Testable**: Mock time control for deterministic testing
 * - **Resource-safe**: Automatic cleanup of time-based resources
 *
 * @example
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * // Get current time in milliseconds
 * const getCurrentTime = Clock.currentTimeMillis
 *
 * // Sleep for 1 second
 * const sleep1Second = Effect.sleep("1 seconds")
 *
 * // Measure execution time
 * const measureTime = Effect.gen(function*() {
 *   const start = yield* Clock.currentTimeMillis
 *   yield* Effect.sleep("100 millis")
 *   const end = yield* Clock.currentTimeMillis
 *   return end - start
 * })
 * ```
 *
 * @example
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * // Using Clock service directly
 * const program = Effect.gen(function*() {
 *   const clock = yield* Clock.Clock
 *   const currentTime = yield* clock.currentTimeMillis
 *   console.log(`Current time: ${currentTime}`)
 *
 *   // Sleep for 500ms
 *   yield* Effect.sleep("500 millis")
 *
 *   const afterSleep = yield* clock.currentTimeMillis
 *   console.log(`After sleep: ${afterSleep}`)
 * })
 * ```
 *
 * @since 2.0.0
 */
import type * as Duration from "./Duration.ts"
import type { Effect } from "./Effect.ts"
import * as effect from "./internal/effect.ts"
import type * as ServiceMap from "./ServiceMap.ts"

/**
 * Represents a time-based clock which provides functionality related to time
 * and scheduling.
 *
 * @example
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * const clockOperations = Effect.gen(function*() {
 *   const currentTime = yield* Clock.currentTimeMillis
 *   const currentTimeNanos = yield* Clock.currentTimeNanos
 *
 *   console.log(`Current time (ms): ${currentTime}`)
 *   console.log(`Current time (ns): ${currentTimeNanos}`)
 * })
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface Clock {
  /**
   * Unsafely returns the current time in milliseconds.
   */
  currentTimeMillisUnsafe(): number
  /**
   * Returns the current time in milliseconds.
   */
  readonly currentTimeMillis: Effect<number>
  /**
   * Unsafely returns the current time in nanoseconds.
   */
  currentTimeNanosUnsafe(): bigint
  /**
   * Returns the current time in nanoseconds.
   */
  readonly currentTimeNanos: Effect<bigint>
  /**
   * Asynchronously sleeps for the specified duration.
   */
  sleep(duration: Duration.Duration): Effect<void>
}

/**
 * A reference to the current Clock service in the environment.
 *
 * @example
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const clock = yield* Clock.Clock
 *   return clock.currentTimeMillisUnsafe()
 * })
 * ```
 *
 * @category references
 * @since 4.0.0
 */
export const Clock: ServiceMap.Reference<Clock> = effect.ClockRef

/**
 * Accesses the current Clock service and uses it to run the provided function.
 *
 * @example
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * const program = Clock.clockWith((clock) =>
 *   Effect.sync(() => {
 *     const currentTime = clock.currentTimeMillisUnsafe()
 *     console.log(`Current time: ${currentTime}`)
 *     return currentTime
 *   })
 * )
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const clockWith: <A, E, R>(f: (clock: Clock) => Effect<A, E, R>) => Effect<A, E, R> = effect.clockWith

/**
 * Returns an Effect that succeeds with the current time in milliseconds.
 *
 * @example
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const currentTime = yield* Clock.currentTimeMillis
 *   console.log(`Current time: ${currentTime}ms`)
 *   return currentTime
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const currentTimeMillis: Effect<number> = effect.currentTimeMillis

/**
 * Returns an Effect that succeeds with the current time in nanoseconds.
 *
 * @example
 * ```ts
 * import { Clock, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const currentTime = yield* Clock.currentTimeNanos
 *   console.log(`Current time: ${currentTime}ns`)
 *   return currentTime
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const currentTimeNanos: Effect<bigint> = effect.currentTimeNanos

/**
 * @since 2.0.0
 */
import * as Arr from "../Array.ts"
import * as Clock from "../Clock.ts"
import * as Data from "../Data.ts"
import * as Duration from "../Duration.ts"
import * as Effect from "../Effect.ts"
import * as Fiber from "../Fiber.ts"
import { flow } from "../Function.ts"
import * as Latch from "../Latch.ts"
import * as Layer from "../Layer.ts"
import * as Order from "../Order.ts"
import * as Semaphore from "../Semaphore.ts"

/**
 * A `TestClock` simplifies deterministically and efficiently testing effects
 * which involve the passage of time.
 *
 * Instead of waiting for actual time to pass, `sleep` and methods implemented
 * in terms of it schedule effects to take place at a given clock time. Users
 * can adjust the clock time using the `adjust` and `setTime` methods, and all
 * effects scheduled to take place on or before that time will automatically be
 * run in order.
 *
 * For example, here is how we can test `Effect.timeout` using `TestClock`:
 *
 * ```ts
 * import { Effect, Fiber, Option, pipe } from "effect"
 * import { TestClock } from "effect/testing"
 * import * as assert from "node:assert"
 *
 * Effect.gen(function*() {
 *   const fiber = yield* pipe(
 *     Effect.sleep("5 minutes"),
 *     Effect.timeout("1 minute"),
 *     Effect.forkChild
 *   )
 *   yield* TestClock.adjust("1 minute")
 *   const result = yield* Fiber.join(fiber)
 *   assert.deepStrictEqual(result, Option.none())
 * })
 * ```
 *
 * Note how we forked the fiber that `sleep` was invoked on. Calls to `sleep`
 * and methods derived from it will semantically block until the time is set to
 * on or after the time they are scheduled to run. If we didn't fork the fiber
 * on which we called sleep we would never get to set the time on the line
 * below. Thus, a useful pattern when using `TestClock` is to fork the effect
 * being tested, then adjust the clock time, and finally verify that the
 * expected effects have been performed.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   let executed = false
 *
 *   // Fork an effect that sleeps for 1 hour
 *   const fiber = yield* Effect.gen(function*() {
 *     yield* Effect.sleep("1 hour")
 *     executed = true
 *   }).pipe(Effect.forkChild)
 *
 *   // Advance the test clock by 1 hour
 *   yield* TestClock.adjust("1 hour")
 *
 *   // The effect should now be executed
 *   console.log(executed) // true
 * })
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface TestClock extends Clock.Clock {
  /**
   * Increments the current clock time by the specified duration. Any effects
   * that were scheduled to occur on or before the new time will be run in
   * order.
   */
  adjust(duration: Duration.Input): Effect.Effect<void>
  /**
   * Sets the current clock time to the specified `timestamp`. Any effects that
   * were scheduled to occur on or before the new time will be run in order.
   */
  setTime(timestamp: number): Effect.Effect<void>
  /**
   * Executes the specified effect with the live `Clock` instead of the
   * `TestClock`.
   */
  withLive<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
}

/**
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   // Create a TestClock with custom options
 *   const testClock = yield* TestClock.make({
 *     warningDelay: "5 seconds"
 *   })
 *
 *   // Access the current state
 *   const currentTime = testClock.currentTimeMillisUnsafe()
 *   console.log(currentTime) // 0 (starts at epoch)
 * })
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export declare namespace TestClock {
  /**
   * @example
   * ```ts
   * import { Effect } from "effect"
   * import { TestClock } from "effect/testing"
   *
   * const program = Effect.gen(function*() {
   *   // Create a TestClock with custom warning delay
   *   const testClock = yield* TestClock.make({
   *     warningDelay: "30 seconds"
   *   })
   *
   *   // Use the TestClock in your test
   *   yield* testClock.adjust("1 hour")
   * })
   * ```
   *
   * @since 4.0.0
   * @category models
   */
  export interface Options {
    /**
     * The amount of time to wait before displaying a warning message when a
     * test is using time but is not advancing the `TestClock`.
     */
    readonly warningDelay?: Duration.Input
  }

  /**
   * @example
   * ```ts
   * import { Effect } from "effect"
   * import { TestClock } from "effect/testing"
   *
   * const program = Effect.gen(function*() {
   *   const testClock = yield* TestClock.make()
   *
   *   // The state represents the current timestamp and scheduled sleeps
   *   const timestamp = testClock.currentTimeMillisUnsafe()
   *   console.log(timestamp) // Current test time
   *
   *   // Internal state structure: { timestamp: number, sleeps: Array<[number, Latch.Latch]> }
   * })
   * ```
   *
   * @since 4.0.0
   * @category models
   */
  export interface State {
    readonly timestamp: number
    readonly sleeps: ReadonlyArray<[number, Latch.Latch]>
  }
}

/**
 * The warning message that will be displayed if a test is using time but is
 * not advancing the `TestClock`.
 */
const warningMessage = "A test is using time, but is not advancing the test " +
  "clock, which may result in the test hanging. Use TestClock.adjust to " +
  "manually advance the time."

const defaultOptions: Required<TestClock.Options> = {
  warningDelay: "1 second"
}

const SleepOrder = Order.flip(Order.Struct({
  timestamp: Order.Number,
  sequence: Order.Number
}))

/**
 * Creates a `TestClock` with optional configuration.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   // Create a TestClock with default settings
 *   const testClock = yield* TestClock.make()
 *
 *   // Create a TestClock with custom warning delay
 *   const customTestClock = yield* TestClock.make({
 *     warningDelay: "10 seconds"
 *   })
 *
 *   // Use the TestClock to control time in tests
 *   yield* testClock.adjust("1 hour")
 *   const currentTime = testClock.currentTimeMillisUnsafe()
 *   console.log(currentTime) // Time advanced by 1 hour
 * })
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const make = Effect.fnUntraced(function*(
  options?: TestClock.Options
) {
  const config = Object.assign({}, defaultOptions, options)
  let sequence = 0
  const sleeps: Array<{
    readonly sequence: number
    readonly timestamp: number
    readonly latch: Latch.Latch
  }> = []
  const liveClock = yield* Clock.clockWith(Effect.succeed)
  const warningSemaphore = yield* Semaphore.make(1)

  let currentTimestamp: number = new Date(0).getTime()
  let warningState: WarningState = WarningState.Start()

  function currentTimeMillisUnsafe(): number {
    return currentTimestamp
  }

  function currentTimeNanosUnsafe(): bigint {
    return BigInt(currentTimestamp * 1000000)
  }

  const currentTimeMillis = Effect.sync(currentTimeMillisUnsafe)
  const currentTimeNanos = Effect.sync(currentTimeNanosUnsafe)

  function withLive<A, E, R>(effect: Effect.Effect<A, E, R>) {
    return Effect.provideService(effect, Clock.Clock, liveClock)
  }

  /**
   * Forks a fiber that will display a warning message if a test is using time
   * but is not advancing the `TestClock`.
   */
  const warningStart = warningSemaphore.withPermits(1)(
    Effect.suspend(() => {
      if (warningState._tag === "Start") {
        return Effect.logWarning(warningMessage).pipe(
          Effect.delay(config.warningDelay),
          withLive,
          Effect.forkChild,
          Effect.interruptible,
          Effect.flatMap((fiber) =>
            Effect.sync(() => {
              warningState = WarningState.Pending({ fiber })
            })
          )
        )
      }
      return Effect.void
    })
  )
  /**
   * Cancels the warning message that is displayed if a test is using time but
   * is not advancing the `TestClock`.
   */
  const warningDone = warningSemaphore.withPermits(1)(
    Effect.suspend(() => {
      switch (warningState._tag) {
        case "Pending": {
          return Fiber.interrupt(warningState.fiber).pipe(
            Effect.andThen(Effect.sync(() => {
              warningState = WarningState.Done()
            }))
          )
        }
        case "Start":
        case "Done": {
          warningState = WarningState.Done()
          return Effect.void
        }
      }
    })
  )

  const sleep = Effect.fnUntraced(function*(duration: Duration.Duration) {
    const millis = Duration.toMillis(duration)
    const end = currentTimestamp + millis
    if (end <= currentTimestamp) return
    const latch = Latch.makeUnsafe()
    sleeps.push({
      sequence: sequence++,
      timestamp: end,
      latch
    })
    sleeps.sort(SleepOrder)
    yield* warningStart
    yield* latch.await
  })

  const runSemaphore = yield* Semaphore.make(1)
  const run = Effect.fnUntraced(function*(step: (currentTimestamp: number) => number) {
    yield* Fiber.await(yield* Effect.forkScoped(Effect.yieldNow))
    const endTimestamp = step(currentTimestamp)
    while (Arr.isArrayNonEmpty(sleeps)) {
      if (Arr.lastNonEmpty(sleeps).timestamp > endTimestamp) break
      const entry = sleeps.pop()!
      currentTimestamp = entry.timestamp
      entry.latch.openUnsafe()
      yield* Effect.yieldNow
    }
    currentTimestamp = endTimestamp
  }, runSemaphore.withPermits(1))

  function adjust(duration: Duration.Input) {
    const millis = Duration.toMillis(Duration.fromInputUnsafe(duration))
    return warningDone.pipe(Effect.andThen(run((timestamp) => timestamp + millis)))
  }

  function setTime(timestamp: number) {
    return warningDone.pipe(Effect.andThen(run(() => timestamp)))
  }

  yield* Effect.addFinalizer(() => warningDone)

  return {
    currentTimeMillisUnsafe,
    currentTimeNanosUnsafe,
    currentTimeMillis,
    currentTimeNanos,
    adjust,
    setTime,
    sleep,
    withLive
  }
})

/**
 * Creates a `Layer` which constructs a `TestClock`.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * // Create a TestClock layer
 * const testClockLayer = TestClock.layer()
 *
 * // Create a TestClock layer with custom options
 * const customTestClockLayer = TestClock.layer({
 *   warningDelay: "5 seconds"
 * })
 *
 * const program = Effect.gen(function*() {
 *   // Use the layer in your program
 *   yield* TestClock.adjust("1 hour")
 * }).pipe(Effect.provide(testClockLayer))
 * ```
 *
 * @since 4.0.0
 * @category layers
 */
export const layer: (options?: TestClock.Options) => Layer.Layer<TestClock> = flow(
  make,
  Layer.effect(Clock.Clock)
) as any

/**
 * Retrieves the `TestClock` service for this test and uses it to run the
 * specified workflow.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   // Use testClockWith to access the TestClock instance
 *   const currentTime = yield* TestClock.testClockWith((testClock) =>
 *     Effect.succeed(testClock.currentTimeMillisUnsafe())
 *   )
 *
 *   // Adjust time using the TestClock instance
 *   yield* TestClock.testClockWith((testClock) => testClock.adjust("2 hours"))
 *
 *   console.log(currentTime) // Initial time
 * })
 * ```
 *
 * @since 2.0.0
 * @category utils
 */
export const testClockWith = <A, E, R>(
  f: (testClock: TestClock) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => Effect.withFiber((fiber) => f(fiber.getRef(Clock.Clock) as TestClock))

/**
 * Accesses a `TestClock` instance in the context and increments the time
 * by the specified duration, running any actions scheduled for on or before
 * the new time in order.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   let executed = false
 *
 *   // Fork an effect that sleeps for 30 minutes
 *   const fiber = yield* Effect.gen(function*() {
 *     yield* Effect.sleep("30 minutes")
 *     executed = true
 *   }).pipe(Effect.forkChild)
 *
 *   // Advance the clock by 30 minutes
 *   yield* TestClock.adjust("30 minutes")
 *
 *   // The effect should now be executed
 *   console.log(executed) // true
 * })
 * ```
 *
 * @since 2.0.0
 * @category utils
 */
export const adjust = (duration: Duration.Input): Effect.Effect<void> =>
  testClockWith((testClock) => testClock.adjust(duration))

/**
 * Sets the current clock time to the specified `timestamp`. Any effects that
 * were scheduled to occur on or before the new time will be run in order.
 *
 * @example
 * ```ts
 * import { Duration, Effect } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   let executed = false
 *
 *   // Fork an effect that sleeps for 2 hours
 *   const fiber = yield* Effect.gen(function*() {
 *     yield* Effect.sleep("2 hours")
 *     executed = true
 *   }).pipe(Effect.forkChild)
 *
 *   // Set the clock to a specific timestamp (2 hours from epoch)
 *   const targetTime = Duration.toMillis(Duration.hours(2))
 *   yield* TestClock.setTime(targetTime)
 *
 *   // The effect should now be executed
 *   console.log(executed) // true
 * })
 * ```
 *
 * @since 2.0.0
 * @category utils
 */
export const setTime = (timestamp: number): Effect.Effect<void> =>
  testClockWith((testClock) => testClock.setTime(timestamp))

/**
 * Executes the specified effect with the live `Clock` instead of the
 * `TestClock`.
 *
 * @example
 * ```ts
 * import { Clock, Effect } from "effect"
 * import { TestClock } from "effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   // Get the current test time (starts at epoch)
 *   const testTime = yield* Clock.currentTimeMillis
 *   console.log(testTime) // 0
 *
 *   // Get the actual system time using withLive
 *   const realTime = yield* TestClock.withLive(Clock.currentTimeMillis)
 *   console.log(realTime) // Actual system timestamp
 *
 *   // Advance test time
 *   yield* TestClock.adjust("1 hour")
 *
 *   // Test time is now 1 hour ahead
 *   const newTestTime = yield* Clock.currentTimeMillis
 *   console.log(newTestTime) // 3600000 (1 hour in milliseconds)
 * })
 * ```
 *
 * @since 2.0.0
 * @category utils
 */
export const withLive = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  testClockWith((testClock) => testClock.withLive(effect))

/**
 * `WarningState` describes the state of the warning message that is displayed
 * if a test is using time but is not advancing the `TestClock`.
 *
 * The possible states are:
 *   - `Start` if a test has not used time yet
 *   - `Pending` if a test has used time but has not adjusted the `TestClock`
 *   - `Done` if a test has adjusted the `TestClock` or the warning message
 *     has already been displayed.
 */
type WarningState = Data.TaggedEnum<{
  /**
   * The `WarningState` which indicates that a test has not yet used time.
   */
  readonly Start: {}
  /**
   * The `WarningState` which indicates that a test has used time but has not
   * adjusted the `TestClock`.
   *
   * The `Pending` state also includes a reference to the fiber that will
   * display the warning message.
   */
  readonly Pending: {
    readonly fiber: Fiber.Fiber<void, unknown>
  }
  /**
   * The `WarningState` which indicates that a test has used time, or that the
   * warning message has already been displayed.
   */
  readonly Done: {}
}>
const WarningState = Data.taggedEnum<WarningState>()

/**
 * @since 3.8.0
 */
import type * as Effect from "./Effect.ts"
import * as internal from "./internal/effect.ts"

/**
 * @category models
 * @since 3.8.0
 * @example
 * ```ts
 * import { Effect, Latch } from "effect"
 *
 * // Create and use a latch for coordination between fibers
 * const program = Effect.gen(function*() {
 *   const latch = yield* Latch.make()
 *
 *   // Wait for the latch to be opened
 *   yield* latch.await
 *
 *   return "Latch was opened!"
 * })
 * ```
 */
export interface Latch {
  /** open the latch, releasing all fibers waiting on it */
  readonly open: Effect.Effect<boolean>
  /** open the latch, releasing all fibers waiting on it */
  openUnsafe(this: Latch): boolean
  /** release all fibers waiting on the latch, without opening it */
  readonly release: Effect.Effect<boolean>
  /** wait for the latch to be opened */
  readonly await: Effect.Effect<void>
  /** close the latch */
  readonly close: Effect.Effect<boolean>
  /** close the latch */
  closeUnsafe(this: Latch): boolean
  /** only run the given effect when the latch is open */
  whenOpen<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
}

/**
 * Creates a new Latch unsafely.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Effect.makeLatchUnsafe`
 *
 * @example
 * ```ts
 * import { Effect, Latch } from "effect"
 *
 * const latch = Latch.makeUnsafe(false)
 *
 * const waiter = Effect.gen(function*() {
 *   yield* Effect.log("Waiting for latch to open...")
 *   yield* latch.await
 *   yield* Effect.log("Latch opened! Continuing...")
 * })
 *
 * const opener = Effect.gen(function*() {
 *   yield* Effect.sleep("2 seconds")
 *   yield* Effect.log("Opening latch...")
 *   yield* latch.open
 * })
 *
 * const program = Effect.all([waiter, opener])
 * ```
 *
 * @category constructors
 * @since 3.8.0
 */
export const makeUnsafe: (open?: boolean | undefined) => Latch = internal.makeLatchUnsafe

/**
 * Creates a new Latch.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Effect.makeLatch`
 *
 * @example
 * ```ts
 * import { Effect, Latch } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const latch = yield* Latch.make(false)
 *
 *   const waiter = Effect.gen(function*() {
 *     yield* Effect.log("Waiting for latch to open...")
 *     yield* latch.await
 *     yield* Effect.log("Latch opened! Continuing...")
 *   })
 *
 *   const opener = Effect.gen(function*() {
 *     yield* Effect.sleep("2 seconds")
 *     yield* Effect.log("Opening latch...")
 *     yield* latch.open
 *   })
 *
 *   yield* Effect.all([waiter, opener])
 * })
 * ```
 *
 * @category constructors
 * @since 3.8.0
 */
export const make: (open?: boolean | undefined) => Effect.Effect<Latch> = internal.makeLatch

/**
 * Opens the latch, releasing all fibers waiting on it.
 *
 * @category combinators
 * @since 4.0.0
 */
export const open = (self: Latch): Effect.Effect<boolean> => self.open

/**
 * Opens the latch, releasing all fibers waiting on it.
 *
 * @category unsafe
 * @since 4.0.0
 */
export const openUnsafe = (self: Latch): boolean => self.openUnsafe()

/**
 * Releases all fibers waiting on the latch, without opening it.
 *
 * @category combinators
 * @since 4.0.0
 */
export const release = (self: Latch): Effect.Effect<boolean> => self.release

const _await = (self: Latch): Effect.Effect<void> => self.await

export {
  /**
   * Waits for the latch to be opened.
   *
   * @category getters
   * @since 4.0.0
   */
  _await as await
}

/**
 * Closes the latch.
 *
 * @category combinators
 * @since 4.0.0
 */
export const close = (self: Latch): Effect.Effect<boolean> => self.close

/**
 * Closes the latch.
 *
 * @category unsafe
 * @since 4.0.0
 */
export const closeUnsafe = (self: Latch): boolean => self.closeUnsafe()

/**
 * Runs the given effect only when the latch is open.
 *
 * @category combinators
 * @since 4.0.0
 */
export const whenOpen: {
  (self: Latch): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(self: Latch, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = ((...args: Array<any>) => {
  if (args.length === 1) {
    const [self] = args
    return (effect: Effect.Effect<any, any, any>) => self.whenOpen(effect)
  }
  const [self, effect] = args
  return self.whenOpen(effect)
}) as any

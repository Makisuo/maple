/**
 * @since 2.0.0
 */
import type * as Effect from "./Effect.ts"
import type { Fiber } from "./Fiber.ts"
import { dual } from "./Function.ts"
import * as core from "./internal/core.ts"
import * as internal from "./internal/effect.ts"
import type * as Option from "./Option.ts"

/**
 * @category models
 * @since 2.0.0
 * @example
 * ```ts
 * import { Effect, Semaphore } from "effect"
 *
 * // Create and use a semaphore for controlling concurrent access
 * const program = Effect.gen(function*() {
 *   const semaphore = yield* Semaphore.make(2)
 *
 *   return yield* semaphore.withPermits(1)(
 *     Effect.succeed("Resource accessed")
 *   )
 * })
 * ```
 */
export interface Semaphore {
  /**
   * Adjusts the number of permits available in the semaphore.
   */
  resize(this: Semaphore, permits: number): Effect.Effect<void>

  /**
   * Runs an effect with the given number of permits and releases the permits
   * when the effect completes.
   *
   * **Details**
   *
   * This function acquires the specified number of permits before executing
   * the provided effect. Once the effect finishes, the permits are released.
   * If insufficient permits are available, the function will wait until they
   * are released by other tasks.
   */
  withPermits(this: Semaphore, permits: number): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

  /**
   * Runs an effect with the given number of permits and releases the permits
   * when the effect completes.
   *
   * **Details**
   *
   * This function acquires the specified number of permits before executing
   * the provided effect. Once the effect finishes, the permits are released.
   * If insufficient permits are available, the function will wait until they
   * are released by other tasks.
   */
  withPermit<A, E, R>(this: Semaphore, self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>

  /**
   * Runs an effect only if the specified number of permits are immediately
   * available.
   *
   * **Details**
   *
   * This function attempts to acquire the specified number of permits. If they
   * are available, it runs the effect and releases the permits after the effect
   * completes. If permits are not available, the effect does not execute, and
   * the result is `Option.none`.
   */
  withPermitsIfAvailable(
    this: Semaphore,
    permits: number
  ): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>

  /**
   * Acquires the specified number of permits and returns the resulting
   * available permits, suspending the task if they are not yet available.
   * Concurrent pending `take` calls are processed in a first-in, first-out manner.
   */
  take(this: Semaphore, permits: number): Effect.Effect<number>

  /**
   * Releases the specified number of permits and returns the resulting
   * available permits.
   */
  release(this: Semaphore, permits: number): Effect.Effect<number>

  /**
   * Releases all permits held by this semaphore and returns the resulting available permits.
   */
  readonly releaseAll: Effect.Effect<number>
}

/**
 * Unsafely creates a new Semaphore.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Effect.makeSemaphoreUnsafe`
 *
 * @example
 * ```ts
 * import { Effect, Semaphore } from "effect"
 *
 * const semaphore = Semaphore.makeUnsafe(3)
 *
 * const task = (id: number) =>
 *   semaphore.withPermits(1)(
 *     Effect.gen(function*() {
 *       yield* Effect.log(`Task ${id} started`)
 *       yield* Effect.sleep("1 second")
 *       yield* Effect.log(`Task ${id} completed`)
 *     })
 *   )
 *
 * // Only 3 tasks can run concurrently
 * const program = Effect.all([
 *   task(1),
 *   task(2),
 *   task(3),
 *   task(4),
 *   task(5)
 * ], { concurrency: "unbounded" })
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const makeUnsafe = (permits: number): Semaphore => new SemaphoreImpl(permits)

class SemaphoreImpl implements Semaphore {
  public waiters = new Set<() => void>()
  public taken = 0
  public permits: number

  constructor(permits: number) {
    this.permits = permits
  }

  get free() {
    return this.permits - this.taken
  }

  take(n: number): Effect.Effect<number> {
    const take: Effect.Effect<number> = internal.suspend(() => {
      if (this.free < n) {
        return internal.callback((resume) => {
          if (this.free >= n) return resume(take)
          const observer = () => {
            if (this.free < n) return
            this.waiters.delete(observer)
            resume(take)
          }
          this.waiters.add(observer)
          return internal.sync(() => {
            this.waiters.delete(observer)
          })
        })
      }
      this.taken += n
      return internal.succeed(n)
    })
    return take
  }

  updateTakenUnsafe(fiber: Fiber<any, any>, f: (n: number) => number): number {
    this.taken = f(this.taken)
    if (this.waiters.size > 0) {
      fiber.currentDispatcher.scheduleTask(() => {
        const iter = this.waiters.values()
        let item = iter.next()
        while (item.done === false && this.free > 0) {
          item.value()
          item = iter.next()
        }
      }, 0)
    }
    return this.free
  }

  updateTaken(f: (n: number) => number): Effect.Effect<number> {
    return core.withFiber((fiber) => internal.succeed(this.updateTakenUnsafe(fiber, f)))
  }

  resize(permits: number) {
    return core.withFiber((fiber) => {
      this.permits = permits
      if (this.free < 0) return internal.void
      this.updateTakenUnsafe(fiber, (taken) => taken)
      return internal.void
    })
  }

  release(n: number): Effect.Effect<number> {
    return this.updateTaken((taken) => taken - n)
  }

  get releaseAll(): Effect.Effect<number> {
    return this.updateTaken((_) => 0)
  }

  withPermits(n: number) {
    return <A, E, R>(self: Effect.Effect<A, E, R>) =>
      internal.uninterruptibleMask((restore) =>
        internal.flatMap(
          restore(this.take(n)),
          (permits) =>
            internal.onExitPrimitive(
              restore(self),
              () => {
                this.updateTakenUnsafe(internal.getCurrentFiber()!, (taken) => taken - permits)
                return undefined
              },
              true
            )
        )
      )
  }

  get withPermit(): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
    return this.withPermits(1)
  }

  withPermitsIfAvailable(n: number) {
    return <A, E, R>(self: Effect.Effect<A, E, R>) =>
      internal.uninterruptibleMask((restore) => {
        if (this.free < n) return internal.succeedNone
        this.taken += n
        return internal.onExitPrimitive(restore(internal.asSome(self)), () => {
          this.updateTakenUnsafe(internal.getCurrentFiber()!, (taken) => taken - n)
          return undefined
        }, true)
      })
  }
}

/**
 * Creates a new Semaphore.
 *
 * **Previously Known As**
 *
 * This API replaces the following from Effect 3.x:
 *
 * - `Effect.makeSemaphore`
 *
 * @example
 * ```ts
 * import { Effect, Semaphore } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const semaphore = yield* Semaphore.make(2)
 *
 *   const task = (id: number) =>
 *     semaphore.withPermits(1)(
 *       Effect.gen(function*() {
 *         yield* Effect.log(`Task ${id} acquired permit`)
 *         yield* Effect.sleep("1 second")
 *         yield* Effect.log(`Task ${id} releasing permit`)
 *       })
 *     )
 *
 *   // Run 4 tasks, but only 2 can run concurrently
 *   yield* Effect.all([task(1), task(2), task(3), task(4)])
 * })
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const make = (permits: number): Effect.Effect<Semaphore> => internal.sync(() => new SemaphoreImpl(permits))

/**
 * Adjusts the number of permits available in the semaphore.
 *
 * @since 4.0.0
 * @category combinators
 */
export const resize: {
  (permits: number): (self: Semaphore) => Effect.Effect<void>
  (self: Semaphore, permits: number): Effect.Effect<void>
} = dual(2, (self: Semaphore, permits: number) => self.resize(permits))

/**
 * Runs an effect with the given number of permits and releases the permits when
 * the effect completes.
 *
 * @since 4.0.0
 * @category combinators
 */
export const withPermits: {
  (self: Semaphore, permits: number): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(self: Semaphore, permits: number, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = ((self: Semaphore, permits: number, effect?: Effect.Effect<any, any, any>) => {
  const withPermits = self.withPermits(permits)
  return effect ? withPermits(effect) : withPermits
}) as any

/**
 * Runs an effect with a single permit and releases the permit when the effect
 * completes.
 *
 * @since 4.0.0
 * @category combinators
 */
export const withPermit: {
  (self: Semaphore): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(self: Semaphore, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = ((self: Semaphore, effect?: Effect.Effect<any, any, any>) => {
  if (!effect) return self.withPermit
  return self.withPermit(effect)
}) as any

/**
 * Runs an effect only if the specified number of permits are immediately
 * available.
 *
 * @since 4.0.0
 * @category combinators
 */
export const withPermitsIfAvailable: {
  (self: Semaphore, permits: number): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>
  <A, E, R>(
    self: Semaphore,
    permits: number,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<Option.Option<A>, E, R>
} = ((self: Semaphore, permits: number, effect?: Effect.Effect<any, any, any>) => {
  const withPermits = self.withPermitsIfAvailable(permits)
  return effect ? withPermits(effect) : withPermits
}) as any

/**
 * Acquires the specified number of permits and returns the resulting available
 * permits, suspending the task if they are not yet available.
 *
 * @since 4.0.0
 * @category combinators
 */
export const take: {
  (permits: number): (self: Semaphore) => Effect.Effect<number>
  (self: Semaphore, permits: number): Effect.Effect<number>
} = dual(2, (self: Semaphore, permits: number) => self.take(permits))

/**
 * Releases the specified number of permits and returns the resulting available
 * permits.
 *
 * @since 4.0.0
 * @category combinators
 */
export const release: {
  (permits: number): (self: Semaphore) => Effect.Effect<number>
  (self: Semaphore, permits: number): Effect.Effect<number>
} = dual(2, (self: Semaphore, permits: number) => self.release(permits))

/**
 * Releases all permits held by this semaphore and returns the resulting
 * available permits.
 *
 * @since 4.0.0
 * @category combinators
 */
export const releaseAll = (self: Semaphore): Effect.Effect<number> => self.releaseAll

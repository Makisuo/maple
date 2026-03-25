/**
 * @since 2.0.0
 */
import type * as Cause from "./Cause.ts"
import { Clock } from "./Clock.ts"
import * as Duration from "./Duration.ts"
import * as Effect from "./Effect.ts"
import type * as Exit from "./Exit.ts"
import * as Fiber from "./Fiber.ts"
import { dual, identity } from "./Function.ts"
import * as Iterable from "./Iterable.ts"
import * as Latch from "./Latch.ts"
import { type Pipeable, pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import * as Queue from "./Queue.ts"
import { UnhandledLogLevel } from "./References.ts"
import * as Scope from "./Scope.ts"
import * as Semaphore from "./Semaphore.ts"
import * as ServiceMap from "./ServiceMap.ts"

const TypeId = "~effect/Pool"

/**
 * A `Pool<A, E>` is a pool of items of type `A`, each of which may be
 * associated with the acquisition and release of resources. An attempt to get
 * an item `A` from a pool may fail with an error of type `E`.
 *
 * @since 2.0.0
 * @category models
 */
export interface Pool<in out A, in out E = never> extends Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly config: Config<A, E>
  readonly state: State<A, E>
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Config<A, E> {
  readonly acquire: Effect.Effect<A, E, Scope.Scope>
  readonly concurrency: number
  readonly minSize: number
  readonly maxSize: number
  readonly strategy: Strategy<A, E>
  readonly targetUtilization: number
}

/**
 * @since 4.0.0
 * @category models
 */
export interface State<A, E> {
  readonly scope: Scope.Scope
  isShuttingDown: boolean
  readonly semaphore: Semaphore.Semaphore
  readonly resizeSemaphore: Semaphore.Semaphore
  readonly items: Set<PoolItem<A, E>>
  readonly available: Set<PoolItem<A, E>>
  readonly availableLatch: Latch.Latch
  readonly invalidated: Set<PoolItem<A, E>>
  waiters: number
}

/**
 * @since 4.0.0
 * @category models
 */
export interface PoolItem<A, E> {
  readonly exit: Exit.Exit<A, E>
  finalizer: Effect.Effect<void>
  refCount: number
  disableReclaim: boolean
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Strategy<A, E> {
  readonly run: (pool: Pool<A, E>) => Effect.Effect<void>
  readonly onAcquire: (item: PoolItem<A, E>) => Effect.Effect<void>
  readonly reclaim: (pool: Pool<A, E>) => Effect.Effect<PoolItem<A, E> | undefined>
}

/**
 * Returns `true` if the specified value is a `Pool`, `false` otherwise.
 *
 * @since 2.0.0
 * @category refinements
 */
export const isPool = (u: unknown): u is Pool<unknown, unknown> => hasProperty(u, TypeId)

/**
 * Makes a new pool of the specified fixed size. The pool is returned in a
 * `Scope`, which governs the lifetime of the pool. When the pool is shutdown
 * because the `Scope` is closed, the individual items allocated by the pool
 * will be released in some unspecified order.
 *
 * By setting the `concurrency` parameter, you can control the level of concurrent
 * access per pool item. By default, the number of permits is set to `1`.
 *
 * `targetUtilization` determines when to create new pool items. It is a value
 * between 0 and 1, where 1 means only create new pool items when all the existing
 * items are fully utilized.
 *
 * A `targetUtilization` of 0.5 will create new pool items when the existing items are
 * 50% utilized.
 *
 * @since 2.0.0
 * @category constructors
 */
export const make = <A, E, R>(options: {
  readonly acquire: Effect.Effect<A, E, R>
  readonly size: number
  readonly concurrency?: number | undefined
  readonly targetUtilization?: number | undefined
}): Effect.Effect<Pool<A, E>, never, R | Scope.Scope> =>
  makeWithStrategy({ ...options, min: options.size, max: options.size, strategy: strategyNoop() })

/**
 * Makes a new pool with the specified minimum and maximum sizes and time to
 * live before a pool whose excess items are not being used will be shrunk
 * down to the minimum size. The pool is returned in a `Scope`, which governs
 * the lifetime of the pool. When the pool is shutdown because the `Scope` is
 * used, the individual items allocated by the pool will be released in some
 * unspecified order.
 *
 * By setting the `concurrency` parameter, you can control the level of concurrent
 * access per pool item. By default, the number of permits is set to `1`.
 *
 * `targetUtilization` determines when to create new pool items. It is a value
 * between 0 and 1, where 1 means only create new pool items when all the existing
 * items are fully utilized.
 *
 * A `targetUtilization` of 0.5 will create new pool items when the existing items are
 * 50% utilized.
 *
 * The `timeToLiveStrategy` determines how items are invalidated. If set to
 * "creation", then items are invalidated based on their creation time. If set
 * to "usage", then items are invalidated based on pool usage.
 *
 * By default, the `timeToLiveStrategy` is set to "usage".
 *
 * ```ts skip-type-checking
 * import { Duration, Effect, Pool } from "effect"
 * import { createConnection } from "mysql2"
 *
 * const acquireDBConnection = Effect.acquireRelease(
 *   Effect.sync(() => createConnection("mysql://...")),
 *   (connection) => Effect.sync(() => connection.end(() => {}))
 * )
 *
 * const connectionPool = Effect.flatMap(
 *   Pool.makeWithTTL({
 *     acquire: acquireDBConnection,
 *     min: 10,
 *     max: 20,
 *     timeToLive: Duration.seconds(60)
 *   }),
 *   (pool) => pool.get
 * )
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const makeWithTTL = <A, E, R>(options: {
  readonly acquire: Effect.Effect<A, E, R>
  readonly min: number
  readonly max: number
  readonly concurrency?: number | undefined
  readonly targetUtilization?: number | undefined
  readonly timeToLive: Duration.Input
  readonly timeToLiveStrategy?: "creation" | "usage" | undefined
}): Effect.Effect<Pool<A, E>, never, R | Scope.Scope> =>
  Effect.flatMap(
    options.timeToLiveStrategy === "creation" ?
      strategyCreationTTL<A, E>(options.timeToLive) :
      strategyUsageTTL<A, E>(options.timeToLive),
    (strategy) => makeWithStrategy({ ...options, strategy })
  )

/**
 * @since 4.0.0
 * @category constructors
 */
export const makeWithStrategy = <A, E, R>(options: {
  readonly acquire: Effect.Effect<A, E, R>
  readonly min: number
  readonly max: number
  readonly concurrency?: number | undefined
  readonly targetUtilization?: number | undefined
  readonly strategy: Strategy<A, E>
}): Effect.Effect<Pool<A, E>, never, Scope.Scope | R> =>
  Effect.uninterruptibleMask(Effect.fnUntraced(function*(restore) {
    const services = yield* Effect.services<R | Scope.Scope>()
    const scope = ServiceMap.get(services, Scope.Scope)
    const acquire = Effect.updateServices(
      options.acquire,
      (input) => ServiceMap.merge(services, input)
    ) as Effect.Effect<A, E, Scope.Scope>
    const concurrency = options.concurrency ?? 1

    const config: Config<A, E> = {
      acquire,
      concurrency,
      minSize: options.min,
      maxSize: options.max,
      strategy: options.strategy,
      targetUtilization: Math.min(Math.max(options.targetUtilization ?? 1, 0.1), 1)
    }
    const state: State<A, E> = {
      scope,
      isShuttingDown: false,
      semaphore: Semaphore.makeUnsafe(concurrency * options.max),
      resizeSemaphore: Semaphore.makeUnsafe(1),
      items: new Set(),
      available: new Set(),
      availableLatch: Latch.makeUnsafe(false),
      invalidated: new Set(),
      waiters: 0
    }
    const self: Pool<A, E> = {
      [TypeId]: TypeId,
      config,
      state,
      pipe() {
        return pipeArguments(this, arguments)
      }
    }
    yield* Scope.addFinalizer(scope, shutdown(self))
    yield* Effect.tap(
      Effect.forkDetach(restore(resize(self))),
      (fiber) => Scope.addFinalizer(scope, Fiber.interrupt(fiber))
    )
    yield* Effect.tap(
      Effect.forkDetach(restore(options.strategy.run(self))),
      (fiber) => Scope.addFinalizer(scope, Fiber.interrupt(fiber))
    )
    return self
  }))

const shutdown = Effect.fnUntraced(function*<A, E>(self: Pool<A, E>) {
  if (self.state.isShuttingDown) return
  self.state.isShuttingDown = true
  const size = self.state.items.size
  const semaphore = Semaphore.makeUnsafe(size)
  for (const item of self.state.items) {
    if (item.refCount > 0) {
      item.finalizer = Effect.tap(item.finalizer, semaphore.release(1))
      self.state.invalidated.add(item)
      yield* semaphore.take(1)
    } else {
      self.state.items.delete(item)
      self.state.available.delete(item)
      self.state.invalidated.delete(item)
      yield* item.finalizer
    }
  }
  yield* semaphore.releaseAll
  self.state.availableLatch.openUnsafe()
  yield* semaphore.take(size)
})

/**
 * Retrieves an item from the pool in a scoped effect. Note that if
 * acquisition fails, then the returned effect will fail for that same reason.
 * Retrying a failed acquisition attempt will repeat the acquisition attempt.
 *
 * @since 2.0.0
 * @category getters
 */
export const get = <A, E>(self: Pool<A, E>): Effect.Effect<A, E, Scope.Scope> =>
  Effect.suspend(() => {
    if (self.state.isShuttingDown) {
      return Effect.interrupt
    }
    return Effect.flatMap(getPoolItem(self), (item) => item.exit)
  })

const getPoolItem = <A, E>(self: Pool<A, E>): Effect.Effect<PoolItem<A, E>, never, Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    restore(self.state.semaphore.take(1)).pipe(
      Effect.flatMap(() => Effect.scope),
      Effect.flatMap((scope) =>
        getPoolItemInner(self).pipe(
          Effect.ensuring(Effect.sync(() => self.state.waiters--)),
          Effect.tap((item) => {
            if (item.exit._tag === "Failure") {
              self.state.items.delete(item)
              self.state.invalidated.delete(item)
              self.state.available.delete(item)
              return self.state.semaphore.release(1)
            }
            item.refCount++
            self.state.available.delete(item)
            if (item.refCount < self.config.concurrency) {
              self.state.available.add(item)
            }
            return Scope.addFinalizerExit(scope, () =>
              Effect.flatMap(
                Effect.suspend(() => {
                  item.refCount--
                  if (self.state.invalidated.has(item)) {
                    return invalidatePoolItem(self, item)
                  }
                  self.state.available.add(item)
                  return Effect.void
                }),
                () => self.state.semaphore.release(1)
              ))
          }),
          Effect.onInterrupt(() => self.state.semaphore.release(1))
        )
      )
    )
  )

const getPoolItemInner = Effect.fnUntraced(function*<A, E>(
  self: Pool<A, E>
) {
  self.state.waiters++
  if (self.state.isShuttingDown) {
    return yield* Effect.interrupt
  } else if (targetSize(self) > activeSize(self)) {
    while (true) {
      yield* self.state.resizeSemaphore.withPermitsIfAvailable(1)(
        Effect.forkIn(Effect.interruptible(resize(self)), self.state.scope)
      )
      if (self.state.isShuttingDown) {
        return yield* Effect.interrupt
      } else if (self.state.available.size > 0) {
        return Iterable.headUnsafe(self.state.available)
      }
      self.state.availableLatch.closeUnsafe()
      yield* self.state.availableLatch.await
    }
  }
  return Iterable.headUnsafe(self.state.available)
})

/**
 * Invalidates the specified item. This will cause the pool to eventually
 * reallocate the item, although this reallocation may occur lazily rather
 * than eagerly.
 *
 * @since 2.0.0
 * @category combinators
 */
export const invalidate: {
  <A>(item: A): <E>(self: Pool<A, E>) => Effect.Effect<void, never, Scope.Scope>
  <A, E>(self: Pool<A, E>, item: A): Effect.Effect<void, never, Scope.Scope>
} = dual(2, <A, E>(self: Pool<A, E>, item: A): Effect.Effect<void, never, Scope.Scope> =>
  Effect.suspend(() => {
    if (self.state.isShuttingDown) return Effect.void
    for (const poolItem of self.state.items) {
      if (poolItem.exit._tag === "Success" && poolItem.exit.value === item) {
        poolItem.disableReclaim = true
        return Effect.uninterruptible(invalidatePoolItem(self, poolItem))
      }
    }
    return Effect.void
  }))

const invalidatePoolItem = <A, E>(self: Pool<A, E>, poolItem: PoolItem<A, E>): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (!self.state.items.has(poolItem)) {
      return Effect.void
    } else if (poolItem.refCount === 0) {
      self.state.items.delete(poolItem)
      self.state.available.delete(poolItem)
      self.state.invalidated.delete(poolItem)
      return Effect.asVoid(Effect.flatMap(
        poolItem.finalizer,
        () => Effect.forkIn(Effect.interruptible(resize(self)), self.state.scope)
      ))
    }
    self.state.invalidated.add(poolItem)
    self.state.available.delete(poolItem)
    return Effect.void
  })

const resize = <A, E>(self: Pool<A, E>): Effect.Effect<void> =>
  self.state.resizeSemaphore.withPermits(1)(resizeLoop(self))

const resizeLoop = <A, E>(self: Pool<A, E>): Effect.Effect<void> =>
  Effect.suspend(() => {
    const active = activeSize(self)
    const target = targetSize(self)
    if (active >= target) {
      return Effect.void
    }
    const toAcquire = target - active
    return self.config.strategy.reclaim(self).pipe(
      Effect.flatMap((item) => item ? Effect.succeed(item) : allocate(self)),
      Effect.replicateEffect(toAcquire, { concurrency: toAcquire }),
      Effect.tap(self.state.availableLatch.open),
      Effect.flatMap((items) => items.some((_) => _.exit._tag === "Failure") ? Effect.void : resizeLoop(self))
    )
  })

const allocate = <A, E>(self: Pool<A, E>): Effect.Effect<PoolItem<A, E>> =>
  Effect.acquireUseRelease(
    Scope.make(),
    (scope) =>
      self.config.acquire.pipe(
        Scope.provide(scope),
        Effect.exit,
        Effect.flatMap((exit) => {
          const item: PoolItem<A, E> = {
            exit,
            finalizer: Effect.catchCause(Scope.close(scope, exit), reportUnhandledError),
            refCount: 0,
            disableReclaim: false
          }
          self.state.items.add(item)
          self.state.available.add(item)
          return Effect.as(
            exit._tag === "Success"
              ? self.config.strategy.onAcquire(item)
              : Effect.flatMap(item.finalizer, () => self.config.strategy.onAcquire(item)),
            item
          )
        })
      ),
    (scope, exit) => exit._tag === "Failure" ? Scope.close(scope, exit) : Effect.void
  )

const currentUsage = <A, E>(self: Pool<A, E>) => {
  let count = self.state.waiters
  for (const item of self.state.items) {
    count += item.refCount
  }
  return count
}

const targetSize = <A, E>(self: Pool<A, E>) => {
  if (self.state.isShuttingDown) return 0
  const utilization = currentUsage(self) / self.config.targetUtilization
  const target = Math.ceil(utilization / self.config.concurrency)
  return Math.min(Math.max(self.config.minSize, target), self.config.maxSize)
}

const activeSize = <A, E>(self: Pool<A, E>) => {
  return self.state.items.size - self.state.invalidated.size
}

// -----------------------------------------------------------------------------
// Strategy
// -----------------------------------------------------------------------------

const strategyNoop = <A, E>(): Strategy<A, E> => ({
  run: (_) => Effect.void,
  onAcquire: (_) => Effect.void,
  reclaim: (_) => Effect.undefined
})

const strategyCreationTTL = Effect.fnUntraced(function*<A, E>(ttl: Duration.Input) {
  const clock = yield* Clock
  const queue = yield* Queue.unbounded<PoolItem<A, E>>()
  const ttlMillis = Duration.toMillis(Duration.fromInputUnsafe(ttl))
  const creationTimes = new WeakMap<PoolItem<A, E>, number>()
  return identity<Strategy<A, E>>({
    run: (pool) => {
      const process = (item: PoolItem<A, E>): Effect.Effect<void> =>
        Effect.suspend(() => {
          if (!pool.state.items.has(item) || pool.state.invalidated.has(item)) {
            return Effect.void
          }
          const now = clock.currentTimeMillisUnsafe()
          const created = creationTimes.get(item)!
          const remaining = ttlMillis - (now - created)
          return remaining > 0
            ? Effect.delay(process(item), remaining)
            : invalidatePoolItem(pool, item)
        })
      return Queue.take(queue).pipe(
        Effect.tap(process),
        Effect.forever({ disableYield: true })
      )
    },
    onAcquire: (item) =>
      Effect.suspend(() => {
        creationTimes.set(item, clock.currentTimeMillisUnsafe())
        return Queue.offer(queue, item)
      }),
    reclaim: (_) => Effect.undefined
  })
})

const strategyUsageTTL = Effect.fnUntraced(function*<A, E>(ttl: Duration.Input) {
  const queue = yield* Queue.unbounded<PoolItem<A, E>>()
  return identity<Strategy<A, E>>({
    run: (pool) => {
      const process: Effect.Effect<void> = Effect.suspend(() => {
        const excess = activeSize(pool) - targetSize(pool)
        if (excess <= 0) return Effect.void
        return Queue.take(queue).pipe(
          Effect.tap((item) => invalidatePoolItem(pool, item)),
          Effect.flatMap(() => process)
        )
      })
      return process.pipe(
        Effect.delay(ttl),
        Effect.forever({ disableYield: true })
      )
    },
    onAcquire: (item) => Queue.offer(queue, item),
    reclaim(pool) {
      return Effect.suspend((): Effect.Effect<PoolItem<A, E> | undefined> => {
        if (pool.state.invalidated.size === 0) {
          return Effect.undefined
        }
        const item = Iterable.head(
          Iterable.filter(pool.state.invalidated, (item) => !item.disableReclaim)
        )
        if (item._tag === "None") {
          return Effect.undefined
        }
        pool.state.invalidated.delete(item.value)
        if (item.value.refCount < pool.config.concurrency) {
          pool.state.available.add(item.value)
        }
        return Effect.as(Queue.offer(queue, item.value), item.value)
      })
    }
  })
})

const reportUnhandledError = <E>(cause: Cause.Cause<E>) =>
  Effect.withFiber<void>((fiber) => {
    const unhandledLogLevel = fiber.getRef(UnhandledLogLevel)
    if (unhandledLogLevel) {
      return Effect.logWithLevel(unhandledLogLevel)(
        "Unhandled error in pool finalizer",
        cause
      )
    }
    return Effect.void
  })

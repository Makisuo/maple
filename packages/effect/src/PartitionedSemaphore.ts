/**
 * @since 4.0.0
 */
import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import * as MutableHashMap from "./MutableHashMap.ts"
import * as Option from "./Option.ts"

/**
 * @since 4.0.0
 * @category models
 */
export const PartitionedTypeId: PartitionedTypeId = "~effect/PartitionedSemaphore"

/**
 * @since 4.0.0
 * @category models
 */
export type PartitionedTypeId = "~effect/PartitionedSemaphore"

/**
 * A `PartitionedSemaphore` controls access to a shared permit pool while
 * tracking waiters by partition key.
 *
 * Waiting permits are distributed across partitions in round-robin order.
 *
 * @since 4.0.0
 * @category models
 */
export interface PartitionedSemaphore<in K> {
  readonly [PartitionedTypeId]: PartitionedTypeId
  readonly capacity: number
  readonly available: Effect.Effect<number>
  readonly take: (key: K, permits: number) => Effect.Effect<void>
  readonly release: (permits: number) => Effect.Effect<number>
  readonly withPermits: (
    key: K,
    permits: number
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly withPermit: (key: K) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly withPermitsIfAvailable: (
    permits: number
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Partitioned<in K> extends PartitionedSemaphore<K> {}

/**
 * Creates a `PartitionedSemaphore` unsafely.
 *
 * @since 4.0.0
 * @category constructors
 */
export const makeUnsafe = <K = unknown>(options: {
  readonly permits: number
}): PartitionedSemaphore<K> => {
  const maxPermits = Math.max(0, options.permits)

  if (!Number.isFinite(maxPermits)) {
    return {
      [PartitionedTypeId]: PartitionedTypeId,
      capacity: maxPermits,
      available: Effect.succeed(maxPermits),
      take: () => Effect.void,
      release: () => Effect.succeed(maxPermits),
      withPermits: () => (effect) => effect,
      withPermit: () => (effect) => effect,
      withPermitsIfAvailable: () => (effect) => Effect.asSome(effect)
    }
  }

  let totalPermits = maxPermits
  let waitingPermits = 0

  type Waiter = {
    permits: number
    readonly resume: () => void
  }

  const partitions = MutableHashMap.empty<K, Set<Waiter>>()
  let iterator = partitions[Symbol.iterator]()

  const releaseUnsafe = (permits: number): number => {
    while (permits > 0) {
      if (waitingPermits === 0) {
        totalPermits = Math.min(maxPermits, totalPermits + permits)
        return totalPermits
      }

      let state = iterator.next()
      if (state.done) {
        iterator = partitions[Symbol.iterator]()
        state = iterator.next()
        if (state.done) {
          return totalPermits
        }
      }

      const waiter = state.value[1].values().next().value
      if (waiter === undefined) {
        continue
      }

      waiter.permits -= 1
      waitingPermits -= 1

      if (waiter.permits === 0) {
        waiter.resume()
      }

      permits -= 1
    }

    return totalPermits
  }

  const take = (key: K, permits: number): Effect.Effect<void> => {
    if (permits <= 0) {
      return Effect.void
    }

    return Effect.callback<void>((resume) => {
      if (maxPermits < permits) {
        resume(Effect.never)
        return
      }

      if (totalPermits >= permits) {
        totalPermits -= permits
        resume(Effect.void)
        return
      }

      const needed = permits - totalPermits
      const taken = permits - needed
      if (totalPermits > 0) {
        totalPermits = 0
      }
      waitingPermits += needed

      const waiters = Option.getOrElse(
        MutableHashMap.get(partitions, key),
        () => {
          const set = new Set<Waiter>()
          MutableHashMap.set(partitions, key, set)
          return set
        }
      )

      const entry: Waiter = {
        permits: needed,
        resume: () => {
          cleanup()
          resume(Effect.void)
        }
      }

      const cleanup = () => {
        waiters.delete(entry)
        if (waiters.size === 0) {
          MutableHashMap.remove(partitions, key)
        }
      }

      waiters.add(entry)

      return Effect.sync(() => {
        cleanup()
        waitingPermits -= entry.permits
        if (taken > 0) {
          releaseUnsafe(taken)
        }
      })
    })
  }

  const withPermits =
    (key: K, permits: number) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
      if (permits <= 0) {
        return effect
      }

      const takePermits = take(key, permits)
      return Effect.uninterruptibleMask((restore) =>
        Effect.flatMap(
          restore(takePermits),
          () =>
            Effect.ensuring(
              restore(effect),
              Effect.sync(() => {
                releaseUnsafe(permits)
              })
            )
        )
      )
    }

  const tryTake = (permits: number): boolean => {
    if (permits <= 0) {
      return true
    }

    if (maxPermits < permits || totalPermits < permits) {
      return false
    }

    totalPermits -= permits
    return true
  }

  return {
    [PartitionedTypeId]: PartitionedTypeId,
    capacity: maxPermits,
    available: Effect.sync(() => totalPermits),
    take,
    release: (permits) => Effect.sync(() => releaseUnsafe(permits)),
    withPermits,
    withPermit: (key) => withPermits(key, 1),
    withPermitsIfAvailable:
      (permits) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E, R> => {
        if (permits <= 0) {
          return Effect.asSome(effect)
        }

        return Effect.suspend(() => {
          if (!tryTake(permits)) {
            return Effect.succeed(Option.none())
          }

          return Effect.ensuring(
            Effect.asSome(effect),
            Effect.sync(() => {
              releaseUnsafe(permits)
            })
          )
        })
      }
  }
}

/**
 * Creates a `PartitionedSemaphore`.
 *
 * @since 4.0.0
 * @category constructors
 */
export const make = <K = unknown>(options: {
  readonly permits: number
}): Effect.Effect<PartitionedSemaphore<K>> => Effect.sync(() => makeUnsafe<K>(options))

/**
 * Gets the current number of available permits.
 *
 * @since 4.0.0
 * @category combinators
 */
export const available = <K>(self: PartitionedSemaphore<K>): Effect.Effect<number> => self.available

/**
 * Gets the total capacity.
 *
 * @since 4.0.0
 * @category getters
 */
export const capacity = <K>(self: PartitionedSemaphore<K>): number => self.capacity

/**
 * Acquires permits for a partition.
 *
 * @since 4.0.0
 * @category combinators
 */
export const take: {
  <K>(key: K, permits: number): (self: PartitionedSemaphore<K>) => Effect.Effect<void>
  <K>(self: PartitionedSemaphore<K>, key: K, permits: number): Effect.Effect<void>
} = dual(3, <K>(self: PartitionedSemaphore<K>, key: K, permits: number): Effect.Effect<void> => self.take(key, permits))

/**
 * Releases permits back to the shared pool.
 *
 * @since 4.0.0
 * @category combinators
 */
export const release: {
  (permits: number): <K>(self: PartitionedSemaphore<K>) => Effect.Effect<number>
  <K>(self: PartitionedSemaphore<K>, permits: number): Effect.Effect<number>
} = dual(2, <K>(self: PartitionedSemaphore<K>, permits: number): Effect.Effect<number> => self.release(permits))

/**
 * Runs an effect with permits for a partition.
 *
 * @since 4.0.0
 * @category combinators
 */
export const withPermits: {
  <K>(
    self: PartitionedSemaphore<K>,
    key: K,
    permits: number
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <K, A, E, R>(
    self: PartitionedSemaphore<K>,
    key: K,
    permits: number,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R>
} = ((...args: Array<any>) => {
  if (args.length === 3) {
    const [self, key, permits] = args
    return (effect: Effect.Effect<any, any, any>) => self.withPermits(key, permits)(effect)
  }
  const [self, key, permits, effect] = args
  return self.withPermits(key, permits)(effect)
}) as any

/**
 * Runs an effect with a single permit for a partition.
 *
 * @since 4.0.0
 * @category combinators
 */
export const withPermit: {
  <K>(self: PartitionedSemaphore<K>, key: K): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <K, A, E, R>(
    self: PartitionedSemaphore<K>,
    key: K,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R>
} = ((...args: Array<any>) => {
  if (args.length === 2) {
    const [self, key] = args
    return (effect: Effect.Effect<any, any, any>) => self.withPermit(key)(effect)
  }
  const [self, key, effect] = args
  return self.withPermit(key)(effect)
}) as any

/**
 * Runs an effect only if the permits are immediately available.
 *
 * @since 4.0.0
 * @category combinators
 */
export const withPermitsIfAvailable: {
  <K>(
    self: PartitionedSemaphore<K>,
    permits: number
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>
  <K, A, E, R>(
    self: PartitionedSemaphore<K>,
    permits: number,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<Option.Option<A>, E, R>
} = ((...args: Array<any>) => {
  if (args.length === 2) {
    const [self, permits] = args
    return (effect: Effect.Effect<any, any, any>) => self.withPermitsIfAvailable(permits)(effect)
  }
  const [self, permits, effect] = args
  return self.withPermitsIfAvailable(permits)(effect)
}) as any

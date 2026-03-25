/**
 * @since 3.5.0
 */
import * as Cause from "./Cause.ts"
import { Clock } from "./Clock.ts"
import * as Deferred from "./Deferred.ts"
import * as Duration from "./Duration.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import * as Fiber from "./Fiber.ts"
import { constant, dual, flow } from "./Function.ts"
import * as MutableHashMap from "./MutableHashMap.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import * as Scope from "./Scope.ts"
import * as ServiceMap from "./ServiceMap.ts"

const TypeId = "~effect/RcMap"

/**
 * An `RcMap` is a reference-counted map data structure that manages the lifecycle
 * of resources indexed by keys. Resources are lazily acquired and automatically
 * released when no longer in use.
 *
 * @since 3.5.0
 * @category models
 * @example
 * ```ts
 * import { Effect, RcMap } from "effect"
 *
 * Effect.gen(function*() {
 *   // Create an RcMap that manages database connections
 *   const dbConnectionMap = yield* RcMap.make({
 *     lookup: (dbName: string) =>
 *       Effect.acquireRelease(
 *         Effect.succeed(`Connection to ${dbName}`),
 *         (conn) => Effect.log(`Closing ${conn}`)
 *       ),
 *     capacity: 10,
 *     idleTimeToLive: "5 minutes"
 *   })
 *
 *   // The RcMap interface provides access to:
 *   // - lookup: Function to acquire resources
 *   // - capacity: Maximum number of resources
 *   // - idleTimeToLive: Time before idle resources are released
 *   // - state: Current state of the map
 *
 *   console.log(`Capacity: ${dbConnectionMap.capacity}`)
 * }).pipe(Effect.scoped)
 * ```
 */
export interface RcMap<in out K, in out A, in out E = never> extends Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly lookup: (key: K) => Effect.Effect<A, E, Scope.Scope>
  readonly services: ServiceMap.ServiceMap<never>
  readonly scope: Scope.Scope
  readonly idleTimeToLive: (key: K) => Duration.Duration
  readonly capacity: number
  state: State<K, A, E>
}

/**
 * Represents the internal state of an RcMap, which can be either Open (active)
 * or Closed (shutdown and no longer accepting operations).
 *
 * @since 4.0.0
 * @category Models
 * @example
 * ```ts
 * import type { RcMap } from "effect"
 *
 * // State is a union type that can be either:
 * declare const openState: RcMap.State.Open<string, number, never>
 * declare const closedState: RcMap.State.Closed
 *
 * // Check the state type
 * declare const state: RcMap.State<string, number, never>
 * if (state._tag === "Open") {
 *   // Access the internal map when open
 *   console.log("Map is open, contains entries")
 * } else {
 *   // State is closed
 *   console.log("Map is closed")
 * }
 * ```
 */
export type State<K, A, E> = State.Open<K, A, E> | State.Closed

/**
 * Namespace containing the internal state types for RcMap.
 *
 * @since 4.0.0
 * @category Models
 * @example
 * ```ts
 * import type { RcMap } from "effect"
 *
 * // The State namespace contains types for RcMap internal state:
 * // - Open: Contains the active resource map
 * // - Closed: Indicates the map is shut down
 * // - Entry: Individual resource entries with metadata
 *
 * declare const openState: RcMap.State.Open<string, number, never>
 * declare const closedState: RcMap.State.Closed
 * declare const entry: RcMap.State.Entry<number, never>
 * ```
 */
export declare namespace State {
  /**
   * Represents the open/active state of an RcMap, containing the actual
   * resource map that stores entries.
   *
   * @since 4.0.0
   * @category Models
   * @example
   * ```ts
   * import type { RcMap } from "effect"
   * import * as MutableHashMap from "effect/MutableHashMap"
   *
   * // State.Open contains the active resource map
   * declare const openState: RcMap.State.Open<string, number, never>
   *
   * // Access the internal map when state is open
   * if (openState._tag === "Open") {
   *   // The map contains Entry objects indexed by keys
   *   const hasKey = MutableHashMap.has(openState.map, "someKey")
   *   console.log(`Map contains key: ${hasKey}`)
   * }
   * ```
   */
  export interface Open<K, A, E> {
    readonly _tag: "Open"
    readonly map: MutableHashMap.MutableHashMap<K, Entry<A, E>>
  }

  /**
   * Represents the closed state of an RcMap, indicating that the map has been
   * shut down and will no longer accept new operations.
   *
   * @since 4.0.0
   * @category Models
   * @example
   * ```ts
   * import type { RcMap } from "effect"
   *
   * // State.Closed indicates the RcMap is shut down
   * declare const closedState: RcMap.State.Closed
   *
   * // Check for closed state
   * if (closedState._tag === "Closed") {
   *   console.log("RcMap is closed, no operations allowed")
   *   // Any attempt to get resources will result in interruption
   * }
   * ```
   */
  export interface Closed {
    readonly _tag: "Closed"
  }

  /**
   * Represents an individual entry in the RcMap, containing the resource's
   * metadata including reference count, expiration time, and lifecycle management.
   *
   * @since 4.0.0
   * @category Models
   * @example
   * ```ts
   * import type { RcMap } from "effect"
   *
   * // Entry contains all metadata for a resource in the map
   * declare const entry: RcMap.State.Entry<string, never>
   *
   * // Entry properties:
   * // - deferred: Promise-like structure for the resource value
   * // - scope: Manages the resource's lifecycle
   * // - finalizer: Effect to run when cleaning up
   * // - fiber: Optional background fiber for expiration
   * // - expiresAt: Timestamp when resource expires
   * // - refCount: Number of active references
   *
   * console.log(`Reference count: ${entry.refCount}`)
   * console.log(`Expires at: ${entry.expiresAt}`)
   * ```
   */
  export interface Entry<A, E> {
    readonly deferred: Deferred.Deferred<A, E>
    readonly scope: Scope.Closeable
    readonly finalizer: Effect.Effect<void>
    readonly idleTimeToLive: Duration.Duration
    fiber: Fiber.Fiber<void> | undefined
    expiresAt: number
    refCount: number
  }
}

const makeUnsafe = <K, A, E>(options: {
  readonly lookup: (key: K) => Effect.Effect<A, E, Scope.Scope>
  readonly services: ServiceMap.ServiceMap<never>
  readonly scope: Scope.Scope
  readonly idleTimeToLive: (key: K) => Duration.Duration
  readonly capacity: number
}): RcMap<K, A, E> => ({
  [TypeId]: TypeId,
  lookup: options.lookup,
  services: options.services,
  scope: options.scope,
  idleTimeToLive: options.idleTimeToLive,
  capacity: options.capacity,
  state: {
    _tag: "Open",
    map: MutableHashMap.empty()
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
})

/**
 * An `RcMap` can contain multiple reference counted resources that can be indexed
 * by a key. The resources are lazily acquired on the first call to `get` and
 * released when the last reference is released.
 *
 * Complex keys can extend `Equal` and `Hash` to allow lookups by value.
 *
 * **Options**
 *
 * - `capacity`: The maximum number of resources that can be held in the map.
 * - `idleTimeToLive`: When the reference count reaches zero, the resource will be released after this duration.
 *
 * @since 3.5.0
 * @category models
 * @example
 * ```ts
 * import { Effect, RcMap } from "effect"
 *
 * Effect.gen(function*() {
 *   const map = yield* RcMap.make({
 *     lookup: (key: string) =>
 *       Effect.acquireRelease(
 *         Effect.succeed(`acquired ${key}`),
 *         () => Effect.log(`releasing ${key}`)
 *       )
 *   })
 *
 *   // Get "foo" from the map twice, which will only acquire it once.
 *   // It will then be released once the scope closes.
 *   yield* RcMap.get(map, "foo").pipe(
 *     Effect.andThen(RcMap.get(map, "foo")),
 *     Effect.scoped
 *   )
 * })
 * ```
 */
export const make: {
  <K, A, E, R>(options: {
    readonly lookup: (key: K) => Effect.Effect<A, E, R>
    readonly idleTimeToLive?: Duration.Input | ((key: K) => Duration.Input) | undefined
    readonly capacity?: undefined
  }): Effect.Effect<RcMap<K, A, E>, never, Scope.Scope | R>
  <K, A, E, R>(options: {
    readonly lookup: (key: K) => Effect.Effect<A, E, R>
    readonly idleTimeToLive?: Duration.Input | ((key: K) => Duration.Input) | undefined
    readonly capacity: number
  }): Effect.Effect<RcMap<K, A, E | Cause.ExceededCapacityError>, never, Scope.Scope | R>
} = <K, A, E, R>(options: {
  readonly lookup: (key: K) => Effect.Effect<A, E, R>
  readonly idleTimeToLive?: Duration.Input | ((key: K) => Duration.Input) | undefined
  readonly capacity?: number | undefined
}) =>
  Effect.withFiber<RcMap<K, A, E>, never, R | Scope.Scope>((fiber) => {
    const services = fiber.services as ServiceMap.ServiceMap<R | Scope.Scope>
    const scope = ServiceMap.get(services, Scope.Scope)
    const self = makeUnsafe<K, A, E>({
      lookup: options.lookup as any,
      services,
      scope,
      idleTimeToLive: typeof options.idleTimeToLive === "function"
        ? flow(options.idleTimeToLive, Duration.fromInputUnsafe)
        : constant(Duration.fromInputUnsafe(options.idleTimeToLive ?? Duration.zero)),
      capacity: Math.max(options.capacity ?? Number.POSITIVE_INFINITY, 0)
    })
    return Effect.as(
      Scope.addFinalizerExit(scope, () => {
        if (self.state._tag === "Closed") {
          return Effect.void
        }
        const map = self.state.map
        self.state = { _tag: "Closed" }
        return Effect.forEach(
          map,
          ([, entry]) => Effect.exit(Scope.close(entry.scope, Exit.void))
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              MutableHashMap.clear(map)
            })
          )
        )
      }),
      self
    )
  })

/**
 * Retrieves a value from the RcMap by key. If the resource doesn't exist, it will be
 * acquired using the lookup function. The resource is reference counted and will be
 * released when the scope closes.
 *
 * @since 3.5.0
 * @category combinators
 * @example
 * ```ts
 * import { Effect, RcMap } from "effect"
 *
 * Effect.gen(function*() {
 *   const map = yield* RcMap.make({
 *     lookup: (key: string) =>
 *       Effect.acquireRelease(
 *         Effect.succeed(`Resource: ${key}`),
 *         () => Effect.log(`Released ${key}`)
 *       )
 *   })
 *
 *   // Get a resource - it will be acquired on first access
 *   const resource = yield* RcMap.get(map, "database")
 *   console.log(resource) // "Resource: database"
 * }).pipe(Effect.scoped)
 * ```
 */
export const get: {
  <K>(key: K): <A, E>(self: RcMap<K, A, E>) => Effect.Effect<A, E, Scope.Scope>
  <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<A, E, Scope.Scope>
} = dual(
  2,
  <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<A, E, Scope.Scope> =>
    Effect.uninterruptibleMask((restore) => {
      if (self.state._tag === "Closed") {
        return Effect.interrupt
      }
      const state = self.state
      const parent = Fiber.getCurrent()!
      const o = MutableHashMap.get(state.map, key)
      let entry: State.Entry<A, E>
      if (o._tag === "Some") {
        entry = o.value
        entry.refCount++
      } else if (Number.isFinite(self.capacity) && MutableHashMap.size(self.state.map) >= self.capacity) {
        return Effect.fail(
          new Cause.ExceededCapacityError(`RcMap attempted to exceed capacity of ${self.capacity}`)
        ) as Effect.Effect<never>
      } else {
        entry = {
          deferred: Deferred.makeUnsafe(),
          scope: Scope.makeUnsafe(),
          idleTimeToLive: self.idleTimeToLive(key),
          finalizer: undefined as any,
          fiber: undefined,
          expiresAt: 0,
          refCount: 1
        }
        ;(entry as any).finalizer = release(self, key, entry)
        MutableHashMap.set(state.map, key, entry)
        const services = new Map(self.services.mapUnsafe)
        parent.services.mapUnsafe.forEach((value, key) => {
          services.set(key, value)
        })
        services.set(Scope.Scope.key, entry.scope)
        self.lookup(key).pipe(
          Effect.runForkWith(ServiceMap.makeUnsafe(services)),
          Fiber.runIn(entry.scope)
        ).addObserver((exit) => Deferred.doneUnsafe(entry.deferred, exit))
      }
      const scope = ServiceMap.getUnsafe(parent.services, Scope.Scope)
      return Scope.addFinalizer(scope, entry.finalizer).pipe(
        Effect.andThen(restore(Deferred.await(entry.deferred)))
      )
    })
)

const release = <K, A, E>(self: RcMap<K, A, E>, key: K, entry: State.Entry<A, E>) =>
  Effect.withFiber((fiber) => {
    entry.refCount--
    if (entry.refCount > 0) {
      return Effect.void
    } else if (
      self.state._tag === "Closed"
      || !MutableHashMap.has(self.state.map, key)
      || Duration.isZero(entry.idleTimeToLive)
    ) {
      if (self.state._tag === "Open") {
        MutableHashMap.remove(self.state.map, key)
      }
      return Scope.close(entry.scope, Exit.void)
    } else if (!Duration.isFinite(entry.idleTimeToLive)) {
      return Effect.void
    }

    const clock = fiber.getRef(Clock)
    entry.expiresAt = clock.currentTimeMillisUnsafe() + Duration.toMillis(entry.idleTimeToLive)
    if (entry.fiber) return Effect.void

    entry.fiber = Effect.interruptibleMask(function loop(restore): Effect.Effect<void> {
      const now = clock.currentTimeMillisUnsafe()
      const remaining = entry.expiresAt - now
      if (remaining <= 0) {
        if (self.state._tag === "Closed" || entry.refCount > 0) return Effect.void
        MutableHashMap.remove(self.state.map, key)
        return restore(Scope.close(entry.scope, Exit.void))
      }
      return Effect.flatMap(clock.sleep(Duration.millis(remaining)), () => loop(restore))
    }).pipe(
      Effect.ensuring(Effect.sync(() => {
        entry.fiber = undefined
      })),
      Effect.runForkWith(fiber.services),
      Fiber.runIn(self.scope)
    )
    return Effect.void
  })

/**
 * Returns an array of all keys currently stored in the RcMap.
 *
 * @since 3.5.0
 * @category combinators
 * @example
 * ```ts
 * import { Effect, RcMap } from "effect"
 *
 * Effect.gen(function*() {
 *   const map = yield* RcMap.make({
 *     lookup: (key: string) => Effect.succeed(`value-${key}`)
 *   })
 *
 *   // Add some resources to the map
 *   yield* RcMap.get(map, "foo")
 *   yield* RcMap.get(map, "bar")
 *   yield* RcMap.get(map, "baz")
 *
 *   // Get all keys currently in the map
 *   const allKeys = yield* RcMap.keys(map)
 *   console.log(allKeys) // ["foo", "bar", "baz"]
 * }).pipe(Effect.scoped)
 * ```
 */
export const keys = <K, A, E>(self: RcMap<K, A, E>): Effect.Effect<Iterable<K>> => {
  return Effect.suspend(() =>
    self.state._tag === "Closed" ? Effect.interrupt : Effect.succeed(MutableHashMap.keys(self.state.map))
  )
}

/**
 * Invalidates and removes a specific key from the RcMap. If the resource is not
 * currently in use (reference count is 0), it will be immediately released.
 *
 * @since 3.5.0
 * @category combinators
 * @example
 * ```ts
 * import { Effect, RcMap } from "effect"
 *
 * Effect.gen(function*() {
 *   const map = yield* RcMap.make({
 *     lookup: (key: string) =>
 *       Effect.acquireRelease(
 *         Effect.succeed(`Resource: ${key}`),
 *         () => Effect.log(`Released ${key}`)
 *       )
 *   })
 *
 *   // Get a resource
 *   yield* RcMap.get(map, "cache")
 *
 *   // Invalidate the resource - it will be removed from the map
 *   // and released if no longer in use
 *   yield* RcMap.invalidate(map, "cache")
 *
 *   // Next access will create a new resource
 *   yield* RcMap.get(map, "cache")
 * }).pipe(Effect.scoped)
 * ```
 */
export const invalidate: {
  <K>(key: K): <A, E>(self: RcMap<K, A, E>) => Effect.Effect<void>
  <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<void>
} = dual(
  2,
  Effect.fnUntraced(function*<K, A, E>(self: RcMap<K, A, E>, key: K) {
    if (self.state._tag === "Closed") return
    const o = MutableHashMap.get(self.state.map, key)
    if (o._tag === "None") return
    const entry = o.value
    MutableHashMap.remove(self.state.map, key)
    if (entry.refCount > 0) return
    if (entry.fiber) yield* Fiber.interrupt(entry.fiber)
    yield* Scope.close(entry.scope, Exit.void)
  }, Effect.uninterruptible)
)

/**
 * @since 3.17.7
 * @category combinators
 */
export const has: {
  <K>(key: K): <A, E>(self: RcMap<K, A, E>) => Effect.Effect<boolean>
  <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<boolean>
} = dual(
  2,
  <K, A, E>(self: RcMap<K, A, E>, key: K) =>
    Effect.sync(() => {
      if (self.state._tag === "Closed") return false
      return MutableHashMap.has(self.state.map, key)
    })
)

/**
 * Extends the idle time for a resource in the RcMap. If the RcMap has an
 * `idleTimeToLive` configured, calling `touch` will reset the expiration
 * timer for the specified key.
 *
 * @since 3.5.0
 * @category combinators
 * @example
 * ```ts
 * import { Effect, RcMap } from "effect"
 *
 * Effect.gen(function*() {
 *   const map = yield* RcMap.make({
 *     lookup: (key: string) =>
 *       Effect.acquireRelease(
 *         Effect.succeed(`Resource: ${key}`),
 *         () => Effect.log(`Released ${key}`)
 *       ),
 *     idleTimeToLive: "10 seconds"
 *   })
 *
 *   // Get a resource
 *   yield* RcMap.get(map, "session")
 *
 *   // Touch the resource to extend its idle time
 *   // This resets the 10-second expiration timer
 *   yield* RcMap.touch(map, "session")
 *
 *   // The resource will now live for another 10 seconds
 *   // from the time it was touched
 * }).pipe(Effect.scoped)
 * ```
 */
export const touch: {
  <K>(key: K): <A, E>(self: RcMap<K, A, E>) => Effect.Effect<void>
  <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<void>
} = dual(
  2,
  <K, A, E>(self: RcMap<K, A, E>, key: K) =>
    Effect.clockWith((clock) => {
      if (self.state._tag === "Closed") {
        return Effect.void
      }
      const o = MutableHashMap.get(self.state.map, key)
      if (o._tag === "None" || Duration.isZero(o.value.idleTimeToLive)) {
        return Effect.void
      }
      const entry = o.value
      entry.expiresAt = clock.currentTimeMillisUnsafe() + Duration.toMillis(entry.idleTimeToLive)
      return Effect.void
    })
)

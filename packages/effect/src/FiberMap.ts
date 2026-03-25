/**
 * @since 2.0.0
 */
import * as Cause from "./Cause.ts"
import * as Deferred from "./Deferred.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import * as Fiber from "./Fiber.ts"
import * as Filter from "./Filter.ts"
import { constVoid, dual } from "./Function.ts"
import type * as Inspectable from "./Inspectable.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import * as Iterable from "./Iterable.ts"
import * as MutableHashMap from "./MutableHashMap.ts"
import * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import * as Predicate from "./Predicate.ts"
import type * as Scope from "./Scope.ts"
import type { ServiceMap } from "./ServiceMap.ts"

const TypeId = "~effect/FiberMap"

/**
 * A FiberMap is a collection of fibers, indexed by a key. When the associated
 * Scope is closed, all fibers in the map will be interrupted. Fibers are
 * automatically removed from the map when they complete.
 *
 * @example
 * ```ts
 * import { Effect, FiberMap } from "effect"
 *
 * // Create a FiberMap with string keys
 * const program = Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *
 *   // Add some fibers to the map
 *   yield* FiberMap.run(map, "task1", Effect.succeed("Hello"))
 *   yield* FiberMap.run(map, "task2", Effect.succeed("World"))
 *
 *   // Get the size of the map
 *   const size = yield* FiberMap.size(map)
 *   console.log(size) // 2
 * })
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface FiberMap<in out K, out A = unknown, out E = unknown>
  extends Pipeable, Inspectable.Inspectable, Iterable<[K, Fiber.Fiber<A, E>]>
{
  readonly [TypeId]: typeof TypeId
  readonly deferred: Deferred.Deferred<void, unknown>
  state: {
    readonly _tag: "Open"
    readonly backing: MutableHashMap.MutableHashMap<K, Fiber.Fiber<A, E>>
  } | {
    readonly _tag: "Closed"
  }
}

/**
 * @example
 * ```ts
 * import { Effect, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *
 *   console.log(FiberMap.isFiberMap(map)) // true
 *   console.log(FiberMap.isFiberMap({})) // false
 *   console.log(FiberMap.isFiberMap(null)) // false
 * })
 * ```
 *
 * @since 2.0.0
 * @category refinements
 */
export const isFiberMap = (u: unknown): u is FiberMap<unknown> => Predicate.hasProperty(u, TypeId)

const Proto = {
  [TypeId]: TypeId,
  [Symbol.iterator](this: FiberMap<unknown>) {
    if (this.state._tag === "Closed") {
      return Iterable.empty()
    }
    return this.state.backing[Symbol.iterator]()
  },
  ...PipeInspectableProto,
  toJSON(this: FiberMap<unknown>) {
    return {
      _id: "FiberMap",
      state: this.state
    }
  }
}

const makeUnsafe = <K, A = unknown, E = unknown>(
  backing: MutableHashMap.MutableHashMap<K, Fiber.Fiber<A, E>>,
  deferred: Deferred.Deferred<void, E>
): FiberMap<K, A, E> => {
  const self = Object.create(Proto)
  self.state = { _tag: "Open", backing }
  self.deferred = deferred
  return self
}

/**
 * A FiberMap can be used to store a collection of fibers, indexed by some key.
 * When the associated Scope is closed, all fibers in the map will be interrupted.
 *
 * You can add fibers to the map using `FiberMap.set` or `FiberMap.run`, and the fibers will
 * be automatically removed from the FiberMap when they complete.
 *
 * @example
 * ```ts
 * import { Effect, FiberMap } from "effect"
 *
 * Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *
 *   // run some effects and add the fibers to the map
 *   yield* FiberMap.run(map, "fiber a", Effect.never)
 *   yield* FiberMap.run(map, "fiber b", Effect.never)
 *
 *   yield* Effect.sleep(1000)
 * }).pipe(
 *   Effect.scoped // The fibers will be interrupted when the scope is closed
 * )
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const make = <K, A = unknown, E = unknown>(): Effect.Effect<FiberMap<K, A, E>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() =>
      makeUnsafe<K, A, E>(
        MutableHashMap.empty(),
        Deferred.makeUnsafe()
      )
    ),
    (map) =>
      Effect.suspend(() => {
        const state = map.state
        if (state._tag === "Closed") return Effect.void
        map.state = { _tag: "Closed" }
        return Fiber.interruptAll(MutableHashMap.values(state.backing)).pipe(
          Deferred.into(map.deferred)
        )
      })
  )

/**
 * Create an Effect run function that is backed by a FiberMap.
 *
 * @example
 * ```ts
 * import { Effect, Fiber, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const run = yield* FiberMap.makeRuntime<never, string>()
 *
 *   // Run effects and get back fibers
 *   const fiber1 = run("task1", Effect.succeed("Hello"))
 *   const fiber2 = run("task2", Effect.succeed("World"))
 *
 *   // Await the results
 *   const result1 = yield* Fiber.await(fiber1)
 *   const result2 = yield* Fiber.await(fiber2)
 *
 *   console.log(result1, result2) // "Hello", "World"
 * })
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const makeRuntime = <R, K, E = unknown, A = unknown>(): Effect.Effect<
  <XE extends E, XA extends A>(
    key: K,
    effect: Effect.Effect<XA, XE, R>,
    options?:
      | Effect.RunOptions & {
        readonly onlyIfMissing?: boolean | undefined
      }
      | undefined
  ) => Fiber.Fiber<XA, XE>,
  never,
  Scope.Scope | R
> =>
  Effect.flatMap(
    make<K, A, E>(),
    (self) => runtime(self)<R>()
  )

/**
 * Create an Effect run function that is backed by a FiberMap.
 * Returns a Promise instead of a Fiber for more convenient use with async/await.
 *
 * @example
 * ```ts
 * import { Effect, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const run = yield* FiberMap.makeRuntimePromise<never, string>()
 *
 *   // Run effects and get back promises
 *   const promise1 = run("task1", Effect.succeed("Hello"))
 *   const promise2 = run("task2", Effect.succeed("World"))
 *
 *   // Convert to Effect and await
 *   const result1 = yield* Effect.promise(() => promise1)
 *   const result2 = yield* Effect.promise(() => promise2)
 *
 *   console.log(result1, result2) // "Hello", "World"
 * })
 * ```
 *
 * @since 3.13.0
 * @category constructors
 */
export const makeRuntimePromise = <R, K, A = unknown, E = unknown>(): Effect.Effect<
  <XE extends E, XA extends A>(
    key: K,
    effect: Effect.Effect<XA, XE, R>,
    options?:
      | Effect.RunOptions & {
        readonly onlyIfMissing?: boolean | undefined
      }
      | undefined
  ) => Promise<XA>,
  never,
  Scope.Scope | R
> =>
  Effect.flatMap(
    make<K, A, E>(),
    (self) => runtimePromise(self)<R>()
  )

const internalFiberId = -1
const isInternalInterruption = Filter.toPredicate(Filter.compose(
  Cause.filterInterruptors,
  Filter.has(internalFiberId)
))

/**
 * Add a fiber to the FiberMap. When the fiber completes, it will be removed from the FiberMap.
 * If the key already exists in the FiberMap, the previous fiber will be interrupted.
 *
 * @example
 * ```ts
 * import { Effect, Fiber, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *
 *   // Create a fiber and add it to the map
 *   const fiber = yield* Effect.forkChild(Effect.succeed("Hello"))
 *   FiberMap.setUnsafe(map, "greeting", fiber)
 *
 *   // The fiber will be automatically removed when it completes
 *   const result = yield* Fiber.await(fiber)
 *   console.log(result) // "Hello"
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const setUnsafe: {
  <K, A, E, XE extends E, XA extends A>(
    key: K,
    fiber: Fiber.Fiber<XA, XE>,
    options?: {
      readonly onlyIfMissing?: boolean | undefined
      readonly propagateInterruption?: boolean | undefined
    } | undefined
  ): (self: FiberMap<K, A, E>) => void
  <K, A, E, XE extends E, XA extends A>(
    self: FiberMap<K, A, E>,
    key: K,
    fiber: Fiber.Fiber<XA, XE>,
    options?: {
      readonly onlyIfMissing?: boolean | undefined
      readonly propagateInterruption?: boolean | undefined
    } | undefined
  ): void
} = dual((args) => isFiberMap(args[0]), <K, A, E, XE extends E, XA extends A>(
  self: FiberMap<K, A, E>,
  key: K,
  fiber: Fiber.Fiber<XA, XE>,
  options?: {
    readonly onlyIfMissing?: boolean | undefined
    readonly propagateInterruption?: boolean | undefined
  } | undefined
): void => {
  if (self.state._tag === "Closed") {
    fiber.interruptUnsafe(internalFiberId)
    return
  }

  const previous = MutableHashMap.get(self.state.backing, key)
  if (previous._tag === "Some") {
    if (options?.onlyIfMissing === true) {
      fiber.interruptUnsafe(internalFiberId)
      return
    } else if (previous.value === fiber) {
      return
    }
    previous.value.interruptUnsafe(internalFiberId)
  }

  MutableHashMap.set(self.state.backing, key, fiber)
  fiber.addObserver((exit) => {
    if (self.state._tag === "Closed") {
      return
    }
    const current = MutableHashMap.get(self.state.backing, key)
    if (Option.isSome(current) && fiber === current.value) {
      MutableHashMap.remove(self.state.backing, key)
    }
    if (
      Exit.isFailure(exit) &&
      (
        options?.propagateInterruption === true ?
          !isInternalInterruption(exit.cause) :
          !Cause.hasInterruptsOnly(exit.cause)
      )
    ) {
      Deferred.doneUnsafe(self.deferred, exit as any)
    }
  })
})

/**
 * Add a fiber to the FiberMap. When the fiber completes, it will be removed from the FiberMap.
 * If the key already exists in the FiberMap, the previous fiber will be interrupted.
 * This is the Effect-wrapped version of `setUnsafe`.
 *
 * @example
 * ```ts
 * import { Effect, Fiber, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *
 *   // Create a fiber and add it to the map using Effect
 *   const fiber = yield* Effect.forkChild(Effect.succeed("Hello"))
 *   yield* FiberMap.set(map, "greeting", fiber)
 *
 *   // The fiber will be automatically removed when it completes
 *   const result = yield* Fiber.await(fiber)
 *   console.log(result) // "Hello"
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const set: {
  <K, A, E, XE extends E, XA extends A>(
    key: K,
    fiber: Fiber.Fiber<XA, XE>,
    options?: {
      readonly onlyIfMissing?: boolean | undefined
      readonly propagateInterruption?: boolean | undefined
    } | undefined
  ): (self: FiberMap<K, A, E>) => Effect.Effect<void>
  <K, A, E, XE extends E, XA extends A>(
    self: FiberMap<K, A, E>,
    key: K,
    fiber: Fiber.Fiber<XA, XE>,
    options?: {
      readonly onlyIfMissing?: boolean | undefined
      readonly propagateInterruption?: boolean | undefined
    } | undefined
  ): Effect.Effect<void>
} = dual((args) => isFiberMap(args[0]), <K, A, E, XE extends E, XA extends A>(
  self: FiberMap<K, A, E>,
  key: K,
  fiber: Fiber.Fiber<XA, XE>,
  options?: {
    readonly onlyIfMissing?: boolean | undefined
    readonly propagateInterruption?: boolean | undefined
  } | undefined
): Effect.Effect<void> => Effect.sync(() => setUnsafe(self, key, fiber, options)))

/**
 * Retrieve a fiber from the FiberMap.
 *
 * @example
 * ```ts
 * import { Effect, Fiber, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *
 *   // Add a fiber to the map
 *   const fiber = yield* Effect.forkChild(Effect.succeed("Hello"))
 *   FiberMap.setUnsafe(map, "greeting", fiber)
 *
 *   // Retrieve the fiber
 *   const retrieved = FiberMap.getUnsafe(map, "greeting")
 *   if (retrieved._tag === "Some") {
 *     const result = yield* Fiber.await(retrieved.value)
 *     console.log(result) // "Hello"
 *   }
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const getUnsafe: {
  <K>(key: K): <A, E>(self: FiberMap<K, A, E>) => Option.Option<Fiber.Fiber<A, E>>
  <K, A, E>(self: FiberMap<K, A, E>, key: K): Option.Option<Fiber.Fiber<A, E>>
} = dual(
  2,
  <K, A, E>(self: FiberMap<K, A, E>, key: K): Option.Option<Fiber.Fiber<A, E>> => {
    return self.state._tag === "Closed" ? Option.none() : MutableHashMap.get(self.state.backing, key)
  }
)

/**
 * Retrieve a fiber from the FiberMap.
 *
 * Returns an `Option` wrapped in `Effect`.
 *
 * @example
 * ```ts
 * import { Effect, Fiber, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *
 *   // Add a fiber to the map
 *   const fiber = yield* Effect.forkChild(Effect.succeed("Hello"))
 *   yield* FiberMap.set(map, "greeting", fiber)
 *
 *   // Retrieve the fiber with error handling
 *   const retrieved = yield* FiberMap.get(map, "greeting")
 *   if (retrieved._tag === "Some") {
 *     const result = yield* Fiber.await(retrieved.value)
 *     console.log(result) // "Hello"
 *   }
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const get: {
  <K>(key: K): <A, E>(self: FiberMap<K, A, E>) => Effect.Effect<Option.Option<Fiber.Fiber<A, E>>>
  <K, A, E>(self: FiberMap<K, A, E>, key: K): Effect.Effect<Option.Option<Fiber.Fiber<A, E>>>
} = dual(
  2,
  <K, A, E>(self: FiberMap<K, A, E>, key: K): Effect.Effect<Option.Option<Fiber.Fiber<A, E>>> =>
    Effect.suspend(() => Effect.succeed(getUnsafe(self, key)))
)

/**
 * Check if a key exists in the FiberMap.
 *
 * @example
 * ```ts
 * import { Effect, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *
 *   // Add a fiber to the map
 *   yield* FiberMap.run(map, "task1", Effect.succeed("Hello"))
 *
 *   // Check if keys exist
 *   console.log(FiberMap.hasUnsafe(map, "task1")) // true
 *   console.log(FiberMap.hasUnsafe(map, "task2")) // false
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const hasUnsafe: {
  <K>(key: K): <A, E>(self: FiberMap<K, A, E>) => boolean
  <K, A, E>(self: FiberMap<K, A, E>, key: K): boolean
} = dual(
  2,
  <K, A, E>(self: FiberMap<K, A, E>, key: K): boolean =>
    self.state._tag === "Closed" ? false : MutableHashMap.has(self.state.backing, key)
)

/**
 * Check if a key exists in the FiberMap.
 * This is the Effect-wrapped version of `hasUnsafe`.
 *
 * @example
 * ```ts
 * import { Effect, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *
 *   // Add a fiber to the map
 *   yield* FiberMap.run(map, "task1", Effect.succeed("Hello"))
 *
 *   // Check if keys exist using Effect
 *   const exists1 = yield* FiberMap.has(map, "task1")
 *   const exists2 = yield* FiberMap.has(map, "task2")
 *
 *   console.log(exists1) // true
 *   console.log(exists2) // false
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const has: {
  <K>(key: K): <A, E>(self: FiberMap<K, A, E>) => Effect.Effect<boolean>
  <K, A, E>(self: FiberMap<K, A, E>, key: K): Effect.Effect<boolean>
} = dual(
  2,
  <K, A, E>(self: FiberMap<K, A, E>, key: K): Effect.Effect<boolean> => Effect.sync(() => hasUnsafe(self, key))
)

/**
 * Remove a fiber from the FiberMap, interrupting it if it exists.
 *
 * @example
 * ```ts
 * import { Effect, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *
 *   // Add some fibers to the map
 *   yield* FiberMap.run(map, "task1", Effect.never)
 *   yield* FiberMap.run(map, "task2", Effect.never)
 *
 *   console.log(yield* FiberMap.size(map)) // 2
 *
 *   // Remove a specific fiber (this will interrupt it)
 *   yield* FiberMap.remove(map, "task1")
 *
 *   console.log(yield* FiberMap.size(map)) // 1
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const remove: {
  <K>(key: K): <A, E>(self: FiberMap<K, A, E>) => Effect.Effect<void>
  <K, A, E>(self: FiberMap<K, A, E>, key: K): Effect.Effect<void>
} = dual<
  <K>(
    key: K
  ) => <A, E>(self: FiberMap<K, A, E>) => Effect.Effect<void>,
  <K, A, E>(
    self: FiberMap<K, A, E>,
    key: K
  ) => Effect.Effect<void>
>(2, (self, key) =>
  Effect.suspend(() => {
    if (self.state._tag === "Closed") {
      return Effect.void
    }
    const fiber = MutableHashMap.get(self.state.backing, key)
    if (fiber._tag === "None") {
      return Effect.void
    }
    return Fiber.interruptAs(fiber.value, internalFiberId)
  }))

/**
 * Remove all fibers from the FiberMap, interrupting them.
 *
 * @example
 * ```ts
 * import { Effect, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *
 *   // Add some fibers to the map
 *   yield* FiberMap.run(map, "task1", Effect.never)
 *   yield* FiberMap.run(map, "task2", Effect.never)
 *   yield* FiberMap.run(map, "task3", Effect.never)
 *
 *   console.log(yield* FiberMap.size(map)) // 3
 *
 *   // Clear all fibers (this will interrupt all of them)
 *   yield* FiberMap.clear(map)
 *
 *   console.log(yield* FiberMap.size(map)) // 0
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const clear = <K, A, E>(self: FiberMap<K, A, E>): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (self.state._tag === "Closed") {
      return Effect.void
    }
    return Fiber.interruptAllAs(MutableHashMap.values(self.state.backing), internalFiberId)
  })

const constInterruptedFiber = (function() {
  let fiber: Fiber.Fiber<never, never> | undefined = undefined
  return () => {
    if (fiber === undefined) {
      fiber = Effect.runFork(Effect.interrupt)
    }
    return fiber
  }
})()

/**
 * Run an Effect and add the forked fiber to the FiberMap.
 * When the fiber completes, it will be removed from the FiberMap.
 *
 * @example
 * ```ts
 * import { Effect, Fiber, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *
 *   // Run effects and add the fibers to the map
 *   const fiber1 = yield* FiberMap.run(map, "task1", Effect.succeed("Hello"))
 *   const fiber2 = yield* FiberMap.run(map, "task2", Effect.succeed("World"))
 *
 *   // Wait for the results
 *   const result1 = yield* Fiber.await(fiber1)
 *   const result2 = yield* Fiber.await(fiber2)
 *
 *   console.log(result1, result2) // "Hello", "World"
 *   console.log(yield* FiberMap.size(map)) // 0 (fibers are removed after completion)
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const run: {
  <K, A, E>(
    self: FiberMap<K, A, E>,
    key: K,
    options?: {
      readonly onlyIfMissing?: boolean | undefined
      readonly propagateInterruption?: boolean | undefined
      readonly startImmediately?: boolean | undefined
    } | undefined
  ): <R, XE extends E, XA extends A>(
    effect: Effect.Effect<XA, XE, R>
  ) => Effect.Effect<Fiber.Fiber<XA, XE>, never, R>
  <K, A, E, R, XE extends E, XA extends A>(
    self: FiberMap<K, A, E>,
    key: K,
    effect: Effect.Effect<XA, XE, R>,
    options?: {
      readonly onlyIfMissing?: boolean | undefined
      readonly propagateInterruption?: boolean | undefined
      readonly startImmediately?: boolean | undefined
    } | undefined
  ): Effect.Effect<Fiber.Fiber<XA, XE>, never, R>
} = function() {
  const self = arguments[0]
  if (Effect.isEffect(arguments[2])) {
    return runImpl(self, arguments[1], arguments[2], arguments[3]) as any
  }
  const key = arguments[1]
  const options = arguments[2]
  return (effect: Effect.Effect<any, any, any>) => runImpl(self, key, effect, options)
}

const runImpl = <K, A, E, R, XE extends E, XA extends A>(
  self: FiberMap<K, A, E>,
  key: K,
  effect: Effect.Effect<XA, XE, R>,
  options?: {
    readonly onlyIfMissing?: boolean
    readonly propagateInterruption?: boolean | undefined
  }
) =>
  Effect.withFiber((parent) => {
    if (self.state._tag === "Closed") {
      return Effect.interrupt
    } else if (options?.onlyIfMissing === true && hasUnsafe(self, key)) {
      return Effect.sync(constInterruptedFiber)
    }
    const fiber = Effect.runForkWith(parent.services as ServiceMap<R>)(effect)
    setUnsafe(self, key, fiber, options)
    return Effect.succeed(fiber)
  })

/**
 * Capture a Runtime and use it to fork Effect's, adding the forked fibers to the FiberMap.
 *
 * @example
 * ```ts
 * import { Effect, FiberMap, ServiceMap } from "effect"
 *
 * interface Users {
 *   readonly _: unique symbol
 * }
 * const Users = ServiceMap.Service<Users, {
 *   getAll: Effect.Effect<Array<unknown>>
 * }>("Users")
 *
 * Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *   const run = yield* FiberMap.runtime(map)<Users>()
 *
 *   // run some effects and add the fibers to the map
 *   run("effect-a", Effect.andThen(Users.asEffect(), (_) => _.getAll))
 *   run("effect-b", Effect.andThen(Users.asEffect(), (_) => _.getAll))
 * }).pipe(
 *   Effect.scoped // The fibers will be interrupted when the scope is closed
 * )
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const runtime: <K, A, E>(
  self: FiberMap<K, A, E>
) => <R = never>() => Effect.Effect<
  <XE extends E, XA extends A>(
    key: K,
    effect: Effect.Effect<XA, XE, R>,
    options?:
      | Effect.RunOptions & {
        readonly onlyIfMissing?: boolean | undefined
        readonly propagateInterruption?: boolean | undefined
      }
      | undefined
  ) => Fiber.Fiber<XA, XE>,
  never,
  R
> = <K, A, E>(self: FiberMap<K, A, E>) => <R>() =>
  Effect.map(
    Effect.services<R>(),
    (services) => {
      const runFork = Effect.runForkWith(services)
      return <XE extends E, XA extends A>(
        key: K,
        effect: Effect.Effect<XA, XE, R>,
        options?:
          | Effect.RunOptions & {
            readonly onlyIfMissing?: boolean | undefined
            readonly propagateInterruption?: boolean | undefined
          }
          | undefined
      ) => {
        if (self.state._tag === "Closed") {
          return constInterruptedFiber()
        } else if (options?.onlyIfMissing === true && hasUnsafe(self, key)) {
          return constInterruptedFiber()
        }
        const fiber = runFork(effect, options)
        setUnsafe(self, key, fiber, options)
        return fiber
      }
    }
  )

/**
 * Capture a Runtime and use it to fork Effect's, adding the forked fibers to the FiberMap.
 * Returns a Promise instead of a Fiber for convenience.
 *
 * @example
 * ```ts
 * import { Effect, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *   const runPromise = yield* FiberMap.runtimePromise(map)<never>()
 *
 *   // Create promises that will be backed by fibers in the map
 *   const promise1 = runPromise("task1", Effect.succeed("Hello"))
 *   const promise2 = runPromise("task2", Effect.succeed("World"))
 *
 *   // Convert promises back to Effects and await
 *   const result1 = yield* Effect.promise(() => promise1)
 *   const result2 = yield* Effect.promise(() => promise2)
 *
 *   console.log(result1, result2) // "Hello", "World"
 * })
 * ```
 *
 * @since 3.13.0
 * @category combinators
 */
export const runtimePromise = <K, A, E>(self: FiberMap<K, A, E>): <R = never>() => Effect.Effect<
  <XE extends E, XA extends A>(
    key: K,
    effect: Effect.Effect<XA, XE, R>,
    options?:
      | Effect.RunOptions & {
        readonly onlyIfMissing?: boolean | undefined
        readonly propagateInterruption?: boolean | undefined
      }
      | undefined
  ) => Promise<XA>,
  never,
  R
> =>
<R>() =>
  Effect.map(
    runtime(self)<R>(),
    (runFork) =>
    <XE extends E, XA extends A>(
      key: K,
      effect: Effect.Effect<XA, XE, R>,
      options?:
        | Effect.RunOptions & { readonly propagateInterruption?: boolean | undefined }
        | undefined
    ): Promise<XA> =>
      new Promise((resolve, reject) =>
        runFork(key, effect, options).addObserver((exit) => {
          if (Exit.isSuccess(exit)) {
            resolve(exit.value)
          } else {
            reject(Cause.squash(exit.cause))
          }
        })
      )
  )

/**
 * Get the number of fibers currently in the FiberMap.
 *
 * @example
 * ```ts
 * import { Effect, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *
 *   console.log(yield* FiberMap.size(map)) // 0
 *
 *   // Add some fibers
 *   yield* FiberMap.run(map, "task1", Effect.never)
 *   yield* FiberMap.run(map, "task2", Effect.never)
 *
 *   console.log(yield* FiberMap.size(map)) // 2
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const size = <K, A, E>(self: FiberMap<K, A, E>): Effect.Effect<number> =>
  Effect.sync(() => self.state._tag === "Closed" ? 0 : MutableHashMap.size(self.state.backing))

/**
 * Join all fibers in the FiberMap. If any of the Fiber's in the map terminate with a failure,
 * the returned Effect will terminate with the first failure that occurred.
 *
 * @example
 * ```ts
 * import { Effect, FiberMap } from "effect"
 *
 * Effect.gen(function*() {
 *   const map = yield* FiberMap.make()
 *   yield* FiberMap.set(map, "a", Effect.runFork(Effect.fail("error")))
 *
 *   // parent fiber will fail with "error"
 *   yield* FiberMap.join(map)
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const join = <K, A, E>(self: FiberMap<K, A, E>): Effect.Effect<void, E> =>
  Deferred.await(self.deferred as Deferred.Deferred<void, E>)

/**
 * Wait for the FiberMap to be empty.
 * This will wait for all currently running fibers to complete.
 *
 * @example
 * ```ts
 * import { Effect, FiberMap } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const map = yield* FiberMap.make<string>()
 *
 *   // Add some fibers that will complete after a delay
 *   yield* FiberMap.run(map, "task1", Effect.sleep(1000))
 *   yield* FiberMap.run(map, "task2", Effect.sleep(2000))
 *
 *   console.log("Waiting for all fibers to complete...")
 *
 *   // Wait for the map to be empty
 *   yield* FiberMap.awaitEmpty(map)
 *
 *   console.log("All fibers completed!")
 *   console.log(yield* FiberMap.size(map)) // 0
 * })
 * ```
 *
 * @since 3.13.0
 * @category combinators
 */
export const awaitEmpty = <K, A, E>(self: FiberMap<K, A, E>): Effect.Effect<void, E> =>
  Effect.whileLoop({
    while: () => self.state._tag === "Open" && MutableHashMap.size(self.state.backing) > 0,
    body: () => Fiber.await(Iterable.headUnsafe(self)[1]),
    step: constVoid
  })

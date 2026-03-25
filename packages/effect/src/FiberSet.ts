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
import type { Pipeable } from "./Pipeable.ts"
import * as Predicate from "./Predicate.ts"
import type * as Scope from "./Scope.ts"
import type { ServiceMap } from "./ServiceMap.ts"

const TypeId = "~effect/FiberSet"

/**
 * A FiberSet is a collection of fibers that can be managed together.
 * When the associated Scope is closed, all fibers in the set will be interrupted.
 *
 * @example
 * ```ts
 * import { Effect, FiberSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const set = yield* FiberSet.make<string, string>()
 *
 *   // Add fibers to the set
 *   yield* FiberSet.run(set, Effect.succeed("hello"))
 *   yield* FiberSet.run(set, Effect.succeed("world"))
 *
 *   // Wait for all fibers to complete
 *   yield* FiberSet.awaitEmpty(set)
 * })
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface FiberSet<out A = unknown, out E = unknown>
  extends Pipeable, Inspectable.Inspectable, Iterable<Fiber.Fiber<A, E>>
{
  readonly [TypeId]: typeof TypeId
  readonly deferred: Deferred.Deferred<void, unknown>
  state: {
    readonly _tag: "Open"
    readonly backing: Set<Fiber.Fiber<A, E>>
  } | {
    readonly _tag: "Closed"
  }
}

/**
 * Checks if a value is a FiberSet.
 *
 * @since 2.0.0
 * @category refinements
 * @example
 * ```ts
 * import { Effect, FiberSet } from "effect"
 *
 * Effect.gen(function*() {
 *   const set = yield* FiberSet.make()
 *
 *   console.log(FiberSet.isFiberSet(set)) // true
 *   console.log(FiberSet.isFiberSet({})) // false
 * })
 * ```
 */
export const isFiberSet = (u: unknown): u is FiberSet<unknown, unknown> => Predicate.hasProperty(u, TypeId)

const Proto = {
  [TypeId]: TypeId,
  [Symbol.iterator](this: FiberSet<unknown, unknown>) {
    if (this.state._tag === "Closed") {
      return Iterable.empty()
    }
    return this.state.backing[Symbol.iterator]()
  },
  ...PipeInspectableProto,
  toJSON(this: FiberSet<unknown, unknown>) {
    return {
      _id: "FiberMap",
      state: this.state
    }
  }
}

const makeUnsafe = <A, E>(
  backing: Set<Fiber.Fiber<A, E>>,
  deferred: Deferred.Deferred<void, unknown>
): FiberSet<A, E> => {
  const self = Object.create(Proto)
  self.state = { _tag: "Open", backing }
  self.deferred = deferred
  return self
}

/**
 * A FiberSet can be used to store a collection of fibers.
 * When the associated Scope is closed, all fibers in the set will be interrupted.
 *
 * You can add fibers to the set using `FiberSet.add` or `FiberSet.run`, and the fibers will
 * be automatically removed from the FiberSet when they complete.
 *
 * @example
 * ```ts
 * import { Effect, FiberSet } from "effect"
 *
 * Effect.gen(function*() {
 *   const set = yield* FiberSet.make()
 *
 *   // run some effects and add the fibers to the set
 *   yield* FiberSet.run(set, Effect.never)
 *   yield* FiberSet.run(set, Effect.never)
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
export const make = <A = unknown, E = unknown>(): Effect.Effect<FiberSet<A, E>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => makeUnsafe(new Set(), Deferred.makeUnsafe())),
    (set) =>
      Effect.suspend(() => {
        const state = set.state
        if (state._tag === "Closed") return Effect.void
        set.state = { _tag: "Closed" }
        const fibers = state.backing
        return Fiber.interruptAll(fibers).pipe(
          Deferred.into(set.deferred)
        )
      })
  )

/**
 * Create an Effect run function that is backed by a FiberSet.
 *
 * @since 2.0.0
 * @category constructors
 * @example
 * ```ts
 * import { Effect, Fiber, FiberSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const runFork = yield* FiberSet.makeRuntime()
 *
 *   // Fork effects using the runtime
 *   const fiber1 = runFork(Effect.succeed("hello"))
 *   const fiber2 = runFork(Effect.succeed("world"))
 *
 *   const result1 = yield* Fiber.await(fiber1)
 *   const result2 = yield* Fiber.await(fiber2)
 *
 *   console.log(result1, result2) // "hello" "world"
 * })
 * ```
 */
export const makeRuntime = <R = never, A = unknown, E = unknown>(): Effect.Effect<
  (<XE extends E, XA extends A>(
    effect: Effect.Effect<XA, XE, R>,
    options?: (Effect.RunOptions & { readonly propagateInterruption?: boolean | undefined }) | undefined
  ) => Fiber.Fiber<XA, XE>),
  never,
  Scope.Scope | R
> =>
  Effect.flatMap(
    make<A, E>(),
    (self) => runtime(self)<R>()
  )

/**
 * Create an Effect run function that is backed by a FiberSet.
 * The returned run function will return Promise's.
 *
 * @example
 * ```ts
 * import { Effect, FiberSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const runPromise = yield* FiberSet.makeRuntimePromise()
 *
 *   // Run effects as promises
 *   const promise1 = runPromise(Effect.succeed("hello"))
 *   const promise2 = runPromise(Effect.succeed("world"))
 *
 *   const result1 = yield* Effect.promise(() => promise1)
 *   const result2 = yield* Effect.promise(() => promise2)
 *
 *   console.log(result1, result2) // "hello" "world"
 * })
 * ```
 *
 * @since 3.13.0
 * @category constructors
 */
export const makeRuntimePromise = <R = never, A = unknown, E = unknown>(): Effect.Effect<
  (<XE extends E, XA extends A>(
    effect: Effect.Effect<XA, XE, R>,
    options?: (Effect.RunOptions & { readonly propagateInterruption?: boolean | undefined }) | undefined
  ) => Promise<XA>),
  never,
  R | Scope.Scope
> =>
  Effect.flatMap(
    make<A, E>(),
    (self) => runtimePromise(self)<R>()
  )

const internalFiberId = -1
const isInternalInterruption = Filter.toPredicate(Filter.compose(
  Cause.filterInterruptors,
  Filter.has(internalFiberId)
))

/**
 * Add a fiber to the FiberSet. When the fiber completes, it will be removed.
 * This is the unsafe version that doesn't return an Effect.
 *
 * @example
 * ```ts
 * import { Effect, FiberSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const set = yield* FiberSet.make()
 *   const fiber = yield* Effect.forkChild(Effect.succeed("hello"))
 *
 *   // Unsafe add - doesn't return an Effect
 *   FiberSet.addUnsafe(set, fiber)
 *
 *   // The fiber is now managed by the set
 *   console.log(yield* FiberSet.size(set)) // 1
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const addUnsafe: {
  <A, E, XE extends E, XA extends A>(
    fiber: Fiber.Fiber<XA, XE>,
    options?: {
      readonly propagateInterruption?: boolean | undefined
    } | undefined
  ): (self: FiberSet<A, E>) => void
  <A, E, XE extends E, XA extends A>(
    self: FiberSet<A, E>,
    fiber: Fiber.Fiber<XA, XE>,
    options?: {
      readonly propagateInterruption?: boolean | undefined
    } | undefined
  ): void
} = dual((args) => isFiberSet(args[0]), <A, E, XE extends E, XA extends A>(
  self: FiberSet<A, E>,
  fiber: Fiber.Fiber<XA, XE>,
  options?: {
    readonly propagateInterruption?: boolean | undefined
  } | undefined
): void => {
  if (self.state._tag === "Closed") {
    fiber.interruptUnsafe(internalFiberId)
    return
  } else if (self.state.backing.has(fiber)) {
    return
  }
  self.state.backing.add(fiber)
  fiber.addObserver((exit) => {
    if (self.state._tag === "Closed") {
      return
    }
    self.state.backing.delete(fiber)
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
 * Add a fiber to the FiberSet. When the fiber completes, it will be removed.
 *
 * @example
 * ```ts
 * import { Effect, FiberSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const set = yield* FiberSet.make()
 *   const fiber = yield* Effect.forkChild(Effect.succeed("hello"))
 *
 *   // Add the fiber to the set
 *   yield* FiberSet.add(set, fiber)
 *
 *   // The fiber is now managed by the set
 *   console.log(yield* FiberSet.size(set)) // 1
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const add: {
  <A, E, XE extends E, XA extends A>(
    fiber: Fiber.Fiber<XA, XE>,
    options?: {
      readonly propagateInterruption?: boolean | undefined
    } | undefined
  ): (self: FiberSet<A, E>) => Effect.Effect<void>
  <A, E, XE extends E, XA extends A>(
    self: FiberSet<A, E>,
    fiber: Fiber.Fiber<XA, XE>,
    options?: {
      readonly propagateInterruption?: boolean | undefined
    } | undefined
  ): Effect.Effect<void>
} = dual(
  (args) => isFiberSet(args[0]),
  <A, E, XE extends E, XA extends A>(
    self: FiberSet<A, E>,
    fiber: Fiber.Fiber<XA, XE>,
    options?: {
      readonly propagateInterruption?: boolean | undefined
    } | undefined
  ): Effect.Effect<void> => Effect.sync(() => addUnsafe(self, fiber, options))
)

/**
 * Interrupt all fibers in the FiberSet and clear the set.
 *
 * @example
 * ```ts
 * import { Effect, FiberSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const set = yield* FiberSet.make()
 *
 *   // Add some fibers
 *   yield* FiberSet.run(set, Effect.never)
 *   yield* FiberSet.run(set, Effect.never)
 *
 *   console.log(yield* FiberSet.size(set)) // 2
 *
 *   // Clear all fibers
 *   yield* FiberSet.clear(set)
 *
 *   console.log(yield* FiberSet.size(set)) // 0
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const clear = <A, E>(self: FiberSet<A, E>): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (self.state._tag === "Closed") {
      return Effect.void
    }
    return Fiber.interruptAllAs(self.state.backing, internalFiberId)
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
 * Fork an Effect and add the forked fiber to the FiberSet.
 * When the fiber completes, it will be removed from the FiberSet.
 *
 * @example
 * ```ts
 * import { Effect, Fiber, FiberSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const set = yield* FiberSet.make()
 *
 *   // Fork and add to set
 *   const fiber1 = yield* FiberSet.run(set, Effect.succeed("hello"))
 *   const fiber2 = yield* FiberSet.run(set, Effect.succeed("world"))
 *
 *   // Get results
 *   const result1 = yield* Fiber.await(fiber1)
 *   const result2 = yield* Fiber.await(fiber2)
 *
 *   console.log(result1, result2) // "hello" "world"
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const run: {
  <A, E>(
    self: FiberSet<A, E>,
    options?: {
      readonly propagateInterruption?: boolean | undefined
      readonly startImmediately?: boolean | undefined
    } | undefined
  ): <R, XE extends E, XA extends A>(
    effect: Effect.Effect<XA, XE, R>
  ) => Effect.Effect<Fiber.Fiber<XA, XE>, never, R>
  <A, E, R, XE extends E, XA extends A>(
    self: FiberSet<A, E>,
    effect: Effect.Effect<XA, XE, R>,
    options?: {
      readonly propagateInterruption?: boolean | undefined
      readonly startImmediately?: boolean | undefined
    } | undefined
  ): Effect.Effect<Fiber.Fiber<XA, XE>, never, R>
} = function() {
  const self = arguments[0] as FiberSet<any, any>
  if (!Effect.isEffect(arguments[1])) {
    const options = arguments[1]
    return (effect: Effect.Effect<any, any, any>) => runImpl(self, effect, options)
  }
  return runImpl(self, arguments[1], arguments[2]) as any
}

const runImpl = <A, E, R, XE extends E, XA extends A>(
  self: FiberSet<A, E>,
  effect: Effect.Effect<XA, XE, R>,
  options?: {
    readonly propagateInterruption?: boolean | undefined
  }
): Effect.Effect<Fiber.Fiber<XA, XE>, never, R> =>
  Effect.withFiber((parent) => {
    if (self.state._tag === "Closed") {
      return Effect.sync(constInterruptedFiber)
    }
    const fiber = Effect.runForkWith(parent.services as ServiceMap<R>)(effect)
    addUnsafe(self, fiber, options)
    return Effect.succeed(fiber)
  })

/**
 * Capture a Runtime and use it to fork Effect's, adding the forked fibers to the FiberSet.
 *
 * @example
 * ```ts
 * import { Effect, FiberSet, ServiceMap } from "effect"
 *
 * interface Users {
 *   readonly _: unique symbol
 * }
 * const Users = ServiceMap.Service<Users, {
 *   getAll: Effect.Effect<Array<unknown>>
 * }>("Users")
 *
 * Effect.gen(function*() {
 *   const set = yield* FiberSet.make()
 *   const run = yield* FiberSet.runtime(set)<Users>()
 *
 *   // run some effects and add the fibers to the set
 *   run(Effect.andThen(Users.asEffect(), (_) => _.getAll))
 * }).pipe(
 *   Effect.scoped // The fibers will be interrupted when the scope is closed
 * )
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const runtime: <A, E>(
  self: FiberSet<A, E>
) => <R = never>() => Effect.Effect<
  <XE extends E, XA extends A>(
    effect: Effect.Effect<XA, XE, R>,
    options?:
      | Effect.RunOptions & { readonly propagateInterruption?: boolean | undefined }
      | undefined
  ) => Fiber.Fiber<XA, XE>,
  never,
  R
> = <A, E>(self: FiberSet<A, E>) => <R>() =>
  Effect.map(
    Effect.services<R>(),
    (services) => {
      const runFork = Effect.runForkWith(services)
      return <XE extends E, XA extends A>(
        effect: Effect.Effect<XA, XE, R>,
        options?:
          | Effect.RunOptions & { readonly propagateInterruption?: boolean | undefined }
          | undefined
      ) => {
        if (self.state._tag === "Closed") {
          return constInterruptedFiber()
        }
        const fiber = runFork(effect, options)
        addUnsafe(self, fiber)
        return fiber
      }
    }
  )

/**
 * Capture a Runtime and use it to fork Effect's, adding the forked fibers to the FiberSet.
 *
 * The returned run function will return Promise's.
 *
 * @example
 * ```ts
 * import { Effect, FiberSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const set = yield* FiberSet.make()
 *   const runPromise = yield* FiberSet.runtimePromise(set)()
 *
 *   // Run effects as promises
 *   const promise1 = runPromise(Effect.succeed("hello"))
 *   const promise2 = runPromise(Effect.succeed("world"))
 *
 *   const result1 = yield* Effect.promise(() => promise1)
 *   const result2 = yield* Effect.promise(() => promise2)
 *
 *   console.log(result1, result2) // "hello" "world"
 * })
 * ```
 *
 * @since 3.13.0
 * @category combinators
 */
export const runtimePromise = <A, E>(self: FiberSet<A, E>): <R = never>() => Effect.Effect<
  <XE extends E, XA extends A>(
    effect: Effect.Effect<XA, XE, R>,
    options?:
      | Effect.RunOptions & { readonly propagateInterruption?: boolean | undefined }
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
      effect: Effect.Effect<XA, XE, R>,
      options?:
        | Effect.RunOptions & { readonly propagateInterruption?: boolean | undefined }
        | undefined
    ): Promise<XA> =>
      new Promise((resolve, reject) =>
        runFork(effect, options).addObserver((exit) => {
          if (Exit.isSuccess(exit)) {
            resolve(exit.value)
          } else {
            reject(Cause.squash(exit.cause))
          }
        })
      )
  )

/**
 * Get the number of fibers currently in the FiberSet.
 *
 * @example
 * ```ts
 * import { Effect, FiberSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const set = yield* FiberSet.make()
 *
 *   console.log(yield* FiberSet.size(set)) // 0
 *
 *   // Add some fibers
 *   yield* FiberSet.run(set, Effect.never)
 *   yield* FiberSet.run(set, Effect.never)
 *
 *   console.log(yield* FiberSet.size(set)) // 2
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const size = <A, E>(self: FiberSet<A, E>): Effect.Effect<number> =>
  Effect.sync(() => self.state._tag === "Closed" ? 0 : self.state.backing.size)

/**
 * Join all fibers in the FiberSet. If any of the Fiber's in the set terminate with a failure,
 * the returned Effect will terminate with the first failure that occurred.
 *
 * @example
 * ```ts
 * import { Effect, FiberSet } from "effect"
 *
 * Effect.gen(function*() {
 *   const set = yield* FiberSet.make()
 *   yield* FiberSet.add(set, Effect.runFork(Effect.fail("error")))
 *
 *   // parent fiber will fail with "error"
 *   yield* FiberSet.join(set)
 * })
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const join = <A, E>(self: FiberSet<A, E>): Effect.Effect<void, E> =>
  Deferred.await(self.deferred as Deferred.Deferred<void, E>)

/**
 * Wait until the fiber set is empty.
 *
 * @example
 * ```ts
 * import { Effect, FiberSet } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const set = yield* FiberSet.make()
 *
 *   // Add some fibers that will complete
 *   yield* FiberSet.run(set, Effect.sleep(100))
 *   yield* FiberSet.run(set, Effect.sleep(200))
 *
 *   // Wait for all fibers to complete
 *   yield* FiberSet.awaitEmpty(set)
 *
 *   console.log(yield* FiberSet.size(set)) // 0
 * })
 * ```
 *
 * @since 3.13.0
 * @category combinators
 */
export const awaitEmpty = <A, E>(self: FiberSet<A, E>): Effect.Effect<void> =>
  Effect.whileLoop({
    while: () => self.state._tag === "Open" && self.state.backing.size > 0,
    body: () => Fiber.await(Iterable.headUnsafe(self)),
    step: constVoid
  })

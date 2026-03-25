/**
 * @since 2.0.0
 */
import * as Effect from "./Effect.ts"
import { dual, identity } from "./Function.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import * as PubSub from "./PubSub.ts"
import * as Semaphore from "./Semaphore.ts"
import * as Stream from "./Stream.ts"
import type { Invariant } from "./Types.ts"

const TypeId = "~effect/SubscriptionRef"

/**
 * @since 2.0.0
 * @category models
 */
export interface SubscriptionRef<in out A> extends SubscriptionRef.Variance<A>, Pipeable {
  value: A
  readonly semaphore: Semaphore.Semaphore
  readonly pubsub: PubSub.PubSub<A>
}

/**
 * @since 4.0.0
 * @category guards
 */
export const isSubscriptionRef: (u: unknown) => u is SubscriptionRef<unknown> = (
  u: unknown
): u is SubscriptionRef<unknown> => hasProperty(u, TypeId)

/**
 * The `SynchronizedRef` namespace containing type definitions and utilities.
 *
 * @since 2.0.0
 */
export declare namespace SubscriptionRef {
  /**
   * @since 2.0.0
   * @category models
   */
  export interface Variance<in out A> {
    readonly [TypeId]: {
      readonly _A: Invariant<A>
    }
  }
}

const Proto = {
  ...PipeInspectableProto,
  [TypeId]: {
    _A: identity
  },
  toJSON(this: SubscriptionRef<unknown>) {
    return {
      _id: "SubscriptionRef",
      value: this.value
    }
  }
}

/**
 * Constructs a new `SubscriptionRef` from an initial value.
 *
 * @since 2.0.0
 * @category constructors
 */
export const make = <A>(value: A): Effect.Effect<SubscriptionRef<A>> =>
  Effect.map(PubSub.unbounded<A>({ replay: 1 }), (pubsub) => {
    const self = Object.create(Proto)
    self.semaphore = Semaphore.makeUnsafe(1)
    self.value = value
    self.pubsub = pubsub
    PubSub.publishUnsafe(self.pubsub, value)
    return self
  })

/**
 * Creates a stream that emits the current value and all subsequent changes to
 * the `SubscriptionRef`.
 *
 * The stream will first emit the current value, then emit all future changes
 * as they occur.
 *
 * @example
 * ```ts
 * import { Effect, Stream, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(0)
 *
 *   const stream = SubscriptionRef.changes(ref)
 *
 *   const fiber = yield* Stream.runForEach(
 *     stream,
 *     (value) => Effect.sync(() => console.log("Value:", value))
 *   ).pipe(Effect.forkScoped)
 *
 *   yield* SubscriptionRef.set(ref, 1)
 *   yield* SubscriptionRef.set(ref, 2)
 * })
 * ```
 *
 * @category changes
 * @since 2.0.0
 */
export const changes = <A>(self: SubscriptionRef<A>): Stream.Stream<A> => Stream.fromPubSub(self.pubsub)

/**
 * Unsafely retrieves the current value of the `SubscriptionRef`.
 *
 * This function directly accesses the underlying reference without any
 * synchronization. It should only be used when you're certain there are no
 * concurrent modifications.
 *
 * @example
 * ```ts
 * import { Effect, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(42)
 *
 *   const value = SubscriptionRef.getUnsafe(ref)
 *   console.log(value)
 * })
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const getUnsafe = <A>(self: SubscriptionRef<A>): A => self.value

/**
 * Retrieves the current value of the `SubscriptionRef`.
 *
 * @example
 * ```ts
 * import { Effect, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(42)
 *
 *   const value = yield* SubscriptionRef.get(ref)
 *   console.log(value)
 * })
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const get = <A>(self: SubscriptionRef<A>): Effect.Effect<A> => Effect.sync(() => self.value)

/**
 * Atomically retrieves the current value and sets a new value, notifying
 * subscribers of the change.
 *
 * @example
 * ```ts
 * import { Effect, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   const oldValue = yield* SubscriptionRef.getAndSet(ref, 20)
 *   console.log("Old value:", oldValue)
 *
 *   const newValue = yield* SubscriptionRef.get(ref)
 *   console.log("New value:", newValue)
 * })
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const getAndSet: {
  <A>(value: A): (self: SubscriptionRef<A>) => Effect.Effect<A>
  <A>(self: SubscriptionRef<A>, value: A): Effect.Effect<A>
} = dual(2, <A>(self: SubscriptionRef<A>, value: A) =>
  self.semaphore.withPermit(Effect.sync(() => {
    const current = self.value
    setUnsafe(self, value)
    return current
  })))

const setUnsafe = <A>(self: SubscriptionRef<A>, value: A) => {
  self.value = value
  PubSub.publishUnsafe(self.pubsub, value)
}

/**
 * Atomically retrieves the current value and updates it with the result of
 * applying a function, notifying subscribers of the change.
 *
 * @example
 * ```ts
 * import { Effect, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   const oldValue = yield* SubscriptionRef.getAndUpdate(ref, (n) => n * 2)
 *   console.log("Old value:", oldValue)
 *
 *   const newValue = yield* SubscriptionRef.get(ref)
 *   console.log("New value:", newValue)
 * })
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const getAndUpdate: {
  <A>(update: (a: A) => A): (self: SubscriptionRef<A>) => Effect.Effect<A>
  <A>(self: SubscriptionRef<A>, update: (a: A) => A): Effect.Effect<A>
} = dual(2, <A>(self: SubscriptionRef<A>, update: (a: A) => A) =>
  self.semaphore.withPermit(Effect.sync(() => {
    const current = self.value
    const newValue = update(current)
    setUnsafe(self, newValue)
    return current
  })))

/**
 * Atomically retrieves the current value and updates it with the result of
 * applying an effectful function, notifying subscribers of the change.
 *
 * @example
 * ```ts
 * import { Effect, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   const oldValue = yield* SubscriptionRef.getAndUpdateEffect(
 *     ref,
 *     (n) => Effect.succeed(n + 5)
 *   )
 *   console.log("Old value:", oldValue)
 *
 *   const newValue = yield* SubscriptionRef.get(ref)
 *   console.log("New value:", newValue)
 * })
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const getAndUpdateEffect: {
  <A, E, R>(update: (a: A) => Effect.Effect<A, E, R>): (self: SubscriptionRef<A>) => Effect.Effect<A, E, R>
  <A, E, R>(self: SubscriptionRef<A>, update: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = dual(2, <A, E, R>(
  self: SubscriptionRef<A>,
  update: (a: A) => Effect.Effect<A, E, R>
) =>
  self.semaphore.withPermit(Effect.sync(() => {
    const current = self.value
    return Effect.map(update(current), (newValue) => {
      setUnsafe(self, newValue)
      return current
    })
  })))

/**
 * Atomically retrieves the current value and optionally updates it with the
 * result of applying a function that returns an `Option`, notifying
 * subscribers only if the value changes.
 *
 * @example
 * ```ts
 * import { Effect, Option, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   const oldValue = yield* SubscriptionRef.getAndUpdateSome(
 *     ref,
 *     (n) => n > 5 ? Option.some(n * 2) : Option.none()
 *   )
 *   console.log("Old value:", oldValue)
 *
 *   const newValue = yield* SubscriptionRef.get(ref)
 *   console.log("New value:", newValue)
 * })
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const getAndUpdateSome: {
  <A>(update: (a: A) => Option.Option<A>): (self: SubscriptionRef<A>) => Effect.Effect<A>
  <A>(self: SubscriptionRef<A>, update: (a: A) => Option.Option<A>): Effect.Effect<A>
} = dual(2, <A>(
  self: SubscriptionRef<A>,
  update: (a: A) => Option.Option<A>
) =>
  self.semaphore.withPermit(Effect.sync(() => {
    const current = self.value
    const option = update(current)
    if (Option.isNone(option)) {
      return Effect.succeed(current)
    }
    setUnsafe(self, option.value)
    return current
  })))

/**
 * Atomically retrieves the current value and optionally updates it with the
 * result of applying an effectful function that returns an `Option`,
 * notifying subscribers only if the value changes.
 *
 * @example
 * ```ts
 * import { Effect, Option, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   const oldValue = yield* SubscriptionRef.getAndUpdateSomeEffect(
 *     ref,
 *     (n) => Effect.succeed(n > 5 ? Option.some(n + 3) : Option.none())
 *   )
 *   console.log("Old value:", oldValue)
 *
 *   const newValue = yield* SubscriptionRef.get(ref)
 *   console.log("New value:", newValue)
 * })
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const getAndUpdateSomeEffect: {
  <A, R, E>(
    update: (a: A) => Effect.Effect<Option.Option<A>, E, R>
  ): (self: SubscriptionRef<A>) => Effect.Effect<A, E, R>
  <A, R, E>(
    self: SubscriptionRef<A>,
    update: (a: A) => Effect.Effect<Option.Option<A>, E, R>
  ): Effect.Effect<A, E, R>
} = dual(2, <A, R, E>(
  self: SubscriptionRef<A>,
  update: (a: A) => Effect.Effect<Option.Option<A>, E, R>
) =>
  self.semaphore.withPermit(Effect.suspend(() => {
    const current = self.value
    return Effect.map(update(current), (option) => {
      if (Option.isNone(option)) return current
      setUnsafe(self, option.value)
      return current
    })
  })))

/**
 * Atomically modifies the `SubscriptionRef` with a function that computes a
 * return value and a new value, notifying subscribers of the change.
 *
 * @example
 * ```ts
 * import { Effect, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   const result = yield* SubscriptionRef.modify(ref, (n) => [
 *     `Old value was ${n}`,
 *     n * 2
 *   ])
 *   console.log(result)
 *
 *   const newValue = yield* SubscriptionRef.get(ref)
 *   console.log("New value:", newValue)
 * })
 * ```
 *
 * @since 2.0.0
 * @category modifications
 */
export const modify: {
  <A, B>(modify: (a: A) => readonly [B, A]): (self: SubscriptionRef<A>) => Effect.Effect<B>
  <A, B>(self: SubscriptionRef<A>, f: (a: A) => readonly [B, A]): Effect.Effect<B>
} = dual(2, <A, B>(
  self: SubscriptionRef<A>,
  modify: (a: A) => readonly [B, A]
) =>
  self.semaphore.withPermit(Effect.sync(() => {
    const [b, newValue] = modify(self.value)
    setUnsafe(self, newValue)
    return b
  })))

/**
 * Atomically modifies the `SubscriptionRef` with an effectful function that
 * computes a return value and a new value, notifying subscribers of the
 * change.
 *
 * @example
 * ```ts
 * import { Effect, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   const result = yield* SubscriptionRef.modifyEffect(
 *     ref,
 *     (n) => Effect.succeed([`Doubled from ${n}`, n * 2] as const)
 *   )
 *   console.log(result)
 *
 *   const newValue = yield* SubscriptionRef.get(ref)
 *   console.log("New value:", newValue)
 * })
 * ```
 *
 * @since 2.0.0
 * @category modifications
 */
export const modifyEffect: {
  <B, A, E, R>(
    modify: (a: A) => Effect.Effect<readonly [B, A], E, R>
  ): (self: SubscriptionRef<A>) => Effect.Effect<B, E, R>
  <A, B, E, R>(
    self: SubscriptionRef<A>,
    modify: (a: A) => Effect.Effect<readonly [B, A], E, R>
  ): Effect.Effect<B, E, R>
} = dual(2, <A, B, E, R>(
  self: SubscriptionRef<A>,
  modify: (a: A) => Effect.Effect<readonly [B, A], E, R>
): Effect.Effect<B, E, R> =>
  self.semaphore.withPermit(Effect.suspend(() =>
    Effect.map(modify(self.value), ([b, newValue]) => {
      setUnsafe(self, newValue)
      return b
    })
  )))

/**
 * Atomically modifies the `SubscriptionRef` with a function that computes a
 * return value and optionally a new value, notifying subscribers only if the
 * value changes.
 *
 * @example
 * ```ts
 * import { Effect, Option, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   const result = yield* SubscriptionRef.modifySome(
 *     ref,
 *     (n) =>
 *       n > 5 ? ["Updated", Option.some(n * 2)] : ["Not updated", Option.none()]
 *   )
 *   console.log(result)
 *
 *   const newValue = yield* SubscriptionRef.get(ref)
 *   console.log("New value:", newValue)
 * })
 * ```
 *
 * @since 2.0.0
 * @category modifications
 */
export const modifySome: {
  <B, A>(
    modify: (a: A) => readonly [B, Option.Option<A>]
  ): (self: SubscriptionRef<A>) => Effect.Effect<B>
  <A, B>(
    self: SubscriptionRef<A>,
    modify: (a: A) => readonly [B, Option.Option<A>]
  ): Effect.Effect<B>
} = dual(2, <A, B>(
  self: SubscriptionRef<A>,
  modify: (a: A) => readonly [B, Option.Option<A>]
) =>
  self.semaphore.withPermit(Effect.sync(() => {
    const [b, option] = modify(self.value)
    if (Option.isNone(option)) return b
    setUnsafe(self, option.value)
    return b
  })))

/**
 * Atomically modifies the `SubscriptionRef` with an effectful function that
 * computes a return value and optionally a new value, notifying subscribers
 * only if the value changes.
 *
 * @example
 * ```ts
 * import { Effect, Option, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   const result = yield* SubscriptionRef.modifySomeEffect(
 *     ref,
 *     (n) =>
 *       Effect.succeed(
 *         n > 5
 *           ? (["Updated", Option.some(n + 5)] as const)
 *           : (["Not updated", Option.none()] as const)
 *       )
 *   )
 *   console.log(result)
 *
 *   const newValue = yield* SubscriptionRef.get(ref)
 *   console.log("New value:", newValue)
 * })
 * ```
 *
 * @since 2.0.0
 * @category modifications
 */
export const modifySomeEffect: {
  <A, B, R, E>(
    modify: (a: A) => Effect.Effect<readonly [B, Option.Option<A>], E, R>
  ): (self: SubscriptionRef<A>) => Effect.Effect<B, E, R>
  <A, B, R, E>(
    self: SubscriptionRef<A>,
    modify: (a: A) => Effect.Effect<readonly [B, Option.Option<A>], E, R>
  ): Effect.Effect<B, E, R>
} = dual(2, <A, B, R, E>(
  self: SubscriptionRef<A>,
  modify: (a: A) => Effect.Effect<readonly [B, Option.Option<A>], E, R>
) =>
  self.semaphore.withPermit(Effect.suspend(() =>
    Effect.map(modify(self.value), ([b, option]) => {
      if (Option.isNone(option)) return b
      setUnsafe(self, option.value)
      return b
    })
  )))

/**
 * Sets the value of the `SubscriptionRef`, notifying all subscribers of the
 * change.
 *
 * @example
 * ```ts
 * import { Effect, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(0)
 *
 *   yield* SubscriptionRef.set(ref, 42)
 *
 *   const value = yield* SubscriptionRef.get(ref)
 *   console.log(value)
 * })
 * ```
 *
 * @since 2.0.0
 * @category setters
 */
export const set: {
  <A>(value: A): (self: SubscriptionRef<A>) => Effect.Effect<void>
  <A>(self: SubscriptionRef<A>, value: A): Effect.Effect<void>
} = dual(
  2,
  <A>(self: SubscriptionRef<A>, value: A) => self.semaphore.withPermit(Effect.sync(() => setUnsafe(self, value)))
)

/**
 * Sets the value of the `SubscriptionRef` and returns the new value,
 * notifying all subscribers of the change.
 *
 * @example
 * ```ts
 * import { Effect, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(0)
 *
 *   const newValue = yield* SubscriptionRef.setAndGet(ref, 42)
 *   console.log("New value:", newValue)
 * })
 * ```
 *
 * @since 2.0.0
 * @category setters
 */
export const setAndGet: {
  <A>(value: A): (self: SubscriptionRef<A>) => Effect.Effect<A>
  <A>(self: SubscriptionRef<A>, value: A): Effect.Effect<A>
} = dual(2, <A>(self: SubscriptionRef<A>, value: A) =>
  self.semaphore.withPermit(Effect.sync(() => {
    setUnsafe(self, value)
    return value
  })))

/**
 * Updates the value of the `SubscriptionRef` with the result of applying a
 * function, notifying subscribers of the change.
 *
 * @example
 * ```ts
 * import { Effect, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   yield* SubscriptionRef.update(ref, (n) => n * 2)
 *
 *   const value = yield* SubscriptionRef.get(ref)
 *   console.log(value)
 * })
 * ```
 *
 * @since 2.0.0
 * @category updating
 */
export const update: {
  <A>(update: (a: A) => A): (self: SubscriptionRef<A>) => Effect.Effect<void>
  <A>(self: SubscriptionRef<A>, update: (a: A) => A): Effect.Effect<void>
} = dual(
  2,
  <A>(self: SubscriptionRef<A>, update: (a: A) => A) =>
    self.semaphore.withPermit(Effect.sync(() => setUnsafe(self, update(self.value))))
)

/**
 * Updates the value of the `SubscriptionRef` with the result of applying an
 * effectful function, notifying subscribers of the change.
 *
 * @example
 * ```ts
 * import { Effect, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   yield* SubscriptionRef.updateEffect(ref, (n) => Effect.succeed(n + 5))
 *
 *   const value = yield* SubscriptionRef.get(ref)
 *   console.log(value)
 * })
 * ```
 *
 * @since 2.0.0
 * @category updating
 */
export const updateEffect: {
  <A, E, R>(update: (a: A) => Effect.Effect<A, E, R>): (self: SubscriptionRef<A>) => Effect.Effect<void, E, R>
  <A, E, R>(self: SubscriptionRef<A>, update: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<void, E, R>
} = dual(2, <A, E, R>(
  self: SubscriptionRef<A>,
  update: (a: A) => Effect.Effect<A, E, R>
) =>
  self.semaphore.withPermit(
    Effect.suspend(() => Effect.map(update(self.value), (newValue) => setUnsafe(self, newValue)))
  ))

/**
 * Updates the value of the `SubscriptionRef` with the result of applying a
 * function and returns the new value, notifying subscribers of the change.
 *
 * @example
 * ```ts
 * import { Effect, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   const newValue = yield* SubscriptionRef.updateAndGet(ref, (n) => n * 2)
 *   console.log("New value:", newValue)
 * })
 * ```
 *
 * @since 2.0.0
 * @category updating
 */
export const updateAndGet: {
  <A>(update: (a: A) => A): (self: SubscriptionRef<A>) => Effect.Effect<A>
  <A>(self: SubscriptionRef<A>, update: (a: A) => A): Effect.Effect<A>
} = dual(2, <A>(self: SubscriptionRef<A>, update: (a: A) => A) =>
  self.semaphore.withPermit(Effect.sync(() => {
    const newValue = update(self.value)
    setUnsafe(self, newValue)
    return newValue
  })))

/**
 * Updates the value of the `SubscriptionRef` with the result of applying an
 * effectful function and returns the new value, notifying subscribers of the
 * change.
 *
 * @example
 * ```ts
 * import { Effect, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   const newValue = yield* SubscriptionRef.updateAndGetEffect(
 *     ref,
 *     (n) => Effect.succeed(n + 5)
 *   )
 *   console.log("New value:", newValue)
 * })
 * ```
 *
 * @since 2.0.0
 * @category updating
 */
export const updateAndGetEffect: {
  <A, E, R>(update: (a: A) => Effect.Effect<A, E, R>): (self: SubscriptionRef<A>) => Effect.Effect<A, E, R>
  <A, E, R>(self: SubscriptionRef<A>, update: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = dual(2, <A, E, R>(
  self: SubscriptionRef<A>,
  update: (a: A) => Effect.Effect<A, E, R>
) =>
  self.semaphore.withPermit(Effect.suspend(() =>
    Effect.map(update(self.value), (newValue) => {
      setUnsafe(self, newValue)
      return newValue
    })
  )))

/**
 * Optionally updates the value of the `SubscriptionRef` with the result of
 * applying a function that returns an `Option`, notifying subscribers only if
 * the value changes.
 *
 * @example
 * ```ts
 * import { Effect, Option, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   yield* SubscriptionRef.updateSome(
 *     ref,
 *     (n) => n > 5 ? Option.some(n * 2) : Option.none()
 *   )
 *
 *   const value = yield* SubscriptionRef.get(ref)
 *   console.log(value)
 * })
 * ```
 *
 * @since 2.0.0
 * @category updating
 */
export const updateSome: {
  <A>(update: (a: A) => Option.Option<A>): (self: SubscriptionRef<A>) => Effect.Effect<void>
  <A>(self: SubscriptionRef<A>, update: (a: A) => Option.Option<A>): Effect.Effect<void>
} = dual(2, <A>(
  self: SubscriptionRef<A>,
  update: (a: A) => Option.Option<A>
) =>
  self.semaphore.withPermit(Effect.sync(() => {
    const option = update(self.value)
    if (Option.isNone(option)) return
    setUnsafe(self, option.value)
  })))

/**
 * Optionally updates the value of the `SubscriptionRef` with the result of
 * applying an effectful function that returns an `Option`, notifying
 * subscribers only if the value changes.
 *
 * @example
 * ```ts
 * import { Effect, Option, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   yield* SubscriptionRef.updateSomeEffect(
 *     ref,
 *     (n) => Effect.succeed(n > 5 ? Option.some(n + 3) : Option.none())
 *   )
 *
 *   const value = yield* SubscriptionRef.get(ref)
 *   console.log(value)
 * })
 * ```
 *
 * @since 2.0.0
 * @category updating
 */
export const updateSomeEffect: {
  <A, E, R>(
    update: (a: A) => Effect.Effect<Option.Option<A>, E, R>
  ): (self: SubscriptionRef<A>) => Effect.Effect<void, E, R>
  <A, E, R>(
    self: SubscriptionRef<A>,
    update: (a: A) => Effect.Effect<Option.Option<A>, E, R>
  ): Effect.Effect<void, E, R>
} = dual(2, <A, R, E>(
  self: SubscriptionRef<A>,
  update: (a: A) => Effect.Effect<Option.Option<A>, E, R>
) =>
  self.semaphore.withPermit(Effect.suspend(() =>
    Effect.map(update(self.value), (option) => {
      if (Option.isNone(option)) return
      setUnsafe(self, option.value)
    })
  )))

/**
 * Optionally updates the value of the `SubscriptionRef` with the result of
 * applying a function that returns an `Option` and returns the new value,
 * notifying subscribers only if the value changes.
 *
 * @example
 * ```ts
 * import { Effect, Option, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   const newValue = yield* SubscriptionRef.updateSomeAndGet(
 *     ref,
 *     (n) => n > 5 ? Option.some(n * 2) : Option.none()
 *   )
 *   console.log("New value:", newValue)
 * })
 * ```
 *
 * @since 2.0.0
 * @category updating
 */
export const updateSomeAndGet: {
  <A>(update: (a: A) => Option.Option<A>): (self: SubscriptionRef<A>) => Effect.Effect<A>
  <A>(self: SubscriptionRef<A>, update: (a: A) => Option.Option<A>): Effect.Effect<A>
} = dual(2, <A>(
  self: SubscriptionRef<A>,
  update: (a: A) => Option.Option<A>
) =>
  self.semaphore.withPermit(Effect.sync(() => {
    const current = self.value
    const option = update(current)
    if (Option.isNone(option)) return current
    setUnsafe(self, option.value)
    return option.value
  })))

/**
 * Optionally updates the value of the `SubscriptionRef` with the result of
 * applying an effectful function that returns an `Option` and returns the new
 * value, notifying subscribers only if the value changes.
 *
 * @example
 * ```ts
 * import { Effect, Option, SubscriptionRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* SubscriptionRef.make(10)
 *
 *   const newValue = yield* SubscriptionRef.updateSomeAndGetEffect(
 *     ref,
 *     (n) => Effect.succeed(n > 5 ? Option.some(n + 3) : Option.none())
 *   )
 *   console.log("New value:", newValue)
 * })
 * ```
 *
 * @since 2.0.0
 * @category updating
 */
export const updateSomeAndGetEffect: {
  <A, E, R>(
    update: (a: A) => Effect.Effect<Option.Option<A>, E, R>
  ): (self: SubscriptionRef<A>) => Effect.Effect<A, E, R>
  <A, E, R>(self: SubscriptionRef<A>, update: (a: A) => Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<A, E, R>
} = dual(2, <A, E, R>(
  self: SubscriptionRef<A>,
  update: (a: A) => Effect.Effect<Option.Option<A>, E, R>
) =>
  self.semaphore.withPermit(Effect.suspend(() => {
    const current = self.value
    return Effect.map(update(current), (option) => {
      if (Option.isNone(option)) return current
      setUnsafe(self, option.value)
      return option.value
    })
  })))

/**
 * This module provides utilities for working with mutable references in a functional context.
 *
 * A Ref is a mutable reference that can be read, written, and atomically modified. Unlike plain
 * mutable variables, Refs are thread-safe and work seamlessly with Effect's concurrency model.
 * They provide atomic operations for safe state management in concurrent programs.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a ref with initial value
 *   const counter = yield* Ref.make(0)
 *
 *   // Atomic operations
 *   yield* Ref.update(counter, (n) => n + 1)
 *   yield* Ref.update(counter, (n) => n * 2)
 *
 *   const value = yield* Ref.get(counter)
 *   console.log(value) // 2
 *
 *   // Atomic modify with return value
 *   const previous = yield* Ref.getAndSet(counter, 100)
 *   console.log(previous) // 2
 * })
 * ```
 *
 * @since 2.0.0
 */
import * as Effect from "./Effect.ts"
import { dual, identity } from "./Function.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import * as MutableRef from "./MutableRef.ts"
import type * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import type { Invariant } from "./Types.ts"

const TypeId = "~effect/Ref"

/**
 * A mutable reference that provides atomic read, write, and update operations.
 *
 * Ref is a thread-safe mutable reference type that allows for atomic operations
 * on shared state. It supports both simple read/write operations and complex
 * atomic transformations.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a ref with initial value
 *   const counter = yield* Ref.make(0)
 *
 *   // Read the current value
 *   const value = yield* Ref.get(counter)
 *   console.log(value) // 0
 *
 *   // Update the value atomically
 *   yield* Ref.update(counter, (n) => n + 1)
 *
 *   // Read the updated value
 *   const newValue = yield* Ref.get(counter)
 *   console.log(newValue) // 1
 * })
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface Ref<in out A> extends Ref.Variance<A>, Pipeable {
  readonly ref: MutableRef.MutableRef<A>
}

/**
 * The Ref namespace containing type definitions and utilities.
 *
 * @since 2.0.0
 * @category models
 */
export declare namespace Ref {
  /**
   * Variance interface for Ref types, defining the type parameter constraints.
   *
   * @example
   * ```ts
   * import { Effect, Ref } from "effect"
   *
   * // This interface defines the invariant nature of Ref's type parameter
   * // A Ref<A> is both a producer and consumer of A
   * const program = Effect.gen(function*() {
   *   const ref = yield* Ref.make(42)
   *
   *   // Ref is invariant - it can both produce and consume numbers
   *   const value = yield* Ref.get(ref) // produces number
   *   yield* Ref.set(ref, value + 1) // consumes number
   * })
   * ```
   *
   * @since 2.0.0
   * @category models
   */
  export interface Variance<in out A> {
    readonly [TypeId]: {
      readonly _A: Invariant<A>
    }
  }
}

const RefProto = {
  [TypeId]: {
    _A: identity
  },
  ...PipeInspectableProto,
  toJSON(this: Ref<any>) {
    return {
      _id: "Ref",
      ref: this.ref
    }
  }
}

/**
 * Creates a new Ref with the specified initial value (unsafe version).
 *
 * This function creates a Ref synchronously without wrapping in Effect.
 * Use this only when you're sure about the safety of immediate creation.
 *
 * @example
 * ```ts
 * import { Ref } from "effect"
 *
 * // Create a ref directly without Effect
 * const counter = Ref.makeUnsafe(0)
 *
 * // Get the current value
 * const value = Ref.getUnsafe(counter)
 * console.log(value) // 0
 *
 * // Note: This is unsafe and should be used carefully
 * // Prefer Ref.make for Effect-wrapped creation
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const makeUnsafe = <A>(value: A): Ref<A> => {
  const self = Object.create(RefProto)
  self.ref = MutableRef.make(value)
  return self
}

/**
 * Creates a new Ref with the specified initial value.
 *
 * @param value - The initial value for the Ref
 * @returns An Effect that creates a new Ref
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* Ref.make(42)
 *   const value = yield* Ref.get(ref)
 *   console.log(value) // 42
 * })
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const make = <A>(value: A): Effect.Effect<Ref<A>> => Effect.sync(() => makeUnsafe(value))

/**
 * Gets the current value of the Ref.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* Ref.make(42)
 *   const value = yield* Ref.get(ref)
 *   console.log(value) // 42
 * })
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const get = <A>(self: Ref<A>) => Effect.sync(() => self.ref.current)

/**
 * Sets the value of the Ref to the specified value.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* Ref.make(0)
 *   yield* Ref.set(ref, 42)
 *   const value = yield* Ref.get(ref)
 *   console.log(value) // 42
 * })
 *
 * // Using multiple operations
 * const program2 = Effect.gen(function*() {
 *   const ref = yield* Ref.make(0)
 *   yield* Ref.set(ref, 100)
 *   const value = yield* Ref.get(ref)
 *   console.log(value) // 100
 * })
 * ```
 *
 * @since 2.0.0
 * @category setters
 */
export const set = dual<
  <A>(value: A) => (self: Ref<A>) => Effect.Effect<void>,
  <A>(self: Ref<A>, value: A) => Effect.Effect<void>
>(2, <A>(self: Ref<A>, value: A) => Effect.sync(() => MutableRef.set(self.ref, value)))

/**
 * Atomically gets the current value of the Ref and sets it to the specified value.
 *
 * Returns the value that was in the Ref before the update.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* Ref.make("initial")
 *
 *   // Get current value and set new value atomically
 *   const previous = yield* Ref.getAndSet(ref, "updated")
 *   console.log(previous) // "initial"
 *
 *   const current = yield* Ref.get(ref)
 *   console.log(current) // "updated"
 * })
 * ```
 *
 * @since 2.0.0
 * @category utils
 */
export const getAndSet = dual<
  <A>(value: A) => (self: Ref<A>) => Effect.Effect<A>,
  <A>(self: Ref<A>, value: A) => Effect.Effect<A>
>(2, <A>(self: Ref<A>, value: A) =>
  Effect.sync(() => {
    const current = self.ref.current
    self.ref.current = value
    return current
  }))

/**
 * Atomically gets the current value of the Ref and updates it with the given function.
 *
 * Returns the value that was in the Ref before the update.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(10)
 *
 *   // Get current value and update it atomically
 *   const previous = yield* Ref.getAndUpdate(counter, (n) => n * 2)
 *   console.log(previous) // 10
 *
 *   const current = yield* Ref.get(counter)
 *   console.log(current) // 20
 * })
 * ```
 *
 * @since 2.0.0
 * @category utils
 */
export const getAndUpdate = dual<
  <A>(f: (a: A) => A) => (self: Ref<A>) => Effect.Effect<A>,
  <A>(self: Ref<A>, f: (a: A) => A) => Effect.Effect<A>
>(2, <A>(self: Ref<A>, f: (a: A) => A) =>
  Effect.sync(() => {
    const current = self.ref.current
    self.ref.current = f(current)
    return current
  }))

/**
 * Atomically gets the current value of the Ref and updates it with the given partial function.
 *
 * If the partial function returns `Option.some`, the Ref is updated with the new value.
 * If it returns `Option.none`, the Ref is left unchanged.
 * Always returns the value that was in the Ref before the attempted update.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 * import * as Option from "effect/Option"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(5)
 *
 *   // Only update if value is greater than 3
 *   const previous1 = yield* Ref.getAndUpdateSome(
 *     counter,
 *     (n) => n > 3 ? Option.some(n * 2) : Option.none()
 *   )
 *   console.log(previous1) // 5
 *
 *   const current1 = yield* Ref.get(counter)
 *   console.log(current1) // 10
 *
 *   // Try to update again (won't update since 10 > 3 is true but let's say condition is n < 3)
 *   const previous2 = yield* Ref.getAndUpdateSome(
 *     counter,
 *     (n) => n < 3 ? Option.some(n * 2) : Option.none()
 *   )
 *   console.log(previous2) // 10
 *
 *   const current2 = yield* Ref.get(counter)
 *   console.log(current2) // 10 (unchanged)
 * })
 * ```
 *
 * @since 2.0.0
 * @category utils
 */
export const getAndUpdateSome = dual<
  <A>(pf: (a: A) => Option.Option<A>) => (self: Ref<A>) => Effect.Effect<A>,
  <A>(self: Ref<A>, pf: (a: A) => Option.Option<A>) => Effect.Effect<A>
>(2, <A>(self: Ref<A>, pf: (a: A) => Option.Option<A>) =>
  Effect.sync(() => {
    const current = self.ref.current
    const option = pf(current)
    if (option._tag === "Some") {
      self.ref.current = option.value
    }
    return current
  }))

/**
 * Atomically sets the value of the Ref to the specified value and returns the new value.
 *
 * This is useful when you want to set a value and immediately get it back in one atomic operation.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref = yield* Ref.make(10)
 *
 *   // Set new value and get it back in one operation
 *   const newValue = yield* Ref.setAndGet(ref, 42)
 *   console.log(newValue) // 42
 *
 *   // Verify the ref contains the new value
 *   const current = yield* Ref.get(ref)
 *   console.log(current) // 42
 * })
 *
 * // Useful for sequential operations
 * const program2 = Effect.gen(function*() {
 *   const counter = yield* Ref.make(0)
 *
 *   const newValue = yield* Ref.setAndGet(counter, 20)
 *   console.log(newValue) // 20
 * })
 * ```
 *
 * @since 2.0.0
 * @category utils
 */
export const setAndGet = dual<
  <A>(value: A) => (self: Ref<A>) => Effect.Effect<A>,
  <A>(self: Ref<A>, value: A) => Effect.Effect<A>
>(2, <A>(self: Ref<A>, value: A) => Effect.sync(() => self.ref.current = value))

/**
 * Atomically modifies the value of the Ref using the given function.
 *
 * The function receives the current value and returns a tuple of [result, newValue].
 * The Ref is updated with the newValue and the result is returned.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(10)
 *
 *   // Modify the ref and return some computation result
 *   const result = yield* Ref.modify(counter, (n) => [
 *     `Previous value was ${n}`, // Return value
 *     n * 2 // New ref value
 *   ])
 *
 *   console.log(result) // "Previous value was 10"
 *
 *   const current = yield* Ref.get(counter)
 *   console.log(current) // 20
 * })
 *
 * // Example with more complex computation
 * const program2 = Effect.gen(function*() {
 *   const state = yield* Ref.make({ count: 0, total: 0 })
 *
 *   const incremented = yield* Ref.modify(state, (s) => [
 *     s.count, // Return previous count
 *     { count: s.count + 1, total: s.total + s.count + 1 } // New state
 *   ])
 *
 *   console.log(incremented) // 0
 * })
 * ```
 *
 * @since 2.0.0
 * @category setters
 */
export const modify = dual<
  <A, B>(f: (a: A) => readonly [B, A]) => (self: Ref<A>) => Effect.Effect<B>,
  <A, B>(self: Ref<A>, f: (a: A) => readonly [B, A]) => Effect.Effect<B>
>(2, (self, f) =>
  Effect.sync(() => {
    const [b, a] = f(self.ref.current)
    self.ref.current = a
    return b
  }))

/**
 * Atomically modifies the value of the Ref using the given partial function.
 *
 * The function receives the current value and returns an Option of [result, newValue].
 * If the function returns `Option.some([result, newValue])`, the Ref is updated with newValue and result is returned.
 * If it returns `Option.none()`, the Ref is left unchanged and the fallback value is returned.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 * import * as Option from "effect/Option"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(5)
 *
 *   // Only modify if value is greater than 3
 *   const result1 = yield* Ref.modifySome(
 *     counter,
 *     (n) =>
 *       n > 3
 *         ? [`incremented ${n}`, Option.some(n + 10)]
 *         : ["no change", Option.none()]
 *   )
 *
 *   console.log(result1) // "incremented 5"
 *
 *   const current1 = yield* Ref.get(counter)
 *   console.log(current1) // 15
 *
 *   // Try to modify with a condition that fails
 *   const result2 = yield* Ref.modifySome(
 *     counter,
 *     (n) =>
 *       n < 10
 *         ? [`decremented ${n}`, Option.some(n - 5)]
 *         : ["no change", Option.none()]
 *   )
 *
 *   console.log(result2) // "no change"
 *
 *   const current2 = yield* Ref.get(counter)
 *   console.log(current2) // 15 (unchanged)
 * })
 * ```
 *
 * @since 2.0.0
 * @category setters
 */
export const modifySome: {
  <B, A>(pf: (a: A) => readonly [B, Option.Option<A>]): (self: Ref<A>) => Effect.Effect<B>
  <A, B>(self: Ref<A>, pf: (a: A) => readonly [B, Option.Option<A>]): Effect.Effect<B>
} = dual<
  <B, A>(
    pf: (a: A) => readonly [B, Option.Option<A>]
  ) => (self: Ref<A>) => Effect.Effect<B>,
  <A, B>(
    self: Ref<A>,
    pf: (a: A) => readonly [B, Option.Option<A>]
  ) => Effect.Effect<B>
>(2, (self, pf) =>
  modify(self, (value) => {
    const [b, option] = pf(value)
    return [b, option._tag === "None" ? value : option.value]
  }))

/**
 * Atomically updates the value of the Ref using the given function.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(5)
 *
 *   // Update the value
 *   yield* Ref.update(counter, (n) => n * 2)
 *
 *   const value = yield* Ref.get(counter)
 *   console.log(value) // 10
 * })
 *
 * // Using multiple operations
 * const program2 = Effect.gen(function*() {
 *   const counter = yield* Ref.make(5)
 *   yield* Ref.update(counter, (n: number) => n + 10)
 *   const value = yield* Ref.get(counter)
 *   console.log(value) // 15
 * })
 * ```
 *
 * @since 2.0.0
 * @category setters
 */
export const update = dual<
  <A>(f: (a: A) => A) => (self: Ref<A>) => Effect.Effect<void>,
  <A>(self: Ref<A>, f: (a: A) => A) => Effect.Effect<void>
>(2, <A>(self: Ref<A>, f: (a: A) => A) =>
  Effect.sync(() => {
    self.ref.current = f(self.ref.current)
  }))

/**
 * Atomically updates the value of the Ref using the given function and returns the new value.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(5)
 *
 *   // Update and get the new value in one operation
 *   const newValue = yield* Ref.updateAndGet(counter, (n) => n * 3)
 *   console.log(newValue) // 15
 *
 *   // Verify the ref contains the new value
 *   const current = yield* Ref.get(counter)
 *   console.log(current) // 15
 * })
 * ```
 *
 * @since 2.0.0
 * @category utils
 */
export const updateAndGet = dual<
  <A>(f: (a: A) => A) => (self: Ref<A>) => Effect.Effect<A>,
  <A>(self: Ref<A>, f: (a: A) => A) => Effect.Effect<A>
>(2, <A>(self: Ref<A>, f: (a: A) => A) => Effect.sync(() => self.ref.current = f(self.ref.current)))

/**
 * Atomically updates the value of the Ref using the given partial function.
 *
 * If the partial function returns `Option.some`, the Ref is updated with the new value.
 * If it returns `Option.none`, the Ref is left unchanged.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 * import * as Option from "effect/Option"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(5)
 *
 *   // Only update if value is even
 *   yield* Ref.updateSome(
 *     counter,
 *     (n) => n % 2 === 0 ? Option.some(n * 2) : Option.none()
 *   )
 *
 *   let current = yield* Ref.get(counter)
 *   console.log(current) // 5 (unchanged because 5 is odd)
 *
 *   // Set to even number and try again
 *   yield* Ref.set(counter, 6)
 *   yield* Ref.updateSome(
 *     counter,
 *     (n) => n % 2 === 0 ? Option.some(n * 2) : Option.none()
 *   )
 *
 *   current = yield* Ref.get(counter)
 *   console.log(current) // 12 (updated because 6 is even)
 * })
 * ```
 *
 * @since 2.0.0
 * @category setters
 */
export const updateSome = dual<
  <A>(f: (a: A) => Option.Option<A>) => (self: Ref<A>) => Effect.Effect<void>,
  <A>(self: Ref<A>, f: (a: A) => Option.Option<A>) => Effect.Effect<void>
>(2, <A>(self: Ref<A>, f: (a: A) => Option.Option<A>) =>
  Effect.sync(() => {
    const option = f(self.ref.current)
    if (option._tag === "Some") {
      self.ref.current = option.value
    }
  }))

/**
 * Atomically updates the value of the Ref using the given partial function and returns the current value.
 *
 * If the partial function returns `Option.some`, the Ref is updated with the new value.
 * If it returns `Option.none`, the Ref is left unchanged.
 * Returns the current value of the Ref after the potential update.
 *
 * @example
 * ```ts
 * import { Effect, Ref } from "effect"
 * import * as Option from "effect/Option"
 *
 * const program = Effect.gen(function*() {
 *   const counter = yield* Ref.make(10)
 *
 *   // Only update if value is greater than 5
 *   const result1 = yield* Ref.updateSomeAndGet(
 *     counter,
 *     (n) => n > 5 ? Option.some(n / 2) : Option.none()
 *   )
 *   console.log(result1) // 5 (updated and returned)
 *
 *   // Try to update again with same condition
 *   const result2 = yield* Ref.updateSomeAndGet(
 *     counter,
 *     (n) => n > 5 ? Option.some(n / 2) : Option.none()
 *   )
 *   console.log(result2) // 5 (unchanged because 5 is not > 5)
 * })
 * ```
 *
 * @since 2.0.0
 * @category utils
 */
export const updateSomeAndGet = dual<
  <A>(pf: (a: A) => Option.Option<A>) => (self: Ref<A>) => Effect.Effect<A>,
  <A>(self: Ref<A>, pf: (a: A) => Option.Option<A>) => Effect.Effect<A>
>(2, <A>(self: Ref<A>, pf: (a: A) => Option.Option<A>) =>
  Effect.sync(() => {
    const option = pf(self.ref.current)
    if (option._tag === "Some") {
      self.ref.current = option.value
    }
    return self.ref.current
  }))

/**
 * Gets the current value of the Ref synchronously (unsafe version).
 *
 * This function reads the current value without wrapping in Effect.
 * Use this only when you're sure about the safety of immediate access.
 *
 * @example
 * ```ts
 * import { Ref } from "effect"
 *
 * // Create a ref directly
 * const counter = Ref.makeUnsafe(42)
 *
 * // Get the value synchronously
 * const value = Ref.getUnsafe(counter)
 * console.log(value) // 42
 *
 * // Note: This is unsafe and should be used carefully
 * // Prefer Ref.get for Effect-wrapped access
 * ```
 *
 * @since 2.0.0
 * @category getters
 */
export const getUnsafe = <A>(self: Ref<A>): A => self.ref.current

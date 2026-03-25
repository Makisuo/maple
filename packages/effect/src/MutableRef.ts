/**
 * @fileoverview
 * MutableRef provides a mutable reference container that allows safe mutation of values
 * in functional programming contexts. It serves as a bridge between functional and imperative
 * programming paradigms, offering atomic operations for state management.
 *
 * Unlike regular variables, MutableRef encapsulates mutable state and provides controlled
 * access through a standardized API. It supports atomic compare-and-set operations for
 * thread-safe updates and integrates seamlessly with Effect's ecosystem.
 *
 * Key Features:
 * - Mutable reference semantics with functional API
 * - Atomic compare-and-set operations for safe concurrent updates
 * - Specialized operations for numeric and boolean values
 * - Chainable operations that return the reference or the value
 * - Integration with Effect's Equal interface for value comparison
 *
 * Common Use Cases:
 * - State containers in functional applications
 * - Counters and accumulators
 * - Configuration that needs to be updated at runtime
 * - Caching and memoization scenarios
 * - Inter-module communication via shared references
 *
 * Performance Characteristics:
 * - Get/Set: O(1)
 * - Compare-and-set: O(1)
 * - All operations: O(1)
 *
 * @since 2.0.0
 * @category data-structures
 */
import * as Equal from "./Equal.ts"
import * as Dual from "./Function.ts"
import { type Inspectable, toJson } from "./Inspectable.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import type { Pipeable } from "./Pipeable.ts"

const TypeId = "~effect/MutableRef"

/**
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * // Create a mutable reference
 * const ref: MutableRef.MutableRef<number> = MutableRef.make(42)
 *
 * // Read the current value
 * console.log(ref.current) // 42
 * console.log(MutableRef.get(ref)) // 42
 *
 * // Update the value
 * ref.current = 100
 * console.log(MutableRef.get(ref)) // 100
 *
 * // Use with complex types
 * interface Config {
 *   timeout: number
 *   retries: number
 * }
 *
 * const config: MutableRef.MutableRef<Config> = MutableRef.make({
 *   timeout: 5000,
 *   retries: 3
 * })
 *
 * // Update through the interface
 * config.current = { timeout: 10000, retries: 5 }
 * console.log(config.current.timeout) // 10000
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface MutableRef<out T> extends Pipeable, Inspectable {
  readonly [TypeId]: typeof TypeId
  current: T
}

const MutableRefProto: Omit<MutableRef<unknown>, "current"> = {
  [TypeId]: TypeId,
  ...PipeInspectableProto,
  toJSON<A>(this: MutableRef<A>) {
    return {
      _id: "MutableRef",
      current: toJson(this.current)
    }
  }
}

/**
 * Creates a new MutableRef with the specified initial value.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * // Create a counter reference
 * const counter = MutableRef.make(0)
 * console.log(MutableRef.get(counter)) // 0
 *
 * // Create a configuration reference
 * const config = MutableRef.make({ debug: false, timeout: 5000 })
 * console.log(MutableRef.get(config)) // { debug: false, timeout: 5000 }
 *
 * // Create a string reference
 * const status = MutableRef.make("idle")
 * MutableRef.set(status, "running")
 * console.log(MutableRef.get(status)) // "running"
 * ```
 *
 * @since 2.0.0
 * @category constructors
 */
export const make = <T>(value: T): MutableRef<T> => {
  const ref = Object.create(MutableRefProto)
  ref.current = value
  return ref
}

/**
 * Atomically sets the value to newValue if the current value equals oldValue.
 * Returns true if the value was updated, false otherwise.
 * Uses Effect's Equal interface for value comparison.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const ref = MutableRef.make("initial")
 *
 * // Successful compare and set
 * const updated = MutableRef.compareAndSet(ref, "initial", "updated")
 * console.log(updated) // true
 * console.log(MutableRef.get(ref)) // "updated"
 *
 * // Failed compare and set (value doesn't match)
 * const failed = MutableRef.compareAndSet(ref, "initial", "failed")
 * console.log(failed) // false
 * console.log(MutableRef.get(ref)) // "updated" (unchanged)
 *
 * // Thread-safe counter increment
 * const counter = MutableRef.make(5)
 * let current: number
 * do {
 *   current = MutableRef.get(counter)
 * } while (!MutableRef.compareAndSet(counter, current, current + 1))
 *
 * // Pipe-able version
 * const casUpdate = MutableRef.compareAndSet("updated", "final")
 * console.log(casUpdate(ref)) // true
 * ```
 *
 * @since 2.0.0
 * @category general
 */
export const compareAndSet: {
  <T>(oldValue: T, newValue: T): (self: MutableRef<T>) => boolean
  <T>(self: MutableRef<T>, oldValue: T, newValue: T): boolean
} = Dual.dual<
  <T>(oldValue: T, newValue: T) => (self: MutableRef<T>) => boolean,
  <T>(self: MutableRef<T>, oldValue: T, newValue: T) => boolean
>(3, (self, oldValue, newValue) => {
  if (Equal.equals(oldValue, self.current)) {
    self.current = newValue
    return true
  }
  return false
})

/**
 * Decrements a numeric MutableRef by 1 and returns the reference.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const counter = MutableRef.make(5)
 *
 * // Decrement the counter
 * MutableRef.decrement(counter)
 * console.log(MutableRef.get(counter)) // 4
 *
 * // Chain operations
 * MutableRef.decrement(counter)
 * MutableRef.decrement(counter)
 * console.log(MutableRef.get(counter)) // 2
 *
 * // Useful for countdown scenarios
 * const countdown = MutableRef.make(10)
 * while (MutableRef.get(countdown) > 0) {
 *   console.log(MutableRef.get(countdown))
 *   MutableRef.decrement(countdown)
 * }
 * ```
 *
 * @since 2.0.0
 * @category numeric
 */
export const decrement = (self: MutableRef<number>): MutableRef<number> => update(self, (n) => n - 1)

/**
 * Decrements a numeric MutableRef by 1 and returns the new value.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const counter = MutableRef.make(5)
 *
 * // Decrement and get the new value
 * const newValue = MutableRef.decrementAndGet(counter)
 * console.log(newValue) // 4
 * console.log(MutableRef.get(counter)) // 4
 *
 * // Use in expressions
 * const lives = MutableRef.make(3)
 * console.log(`Lives remaining: ${MutableRef.decrementAndGet(lives)}`) // "Lives remaining: 2"
 *
 * // Conditional logic based on decremented value
 * const attempts = MutableRef.make(3)
 * while (MutableRef.decrementAndGet(attempts) >= 0) {
 *   console.log("Retrying...")
 *   // retry logic
 * }
 * ```
 *
 * @since 2.0.0
 * @category numeric
 */
export const decrementAndGet = (self: MutableRef<number>): number => updateAndGet(self, (n) => n - 1)

/**
 * Gets the current value of the MutableRef.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const ref = MutableRef.make("hello")
 * console.log(MutableRef.get(ref)) // "hello"
 *
 * MutableRef.set(ref, "world")
 * console.log(MutableRef.get(ref)) // "world"
 *
 * // Reading complex objects
 * const config = MutableRef.make({ port: 3000, host: "localhost" })
 * const currentConfig = MutableRef.get(config)
 * console.log(currentConfig.port) // 3000
 *
 * // Multiple reads return the same value
 * const value1 = MutableRef.get(ref)
 * const value2 = MutableRef.get(ref)
 * console.log(value1 === value2) // true
 * ```
 *
 * @since 2.0.0
 * @category general
 */
export const get = <T>(self: MutableRef<T>): T => self.current

/**
 * Decrements a numeric MutableRef by 1 and returns the previous value.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const counter = MutableRef.make(5)
 *
 * // Get current value and then decrement
 * const previousValue = MutableRef.getAndDecrement(counter)
 * console.log(previousValue) // 5
 * console.log(MutableRef.get(counter)) // 4
 *
 * // Useful for processing where you need the original value
 * const itemsLeft = MutableRef.make(10)
 * while (MutableRef.get(itemsLeft) > 0) {
 *   const currentItem = MutableRef.getAndDecrement(itemsLeft)
 *   console.log(`Processing item ${currentItem}`)
 * }
 *
 * // Post-decrement semantics (like i-- in other languages)
 * const index = MutableRef.make(3)
 * const currentIndex = MutableRef.getAndDecrement(index)
 * console.log(`Current: ${currentIndex}, Next: ${MutableRef.get(index)}`) // "Current: 3, Next: 2"
 * ```
 *
 * @since 2.0.0
 * @category numeric
 */
export const getAndDecrement = (self: MutableRef<number>): number => getAndUpdate(self, (n) => n - 1)

/**
 * Increments a numeric MutableRef by 1 and returns the previous value.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const counter = MutableRef.make(5)
 *
 * // Get current value and then increment
 * const previousValue = MutableRef.getAndIncrement(counter)
 * console.log(previousValue) // 5
 * console.log(MutableRef.get(counter)) // 6
 *
 * // Useful for ID generation
 * const idGenerator = MutableRef.make(0)
 * const getId = () => MutableRef.getAndIncrement(idGenerator)
 *
 * console.log(getId()) // 0
 * console.log(getId()) // 1
 * console.log(getId()) // 2
 *
 * // Post-increment semantics (like i++ in other languages)
 * const position = MutableRef.make(0)
 * const currentPos = MutableRef.getAndIncrement(position)
 * console.log(`Was at: ${currentPos}, Now at: ${MutableRef.get(position)}`) // "Was at: 0, Now at: 1"
 *
 * // Useful for iteration counters
 * const iterations = MutableRef.make(0)
 * while (MutableRef.get(iterations) < 5) {
 *   const iteration = MutableRef.getAndIncrement(iterations)
 *   console.log(`Iteration ${iteration}`)
 * }
 * ```
 *
 * @since 2.0.0
 * @category numeric
 */
export const getAndIncrement = (self: MutableRef<number>): number => getAndUpdate(self, (n) => n + 1)

/**
 * Sets the MutableRef to a new value and returns the previous value.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const ref = MutableRef.make("old")
 *
 * // Set new value and get the previous one
 * const previous = MutableRef.getAndSet(ref, "new")
 * console.log(previous) // "old"
 * console.log(MutableRef.get(ref)) // "new"
 *
 * // Swapping values
 * const counter = MutableRef.make(5)
 * const oldValue = MutableRef.getAndSet(counter, 10)
 * console.log(`Changed from ${oldValue} to ${MutableRef.get(counter)}`) // "Changed from 5 to 10"
 *
 * // Pipe-able version
 * const setValue = MutableRef.getAndSet("final")
 * const previousValue = setValue(ref)
 * console.log(previousValue) // "new"
 *
 * // Useful for atomic swaps in algorithms
 * const buffer = MutableRef.make<Array<string>>(["a", "b", "c"])
 * const oldBuffer = MutableRef.getAndSet(buffer, [])
 * console.log(oldBuffer) // ["a", "b", "c"]
 * console.log(MutableRef.get(buffer)) // []
 * ```
 *
 * @since 2.0.0
 * @category general
 */
export const getAndSet: {
  <T>(value: T): (self: MutableRef<T>) => T
  <T>(self: MutableRef<T>, value: T): T
} = Dual.dual<
  <T>(value: T) => (self: MutableRef<T>) => T,
  <T>(self: MutableRef<T>, value: T) => T
>(2, (self, value) => {
  const ret = self.current
  self.current = value
  return ret
})

/**
 * Updates the MutableRef with the result of applying a function to its current value,
 * and returns the previous value.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const counter = MutableRef.make(5)
 *
 * // Increment and get the old value
 * const oldValue = MutableRef.getAndUpdate(counter, (n) => n + 1)
 * console.log(oldValue) // 5
 * console.log(MutableRef.get(counter)) // 6
 *
 * // Double the value and get the previous one
 * const previous = MutableRef.getAndUpdate(counter, (n) => n * 2)
 * console.log(previous) // 6
 * console.log(MutableRef.get(counter)) // 12
 *
 * // Transform string and get old value
 * const message = MutableRef.make("hello")
 * const oldMessage = MutableRef.getAndUpdate(message, (s) => s.toUpperCase())
 * console.log(oldMessage) // "hello"
 * console.log(MutableRef.get(message)) // "HELLO"
 *
 * // Pipe-able version
 * const addOne = MutableRef.getAndUpdate((n: number) => n + 1)
 * const result = addOne(counter)
 * console.log(result) // Previous value before increment
 *
 * // Useful for implementing atomic operations
 * const list = MutableRef.make<Array<number>>([1, 2, 3])
 * const oldList = MutableRef.getAndUpdate(list, (arr) => [...arr, 4])
 * console.log(oldList) // [1, 2, 3]
 * console.log(MutableRef.get(list)) // [1, 2, 3, 4]
 * ```
 *
 * @since 2.0.0
 * @category general
 */
export const getAndUpdate: {
  <T>(f: (value: T) => T): (self: MutableRef<T>) => T
  <T>(self: MutableRef<T>, f: (value: T) => T): T
} = Dual.dual<
  <T>(f: (value: T) => T) => (self: MutableRef<T>) => T,
  <T>(self: MutableRef<T>, f: (value: T) => T) => T
>(2, (self, f) => getAndSet(self, f(get(self))))

/**
 * Increments a numeric MutableRef by 1 and returns the reference.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const counter = MutableRef.make(5)
 *
 * // Increment the counter
 * MutableRef.increment(counter)
 * console.log(MutableRef.get(counter)) // 6
 *
 * // Chain operations
 * MutableRef.increment(counter)
 * MutableRef.increment(counter)
 * console.log(MutableRef.get(counter)) // 8
 *
 * // Useful for simple counting
 * const visits = MutableRef.make(0)
 * MutableRef.increment(visits) // User visited
 * MutableRef.increment(visits) // Another visit
 * console.log(MutableRef.get(visits)) // 2
 *
 * // Returns the reference for chaining
 * const result = MutableRef.increment(counter)
 * console.log(result === counter) // true
 * ```
 *
 * @since 2.0.0
 * @category numeric
 */
export const increment = (self: MutableRef<number>): MutableRef<number> => update(self, (n) => n + 1)

/**
 * Increments a numeric MutableRef by 1 and returns the new value.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const counter = MutableRef.make(5)
 *
 * // Increment and get the new value
 * const newValue = MutableRef.incrementAndGet(counter)
 * console.log(newValue) // 6
 * console.log(MutableRef.get(counter)) // 6
 *
 * // Use in expressions
 * const score = MutableRef.make(100)
 * console.log(`New score: ${MutableRef.incrementAndGet(score)}`) // "New score: 101"
 *
 * // Pre-increment semantics (like ++i in other languages)
 * const level = MutableRef.make(0)
 * const nextLevel = MutableRef.incrementAndGet(level)
 * console.log(`Reached level ${nextLevel}`) // "Reached level 1"
 *
 * // Conditional logic based on incremented value
 * const attempts = MutableRef.make(0)
 * if (MutableRef.incrementAndGet(attempts) > 3) {
 *   console.log("Too many attempts")
 * }
 * ```
 *
 * @since 2.0.0
 * @category numeric
 */
export const incrementAndGet = (self: MutableRef<number>): number => updateAndGet(self, (n) => n + 1)

/**
 * Sets the MutableRef to a new value and returns the reference.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const ref = MutableRef.make("initial")
 *
 * // Set a new value
 * MutableRef.set(ref, "updated")
 * console.log(MutableRef.get(ref)) // "updated"
 *
 * // Chain set operations (since it returns the ref)
 * const result = MutableRef.set(ref, "final")
 * console.log(result === ref) // true (same reference)
 * console.log(MutableRef.get(ref)) // "final"
 *
 * // Set complex objects
 * const config = MutableRef.make({ debug: false, verbose: false })
 * MutableRef.set(config, { debug: true, verbose: true })
 * console.log(MutableRef.get(config)) // { debug: true, verbose: true }
 *
 * // Pipe-able version
 * const setValue = MutableRef.set("new value")
 * setValue(ref)
 * console.log(MutableRef.get(ref)) // "new value"
 *
 * // Useful for state management
 * const state = MutableRef.make<"idle" | "loading" | "success" | "error">("idle")
 * MutableRef.set(state, "loading")
 * // ... perform async operation
 * MutableRef.set(state, "success")
 * ```
 *
 * @since 2.0.0
 * @category general
 */
export const set: {
  <T>(value: T): (self: MutableRef<T>) => MutableRef<T>
  <T>(self: MutableRef<T>, value: T): MutableRef<T>
} = Dual.dual<
  <T>(value: T) => (self: MutableRef<T>) => MutableRef<T>,
  <T>(self: MutableRef<T>, value: T) => MutableRef<T>
>(2, (self, value) => {
  self.current = value
  return self
})

/**
 * Sets the MutableRef to a new value and returns the new value.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const ref = MutableRef.make("old")
 *
 * // Set and get the new value
 * const newValue = MutableRef.setAndGet(ref, "new")
 * console.log(newValue) // "new"
 * console.log(MutableRef.get(ref)) // "new"
 *
 * // Useful for assignments that need the value
 * const counter = MutableRef.make(0)
 * const currentValue = MutableRef.setAndGet(counter, 42)
 * console.log(`Counter set to: ${currentValue}`) // "Counter set to: 42"
 *
 * // Pipe-able version
 * const setValue = MutableRef.setAndGet("final")
 * const result = setValue(ref)
 * console.log(result) // "final"
 *
 * // Difference from set: returns value instead of reference
 * const ref1 = MutableRef.make(1)
 * const returnedRef = MutableRef.set(ref1, 2) // Returns MutableRef
 * const returnedValue = MutableRef.setAndGet(ref1, 3) // Returns value
 * console.log(returnedValue) // 3
 * ```
 *
 * @since 2.0.0
 * @category general
 */
export const setAndGet: {
  <T>(value: T): (self: MutableRef<T>) => T
  <T>(self: MutableRef<T>, value: T): T
} = Dual.dual<
  <T>(value: T) => (self: MutableRef<T>) => T,
  <T>(self: MutableRef<T>, value: T) => T
>(2, (self, value) => {
  self.current = value
  return self.current
})

/**
 * Updates the MutableRef with the result of applying a function to its current value,
 * and returns the reference.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const counter = MutableRef.make(5)
 *
 * // Increment the counter
 * MutableRef.update(counter, (n) => n + 1)
 * console.log(MutableRef.get(counter)) // 6
 *
 * // Chain updates (since it returns the ref)
 * const result = MutableRef.update(counter, (n) => n * 2)
 * console.log(result === counter) // true (same reference)
 * console.log(MutableRef.get(counter)) // 12
 *
 * // Transform string
 * const message = MutableRef.make("hello")
 * MutableRef.update(message, (s) => s.toUpperCase())
 * console.log(MutableRef.get(message)) // "HELLO"
 *
 * // Update complex objects
 * const user = MutableRef.make({ name: "Alice", age: 30 })
 * MutableRef.update(user, (u) => ({ ...u, age: u.age + 1 }))
 * console.log(MutableRef.get(user)) // { name: "Alice", age: 31 }
 *
 * // Pipe-able version
 * const double = MutableRef.update((n: number) => n * 2)
 * double(counter)
 * console.log(MutableRef.get(counter)) // 24
 *
 * // Array operations
 * const list = MutableRef.make<Array<number>>([1, 2, 3])
 * MutableRef.update(list, (arr) => [...arr, 4])
 * console.log(MutableRef.get(list)) // [1, 2, 3, 4]
 * ```
 *
 * @since 2.0.0
 * @category general
 */
export const update: {
  <T>(f: (value: T) => T): (self: MutableRef<T>) => MutableRef<T>
  <T>(self: MutableRef<T>, f: (value: T) => T): MutableRef<T>
} = Dual.dual<
  <T>(f: (value: T) => T) => (self: MutableRef<T>) => MutableRef<T>,
  <T>(self: MutableRef<T>, f: (value: T) => T) => MutableRef<T>
>(2, (self, f) => set(self, f(get(self))))

/**
 * Updates the MutableRef with the result of applying a function to its current value,
 * and returns the new value.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const counter = MutableRef.make(5)
 *
 * // Increment and get the new value
 * const newValue = MutableRef.updateAndGet(counter, (n) => n + 1)
 * console.log(newValue) // 6
 * console.log(MutableRef.get(counter)) // 6
 *
 * // Double the value and get the result
 * const doubled = MutableRef.updateAndGet(counter, (n) => n * 2)
 * console.log(doubled) // 12
 *
 * // Transform string and get result
 * const message = MutableRef.make("hello")
 * const upperCase = MutableRef.updateAndGet(message, (s) => s.toUpperCase())
 * console.log(upperCase) // "HELLO"
 *
 * // Pipe-able version
 * const increment = MutableRef.updateAndGet((n: number) => n + 1)
 * const result = increment(counter)
 * console.log(result) // 13 (new value)
 *
 * // Useful for calculations that need the result
 * const score = MutableRef.make(100)
 * const bonus = 50
 * const newScore = MutableRef.updateAndGet(score, (s) => s + bonus)
 * console.log(`New score: ${newScore}`) // "New score: 150"
 *
 * // Array transformations
 * const list = MutableRef.make<Array<number>>([1, 2, 3])
 * const newList = MutableRef.updateAndGet(list, (arr) => arr.map((x) => x * 2))
 * console.log(newList) // [2, 4, 6]
 * console.log(MutableRef.get(list)) // [2, 4, 6]
 * ```
 *
 * @since 2.0.0
 * @category general
 */
export const updateAndGet: {
  <T>(f: (value: T) => T): (self: MutableRef<T>) => T
  <T>(self: MutableRef<T>, f: (value: T) => T): T
} = Dual.dual<
  <T>(f: (value: T) => T) => (self: MutableRef<T>) => T,
  <T>(self: MutableRef<T>, f: (value: T) => T) => T
>(2, (self, f) => setAndGet(self, f(get(self))))

/**
 * Toggles a boolean MutableRef (true becomes false, false becomes true) and returns the reference.
 *
 * @example
 * ```ts
 * import { MutableRef } from "effect"
 *
 * const flag = MutableRef.make(false)
 *
 * // Toggle the flag
 * MutableRef.toggle(flag)
 * console.log(MutableRef.get(flag)) // true
 *
 * // Toggle again
 * MutableRef.toggle(flag)
 * console.log(MutableRef.get(flag)) // false
 *
 * // Useful for state switches
 * const isVisible = MutableRef.make(true)
 * MutableRef.toggle(isVisible) // Hide
 * console.log(MutableRef.get(isVisible)) // false
 *
 * // Toggle button implementation
 * const darkMode = MutableRef.make(false)
 * const toggleDarkMode = () => {
 *   MutableRef.toggle(darkMode)
 *   console.log(`Dark mode: ${MutableRef.get(darkMode) ? "ON" : "OFF"}`)
 * }
 *
 * toggleDarkMode() // "Dark mode: ON"
 * toggleDarkMode() // "Dark mode: OFF"
 *
 * // Returns the reference for chaining
 * const result = MutableRef.toggle(flag)
 * console.log(result === flag) // true
 * ```
 *
 * @since 2.0.0
 * @category boolean
 */
export const toggle = (self: MutableRef<boolean>): MutableRef<boolean> => update(self, (_) => !_)

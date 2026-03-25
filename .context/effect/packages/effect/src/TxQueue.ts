/**
 * TxQueue is a transactional queue data structure that provides Software Transactional Memory (STM)
 * semantics for queue operations. It uses TxRef for transactional state management and supports
 * multiple queue strategies: bounded, unbounded, dropping, and sliding.
 *
 * Accessed values are tracked by the transaction in order to detect conflicts and to track changes.
 * A transaction will retry whenever a conflict is detected or whenever the transaction explicitly
 * calls `Effect.retryTransaction` and any of the accessed TxQueue values change.
 *
 * @since 4.0.0
 */
import type * as Arr from "./Array.ts"
import * as Cause from "./Cause.ts"
import * as Chunk from "./Chunk.ts"
import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import type { Inspectable } from "./Inspectable.ts"
import { NodeInspectSymbol, toJson } from "./Inspectable.ts"
import * as Option from "./Option.ts"
import { hasProperty } from "./Predicate.ts"
import { type ExcludeDone, isDoneCause } from "./Pull.ts"
import * as TxChunk from "./TxChunk.ts"
import * as TxRef from "./TxRef.ts"
import type * as Types from "./Types.ts"

/**
 * Represents the state of a transactional queue with sophisticated lifecycle management.
 *
 * The queue progresses through three states:
 * - **Open**: Accepting offers and serving takes normally
 * - **Closing**: No new offers accepted, serving remaining items until empty
 * - **Done**: Terminal state with completion cause, no further operations possible
 *
 * @example
 * ```ts
 * import type { TxQueue } from "effect"
 *
 * // State progression example
 * declare const state: TxQueue.State<string, Error>
 *
 * if (state._tag === "Open") {
 *   console.log("Queue is accepting new items")
 * } else if (state._tag === "Closing") {
 *   console.log("Queue is draining, cause:", state.cause)
 * } else {
 *   console.log("Queue is done, cause:", state.cause)
 * }
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export type State<_A, E> =
  | {
    readonly _tag: "Open"
  }
  | {
    readonly _tag: "Closing"
    readonly cause: Cause.Cause<E>
  }
  | {
    readonly _tag: "Done"
    readonly cause: Cause.Cause<E>
  }

const EnqueueTypeId = "~effect/transactions/TxQueue/Enqueue"
const DequeueTypeId = "~effect/transactions/TxQueue/Dequeue"
const TypeId = "~effect/transactions/TxQueue"

/**
 * Namespace containing type definitions for TxEnqueue variance annotations.
 *
 * @example
 * ```ts
 * import type { TxQueue } from "effect"
 *
 * // Use variance types for type-level operations
 * declare const variance: TxQueue.TxEnqueue.Variance<number, Error>
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export declare namespace TxEnqueue {
  /**
   * Variance annotation interface for TxEnqueue contravariance.
   *
   * @example
   * ```ts
   * import type { TxQueue } from "effect"
   *
   * // Demonstrates contravariant type behavior for both A and E
   * declare const variance: TxQueue.TxEnqueue.Variance<string, Error>
   * ```
   *
   * @since 4.0.0
   * @category models
   */
  export interface Variance<in A, in E> {
    readonly _A: Types.Contravariant<A>
    readonly _E: Types.Contravariant<E>
  }
}

/**
 * Namespace containing type definitions for TxDequeue variance annotations.
 *
 * @example
 * ```ts
 * import type { TxQueue } from "effect"
 *
 * // Use variance types for type-level operations
 * declare const variance: TxQueue.TxDequeue.Variance<number, Error>
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export declare namespace TxDequeue {
  /**
   * Variance annotation interface for TxDequeue covariance.
   *
   * @example
   * ```ts
   * import type { TxQueue } from "effect"
   *
   * // Demonstrates covariant type behavior for both A and E
   * declare const variance: TxQueue.TxDequeue.Variance<string, Error>
   * ```
   *
   * @since 4.0.0
   * @category models
   */
  export interface Variance<out A, out E> {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
  }
}

/**
 * Namespace containing type definitions for TxQueue variance annotations.
 *
 * @example
 * ```ts
 * import type { TxQueue } from "effect"
 *
 * // Use variance types for type-level operations
 * declare const variance: TxQueue.TxQueue.Variance<number, Error>
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export declare namespace TxQueue {
  /**
   * Variance annotation interface for TxQueue invariance.
   *
   * @example
   * ```ts
   * import type { TxQueue } from "effect"
   *
   * // Demonstrates invariant type behavior for both A and E
   * declare const variance: TxQueue.TxQueue.Variance<string, Error>
   * ```
   *
   * @since 4.0.0
   * @category models
   */
  export interface Variance<in out A, in out E> {
    readonly _A: Types.Invariant<A>
    readonly _E: Types.Invariant<E>
  }
}

/**
 * Represents the shared state of a transactional queue that can be inspected.
 * This interface contains the core properties needed for queue state inspection
 * operations like size, capacity, and completion status.
 *
 * @since 4.0.0
 * @category models
 */
export interface TxQueueState extends Inspectable {
  readonly strategy: "bounded" | "unbounded" | "dropping" | "sliding"
  readonly capacity: number
  readonly items: TxChunk.TxChunk<any>
  readonly stateRef: TxRef.TxRef<State<any, any>>
}

/**
 * A TxEnqueue represents the write-only interface of a transactional queue, providing
 * operations for adding elements (enqueue operations) and inspecting queue state.
 *
 * @example
 * ```ts
 * import type { Cause } from "effect"
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Queue without error channel
 *   const queue = yield* TxQueue.bounded<number>(10)
 *   const accepted = yield* TxQueue.offer(queue, 42)
 *
 *   // Queue with error channel for completion signaling
 *   const faultTolerantQueue = yield* TxQueue.bounded<number, string>(10)
 *   yield* TxQueue.offerAll(faultTolerantQueue, [1, 2, 3])
 *   yield* TxQueue.fail(faultTolerantQueue, "processing complete")
 *
 *   // Works with Done for clean completion
 *   const completableQueue = yield* TxQueue.bounded<
 *     string,
 *     Cause.Done
 *   >(5)
 *   yield* TxQueue.offer(completableQueue, "task")
 *   yield* TxQueue.end(completableQueue)
 * })
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export interface TxEnqueue<in A, in E = never> extends TxQueueState {
  readonly [EnqueueTypeId]: TxEnqueue.Variance<A, E>
}

/**
 * A TxDequeue represents the read-only interface of a transactional queue, providing
 * operations for consuming elements (dequeue operations) and inspecting queue state.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Queue without error channel
 *   const queue = yield* TxQueue.bounded<number>(10)
 *   const item = yield* TxQueue.take(queue)
 *
 *   // Queue with error channel - errors propagate through E-channel
 *   const faultTolerantQueue = yield* TxQueue.bounded<number, string>(10)
 *   yield* TxQueue.offer(faultTolerantQueue, 42)
 *   yield* TxQueue.fail(faultTolerantQueue, "processing failed")
 *
 *   // All dequeue operations now fail with the error directly
 *   const takeResult = yield* Effect.flip(TxQueue.take(faultTolerantQueue)) // "processing failed"
 *   const peekResult = yield* Effect.flip(TxQueue.peek(faultTolerantQueue)) // "processing failed"
 * })
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export interface TxDequeue<out A, out E = never> extends TxQueueState {
  readonly [DequeueTypeId]: TxDequeue.Variance<A, E>
}

/**
 * A TxQueue represents a transactional queue data structure that provides both
 * enqueue and dequeue operations with Software Transactional Memory (STM) semantics.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a bounded transactional queue (E defaults to never)
 *   const queue = yield* TxQueue.bounded<number>(10)
 *
 *   // Single operations - automatically transactional
 *   const accepted = yield* TxQueue.offer(queue, 42)
 *   const item = yield* TxQueue.take(queue) // Effect<number, never>
 *   console.log(item) // 42
 *
 *   // Queue with error channel
 *   const faultTolerantQueue = yield* TxQueue.bounded<number, string>(10)
 *
 *   // Operations can handle queue-level failures
 *   yield* TxQueue.shutdown(faultTolerantQueue)
 *   const result = yield* Effect.flip(TxQueue.take(faultTolerantQueue)) // never
 * })
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export interface TxQueue<in out A, in out E = never> extends TxEnqueue<A, E>, TxDequeue<A, E> {
  readonly [TypeId]: TxQueue.Variance<A, E>
}

/**
 * Checks if the given value is a TxEnqueue.
 *
 * @example
 * ```ts
 * import { TxQueue } from "effect"
 *
 * declare const someValue: unknown
 *
 * if (TxQueue.isTxEnqueue(someValue)) {
 *   // someValue is now typed as TxEnqueue<unknown, unknown>
 *   console.log("This is a TxEnqueue")
 * }
 * ```
 *
 * @since 4.0.0
 * @category guards
 */
export const isTxEnqueue = <A = unknown, E = unknown>(u: unknown): u is TxEnqueue<A, E> => hasProperty(u, EnqueueTypeId)

/**
 * Checks if the given value is a TxDequeue.
 *
 * @example
 * ```ts
 * import { TxQueue } from "effect"
 *
 * declare const someValue: unknown
 *
 * if (TxQueue.isTxDequeue(someValue)) {
 *   // someValue is now typed as TxDequeue<unknown, unknown>
 *   console.log("This is a TxDequeue")
 * }
 * ```
 *
 * @since 4.0.0
 * @category guards
 */
export const isTxDequeue = <A = unknown, E = unknown>(u: unknown): u is TxDequeue<A, E> => hasProperty(u, DequeueTypeId)

/**
 * Checks if the given value is a TxQueue.
 *
 * @example
 * ```ts
 * import { TxQueue } from "effect"
 *
 * declare const someValue: unknown
 *
 * if (TxQueue.isTxQueue(someValue)) {
 *   // someValue is now typed as TxQueue<unknown, unknown>
 *   console.log("This is a TxQueue")
 * }
 * ```
 *
 * @since 4.0.0
 * @category guards
 */
export const isTxQueue = <A = unknown, E = unknown>(u: unknown): u is TxQueue<A, E> => hasProperty(u, TypeId)

// =============================================================================
// Proto
// =============================================================================

const TxQueueProto = {
  [EnqueueTypeId]: { _A: (_: never) => _, _E: (_: never) => _ },
  [DequeueTypeId]: { _A: (_: never) => _, _E: (_: never) => _ },
  [TypeId]: { _A: (_: never) => _, _E: (_: never) => _ },
  [NodeInspectSymbol](this: TxQueue<unknown, unknown>) {
    return toJson(this)
  },
  toString(this: TxQueue<unknown, unknown>) {
    return `TxQueue(${this.strategy}, ${this.capacity})`
  },
  toJSON(this: TxQueue<unknown, unknown>) {
    return {
      _id: "TxQueue",
      strategy: this.strategy,
      capacity: this.capacity
    }
  }
}

// =============================================================================
// Constructors
// =============================================================================

/**
 * Creates a new bounded `TxQueue` with the specified capacity.
 *
 * **Return behavior**: This function returns a new TxQueue reference with
 * the specified capacity. No existing TxQueue instances are modified.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a bounded queue (E defaults to never)
 *   const queue = yield* TxQueue.bounded<number>(10)
 *
 *   // Create a bounded queue with error channel
 *   const faultTolerantQueue = yield* TxQueue.bounded<number, string>(10)
 *
 *   // Offer items - will succeed until capacity is reached
 *   yield* TxQueue.offer(queue, 1)
 *   yield* TxQueue.offer(queue, 2)
 *
 *   const item = yield* TxQueue.take(queue)
 *   console.log(item) // 1
 * })
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const bounded = <A = never, E = never>(
  capacity: number
): Effect.Effect<TxQueue<A, E>, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const items = yield* TxChunk.empty<A>()
    const stateRef = yield* TxRef.make<State<A, E>>({ _tag: "Open" })

    const txQueue = Object.create(TxQueueProto)
    txQueue.strategy = "bounded"
    txQueue.capacity = capacity
    txQueue.items = items
    txQueue.stateRef = stateRef
    return txQueue
  })

/**
 * Creates a new unbounded `TxQueue` with unlimited capacity.
 *
 * **Return behavior**: This function returns a new TxQueue reference with
 * unlimited capacity. No existing TxQueue instances are modified.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create an unbounded queue (E defaults to never)
 *   const queue = yield* TxQueue.unbounded<string>()
 *
 *   // Create an unbounded queue with error channel
 *   const faultTolerantQueue = yield* TxQueue.unbounded<string, Error>()
 *
 *   // Can offer unlimited items
 *   yield* TxQueue.offer(queue, "hello")
 *   yield* TxQueue.offer(queue, "world")
 *
 *   const size = yield* TxQueue.size(queue)
 *   console.log(size) // 2
 * })
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const unbounded = <A = never, E = never>(): Effect.Effect<TxQueue<A, E>, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const items = yield* TxChunk.empty<A>()
    const stateRef = yield* TxRef.make<State<A, E>>({ _tag: "Open" })

    const txQueue = Object.create(TxQueueProto)
    txQueue.strategy = "unbounded"
    txQueue.capacity = Number.POSITIVE_INFINITY
    txQueue.items = items
    txQueue.stateRef = stateRef
    return txQueue
  })

/**
 * Creates a new dropping `TxQueue` with the specified capacity that drops new items when full.
 *
 * **Return behavior**: This function returns a new TxQueue reference with
 * dropping strategy. No existing TxQueue instances are modified.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a dropping queue with capacity 2
 *   const queue = yield* TxQueue.dropping<number>(2)
 *
 *   // Fill to capacity
 *   yield* TxQueue.offer(queue, 1)
 *   yield* TxQueue.offer(queue, 2)
 *
 *   // This will be dropped (returns false)
 *   const accepted = yield* TxQueue.offer(queue, 3)
 *   console.log(accepted) // false
 * })
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const dropping = <A = never, E = never>(
  capacity: number
): Effect.Effect<TxQueue<A, E>, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const items = yield* TxChunk.empty<A>()
    const stateRef = yield* TxRef.make<State<A, E>>({ _tag: "Open" })

    const txQueue = Object.create(TxQueueProto)
    txQueue.strategy = "dropping"
    txQueue.capacity = capacity
    txQueue.items = items
    txQueue.stateRef = stateRef
    return txQueue
  })

/**
 * Creates a new sliding `TxQueue` with the specified capacity that evicts old items when full.
 *
 * **Return behavior**: This function returns a new TxQueue reference with
 * sliding strategy. No existing TxQueue instances are modified.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Create a sliding queue with capacity 2
 *   const queue = yield* TxQueue.sliding<number>(2)
 *
 *   // Fill to capacity
 *   yield* TxQueue.offer(queue, 1)
 *   yield* TxQueue.offer(queue, 2)
 *
 *   // This will evict item 1 and add 3
 *   yield* TxQueue.offer(queue, 3)
 *
 *   const item = yield* TxQueue.take(queue)
 *   console.log(item) // 2 (item 1 was evicted)
 * })
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const sliding = <A = never, E = never>(
  capacity: number
): Effect.Effect<TxQueue<A, E>, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const items = yield* TxChunk.empty<A>()
    const stateRef = yield* TxRef.make<State<A, E>>({ _tag: "Open" })

    const txQueue = Object.create(TxQueueProto)
    txQueue.strategy = "sliding"
    txQueue.capacity = capacity
    txQueue.items = items
    txQueue.stateRef = stateRef
    return txQueue
  })

// =============================================================================
// Core Queue Operations
// =============================================================================

/**
 * Offers an item to the queue.
 *
 * **Mutation behavior**: This function mutates the original TxQueue by adding
 * the item according to the queue's strategy. It does not return a new TxQueue reference.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(10)
 *
 *   // Offer an item - returns true if accepted
 *   const accepted = yield* TxQueue.offer(queue, 42)
 *   console.log(accepted) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const offer: {
  <A, E>(value: A): (self: TxEnqueue<A, E>) => Effect.Effect<boolean, never, Effect.Transaction>
  <A, E>(self: TxEnqueue<A, E>, value: A): Effect.Effect<boolean, never, Effect.Transaction>
} = dual(
  2,
  <A, E>(self: TxEnqueue<A, E>, value: A): Effect.Effect<boolean, never, Effect.Transaction> =>
    Effect.gen(function*() {
      const state = yield* TxRef.get(self.stateRef)
      if (state._tag === "Done" || state._tag === "Closing") {
        return false
      }

      const currentSize = yield* size(self)

      // Unbounded - always accept
      if (self.strategy === "unbounded") {
        yield* TxChunk.append(self.items, value)
        return true
      }

      // For bounded queues, check capacity
      if (currentSize < self.capacity) {
        yield* TxChunk.append(self.items, value)
        return true
      }

      // Queue is at capacity, strategy-specific behavior
      if (self.strategy === "dropping") {
        return false // Drop the new item
      }

      if (self.strategy === "sliding") {
        yield* TxChunk.drop(self.items, 1) // Remove oldest item
        yield* TxChunk.append(self.items, value) // Add new item
        return true
      }

      // bounded strategy - block until space is available
      return yield* Effect.retryTransaction
    })
)

/**
 * Offers multiple items to the queue.
 *
 * Returns an array of items that were rejected (not added to the queue).
 *
 * **Mutation behavior**: This function mutates the original TxQueue by adding
 * items according to the queue's strategy. It does not return a new TxQueue reference.
 *
 * @example
 * ```ts
 * import { Chunk, Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(10)
 *
 *   // Offer multiple items - returns rejected items as array
 *   const rejected = yield* TxQueue.offerAll(queue, [1, 2, 3, 4, 5])
 *   console.log(rejected) // [] if all accepted
 *   console.log(rejected.length) // 0
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const offerAll: {
  <A, E>(values: Iterable<A>): (self: TxEnqueue<A, E>) => Effect.Effect<Array<A>, never, Effect.Transaction>
  <A, E>(self: TxEnqueue<A, E>, values: Iterable<A>): Effect.Effect<Array<A>, never, Effect.Transaction>
} = dual(
  2,
  <A, E>(self: TxEnqueue<A, E>, values: Iterable<A>): Effect.Effect<Array<A>, never, Effect.Transaction> =>
    Effect.gen(function*() {
      const rejected: Array<A> = []

      for (const value of values) {
        const accepted = yield* offer(self, value)
        if (!accepted) {
          rejected.push(value)
        }
      }

      return rejected
    })
)

/**
 * Takes an item from the queue.
 *
 * **Mutation behavior**: This function mutates the original TxQueue by removing
 * the first item. It does not return a new TxQueue reference.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number, string>(10)
 *   yield* TxQueue.offer(queue, 42)
 *
 *   // Take an item - blocks if empty
 *   const item = yield* TxQueue.take(queue)
 *   console.log(item) // 42
 *
 *   // When queue fails, take fails with the same error
 *   yield* TxQueue.fail(queue, "queue error")
 *   const result = yield* Effect.flip(TxQueue.take(queue))
 *   console.log(result) // "queue error"
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const take = <A, E>(self: TxDequeue<A, E>): Effect.Effect<A, E, Effect.Transaction> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)

    // Check if queue is done - forward the cause directly
    if (state._tag === "Done") {
      return yield* Effect.failCause(state.cause)
    }

    // If no items available, retry transaction
    if (yield* isEmpty(self)) {
      return yield* Effect.retryTransaction
    }

    // Take item from queue
    const chunk = yield* TxChunk.get(self.items)
    const head = Chunk.head(chunk)
    if (Option.isNone(head)) {
      return yield* Effect.retryTransaction
    }

    yield* TxChunk.drop(self.items, 1)

    // Check if we need to transition Closing → Done
    if (state._tag === "Closing" && (yield* isEmpty(self))) {
      yield* TxRef.set(self.stateRef, { _tag: "Done", cause: state.cause })
    }

    return head.value
  })

/**
 * Tries to take an item from the queue without blocking.
 *
 * @example
 * ```ts
 * import { Effect, Option, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(10)
 *
 *   // Poll returns Option.none if empty
 *   const maybe = yield* TxQueue.poll(queue)
 *   console.log(Option.isNone(maybe)) // true
 *
 *   yield* TxQueue.offer(queue, 42)
 *   const item = yield* TxQueue.poll(queue)
 *   console.log(Option.getOrNull(item)) // 42
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const poll = <A, E>(self: TxDequeue<A, E>): Effect.Effect<Option.Option<A>, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    if (state._tag === "Done") {
      return Option.none()
    }

    const chunk = yield* TxChunk.get(self.items)
    const head = Chunk.head(chunk)
    if (Option.isNone(head)) {
      return Option.none()
    }

    yield* TxChunk.drop(self.items, 1)
    return Option.some(head.value)
  })

/**
 * Takes all items from the queue. Blocks if the queue is empty.
 *
 * If the queue is already in a failed state, the error is propagated through the E-channel.
 * Follows the same patterns as `take` - waits when there are no elements.
 *
 * Returns a non-empty array since it blocks until at least one item is available.
 *
 * **Mutation behavior**: This function mutates the original TxQueue by removing
 * all items. It does not return a new TxQueue reference.
 *
 * @example
 * ```ts
 * import { Array, Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number, string>(10)
 *   yield* TxQueue.offerAll(queue, [1, 2, 3, 4, 5])
 *
 *   // Take all items atomically - returns NonEmptyArray
 *   const items = yield* TxQueue.takeAll(queue)
 *   console.log(items) // [1, 2, 3, 4, 5]
 *   console.log(Array.isArrayNonEmpty(items)) // true
 * })
 *
 * // Error propagation example
 * const errorExample = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number, string>(5)
 *   yield* TxQueue.offerAll(queue, [1, 2])
 *   yield* TxQueue.fail(queue, "processing error")
 *
 *   // takeAll() propagates the queue error through E-channel
 *   const result = yield* Effect.flip(TxQueue.takeAll(queue))
 *   console.log(result) // "processing error"
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const takeAll = <A, E>(self: TxDequeue<A, E>): Effect.Effect<Arr.NonEmptyArray<A>, E, Effect.Transaction> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)

    // Handle done queue
    if (state._tag === "Done") {
      return yield* Effect.failCause(state.cause)
    }

    // Wait if empty - same pattern as take()
    if (yield* isEmpty(self)) {
      return yield* Effect.retryTransaction
    }

    const chunk = yield* TxChunk.get(self.items)

    // Take all items (guaranteed non-empty due to isEmpty check above)
    const items = Chunk.toArray(chunk) as Arr.NonEmptyArray<A>
    yield* TxChunk.set(self.items, Chunk.empty())

    // Check if we need to transition Closing → Done
    if (state._tag === "Closing") {
      yield* TxRef.set(self.stateRef, { _tag: "Done", cause: state.cause })
    }

    return items
  })

/**
 * Takes exactly N items from the queue in a single atomic transaction.
 *
 * This function waits (retries the transaction) until N items are available, then takes
 * exactly N items. The only exception is when N exceeds the queue's capacity - in that
 * case, it takes up to the queue's capacity and returns immediately.
 *
 * **Behavior**:
 * - **Normal case**: Waits for exactly N items to be available
 * - **Bounded queue with N > capacity**: Takes up to capacity items immediately
 * - **Closing queue**: Takes available items and transitions to Done state
 *
 * **Mutation behavior**: This function mutates the original TxQueue by removing
 * the taken items. It does not return a new TxQueue reference.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(5)
 *   yield* TxQueue.offerAll(queue, [1, 2, 3])
 *
 *   // This will wait until 4 items are available
 *   // (will retry transaction until more items are offered)
 *   const items = yield* TxQueue.takeN(queue, 4)
 *
 *   // This requests more than capacity (5), so takes all available (up to 5)
 *   const all = yield* TxQueue.takeN(queue, 10) // Takes at most 5 items
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const takeN: {
  (n: number): <A, E>(self: TxDequeue<A, E>) => Effect.Effect<Array<A>, E, Effect.Transaction>
  <A, E>(self: TxDequeue<A, E>, n: number): Effect.Effect<Array<A>, E, Effect.Transaction>
} = dual(
  2,
  <A, E>(self: TxDequeue<A, E>, n: number): Effect.Effect<Array<A>, E, Effect.Transaction> =>
    Effect.gen(function*() {
      const state = yield* TxRef.get(self.stateRef)

      // Check if queue is done - forward the cause directly
      if (state._tag === "Done") {
        return yield* Effect.failCause(state.cause)
      }

      const currentSize = yield* size(self)

      // Determine how many items we can/should take
      const requestedCount = n
      const maxPossible = Math.min(requestedCount, self.capacity)

      // If we can't get the requested amount due to capacity constraints,
      // take what the capacity allows. Otherwise, wait for the full amount.
      const shouldWaitForFull = requestedCount <= self.capacity
      const minimumRequired = shouldWaitForFull ? requestedCount : maxPossible

      // If we don't have enough items available
      if (currentSize < minimumRequired) {
        // If queue is closing, transition to done and return what we have
        if (state._tag === "Closing") {
          if (yield* isEmpty(self)) {
            yield* TxRef.set(self.stateRef, { _tag: "Done", cause: state.cause })
            return []
          }
          // Take all remaining items when closing
          const chunk = yield* TxChunk.get(self.items)
          const taken = Chunk.toArray(chunk)
          yield* TxChunk.set(self.items, Chunk.empty())
          yield* TxRef.set(self.stateRef, { _tag: "Done", cause: state.cause })
          return taken
        }

        // Queue is still open but not enough items - retry transaction
        return yield* Effect.retryTransaction
      }

      // Take the determined number of items
      const toTake = minimumRequired
      const chunk = yield* TxChunk.get(self.items)
      const taken = Chunk.take(chunk, toTake)
      yield* TxChunk.drop(self.items, toTake)

      // Check if we need to transition Closing → Done
      if (state._tag === "Closing" && (yield* isEmpty(self))) {
        yield* TxRef.set(self.stateRef, { _tag: "Done", cause: state.cause })
      }

      return Chunk.toArray(taken)
    })
)

/**
 * Takes a variable number of items between a specified minimum and maximum from the queue.
 * Waits for at least the minimum number of items to be available.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(10)
 *   yield* TxQueue.offerAll(queue, [1, 2, 3, 4, 5, 6, 7, 8])
 *
 *   // Take between 2 and 5 items
 *   const batch1 = yield* TxQueue.takeBetween(queue, 2, 5)
 *   console.log(batch1) // [1, 2, 3, 4, 5] - took 5 (up to max)
 *
 *   // Take between 1 and 10 items (but only 3 remain)
 *   const batch2 = yield* TxQueue.takeBetween(queue, 1, 10)
 *   console.log(batch2) // [6, 7, 8] - took 3 (all remaining)
 *
 *   // Would wait for at least 1 item to be available
 *   // const batch3 = yield* TxQueue.takeBetween(queue, 1, 3)
 * })
 * ```
 *
 * @since 4.0.0
 * @category taking
 */
export const takeBetween: {
  (min: number, max: number): <A, E>(self: TxDequeue<A, E>) => Effect.Effect<Array<A>, E, Effect.Transaction>
  <A, E>(self: TxDequeue<A, E>, min: number, max: number): Effect.Effect<Array<A>, E, Effect.Transaction>
} = dual(
  3,
  <A, E>(self: TxDequeue<A, E>, min: number, max: number): Effect.Effect<Array<A>, E, Effect.Transaction> =>
    Effect.gen(function*() {
      const state = yield* TxRef.get(self.stateRef)

      // Check if queue is done - forward the cause directly
      if (state._tag === "Done") {
        return yield* Effect.failCause(state.cause)
      }

      // Validate parameters
      if (min <= 0 || max <= 0 || min > max) {
        return []
      }

      const currentSize = yield* size(self)

      // If we have less than minimum required items
      if (currentSize < min) {
        // If queue is closing, transition to done and return what we have
        if (state._tag === "Closing") {
          if (yield* isEmpty(self)) {
            yield* TxRef.set(self.stateRef, { _tag: "Done", cause: state.cause })
            return []
          }
          // Take all remaining items when closing (if >= min or all available)
          const chunk = yield* TxChunk.get(self.items)
          const taken = Chunk.toArray(chunk)
          yield* TxChunk.set(self.items, Chunk.empty())
          yield* TxRef.set(self.stateRef, { _tag: "Done", cause: state.cause })
          return taken
        }

        // Queue is still open but not enough items - retry transaction
        return yield* Effect.retryTransaction
      }

      // We have at least the minimum, take up to the maximum
      const toTake = Math.min(currentSize, max)
      const chunk = yield* TxChunk.get(self.items)
      const taken = Chunk.take(chunk, toTake)
      yield* TxChunk.drop(self.items, toTake)

      // Check if we need to transition Closing → Done
      if (state._tag === "Closing" && (yield* isEmpty(self))) {
        yield* TxRef.set(self.stateRef, { _tag: "Done", cause: state.cause })
      }

      return Chunk.toArray(taken)
    })
)

/**
 * Views the next item without removing it. If the queue is in a failed state,
 * the error is propagated through the E-channel.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number, string>(10)
 *   yield* TxQueue.offer(queue, 42)
 *
 *   // Peek at the next item without removing it
 *   const item = yield* TxQueue.peek(queue)
 *   console.log(item) // 42
 *
 *   // Item is still in the queue
 *   const size = yield* TxQueue.size(queue)
 *   console.log(size) // 1
 * })
 *
 * // Error handling example
 * const errorExample = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number, string>(5)
 *   yield* TxQueue.fail(queue, "queue failed")
 *
 *   // peek() propagates the queue error through E-channel
 *   const result = yield* Effect.flip(TxQueue.peek(queue))
 *   console.log(result) // "queue failed"
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const peek = <A, E>(self: TxDequeue<A, E>): Effect.Effect<A, E, Effect.Transaction> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    if (state._tag === "Done") {
      return yield* Effect.failCause(state.cause)
    }

    const chunk = yield* TxChunk.get(self.items)
    const head = Chunk.head(chunk)
    if (Option.isNone(head)) {
      return yield* Effect.retryTransaction
    }

    return head.value
  })

/**
 * Gets the current size of the queue.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(10)
 *   yield* TxQueue.offerAll(queue, [1, 2, 3])
 *
 *   const size = yield* TxQueue.size(queue)
 *   console.log(size) // 3
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const size = (self: TxQueueState): Effect.Effect<number, never, Effect.Transaction> => TxChunk.size(self.items)

/**
 * Checks if the queue is empty.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(10)
 *
 *   const empty = yield* TxQueue.isEmpty(queue)
 *   console.log(empty) // true
 *
 *   yield* TxQueue.offer(queue, 42)
 *   const stillEmpty = yield* TxQueue.isEmpty(queue)
 *   console.log(stillEmpty) // false
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const isEmpty = (self: TxQueueState): Effect.Effect<boolean, never, Effect.Transaction> =>
  TxChunk.isEmpty(self.items)

/**
 * Checks if the queue is at capacity.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(2)
 *
 *   const full = yield* TxQueue.isFull(queue)
 *   console.log(full) // false
 *
 *   yield* TxQueue.offerAll(queue, [1, 2])
 *   const nowFull = yield* TxQueue.isFull(queue)
 *   console.log(nowFull) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const isFull = (self: TxQueueState): Effect.Effect<boolean, never, Effect.Transaction> =>
  Effect.gen(function*() {
    if (self.capacity === Number.POSITIVE_INFINITY) {
      return false
    }
    const currentSize = yield* size(self)
    return currentSize >= self.capacity
  })

/**
 * Interrupts the queue, transitioning it to a closing state.
 *
 * **Mutation behavior**: This function mutates the original TxQueue by marking
 * it for graceful closure. It does not return a new TxQueue reference.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(10)
 *   yield* TxQueue.offer(queue, 42)
 *
 *   // Interrupt gracefully - allows remaining items to be consumed
 *   const result = yield* TxQueue.interrupt(queue)
 *   console.log(result) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const interrupt = <A, E>(self: TxEnqueue<A, E>): Effect.Effect<boolean, never, Effect.Transaction> =>
  Effect.withFiber((fiber) => failCause(self, Cause.interrupt(fiber.id)))

/**
 * Fails the queue with the specified error.
 *
 * **Mutation behavior**: This function mutates the original TxQueue by marking
 * it as failed. It does not return a new TxQueue reference.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number, string>(10)
 *
 *   // Fail the queue with an error
 *   const result = yield* TxQueue.fail(queue, "connection lost")
 *   console.log(result) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const fail: {
  <E>(error: E): <A>(self: TxEnqueue<A, E>) => Effect.Effect<boolean, never, Effect.Transaction>
  <A, E>(self: TxEnqueue<A, E>, error: E): Effect.Effect<boolean, never, Effect.Transaction>
} = dual(
  2,
  <A, E>(self: TxEnqueue<A, E>, error: E): Effect.Effect<boolean, never, Effect.Transaction> =>
    Effect.gen(function*() {
      const state = yield* TxRef.get(self.stateRef)

      if (state._tag !== "Open") {
        return false // Already closing/done
      }

      // Fail transitions directly to Done, clearing items
      yield* TxChunk.set(self.items, Chunk.empty())
      yield* TxRef.set(self.stateRef, { _tag: "Done", cause: Cause.fail(error) })

      return true
    })
)

/**
 * Completes the queue with the specified exit value.
 *
 * **Mutation behavior**: This function mutates the original TxQueue by marking
 * it as completed. It does not return a new TxQueue reference.
 *
 * @example
 * ```ts
 * import { Cause, Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(10)
 *
 *   // Complete with specific cause
 *   const cause = Cause.interrupt()
 *   const result = yield* TxQueue.failCause(queue, cause)
 *   console.log(result) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const failCause: {
  <E>(cause: Cause.Cause<E>): <A>(self: TxEnqueue<A, E>) => Effect.Effect<boolean, never, Effect.Transaction>
  <A, E>(self: TxEnqueue<A, E>, cause: Cause.Cause<E>): Effect.Effect<boolean, never, Effect.Transaction>
} = dual(
  2,
  <A, E>(self: TxEnqueue<A, E>, cause: Cause.Cause<E>): Effect.Effect<boolean, never, Effect.Transaction> =>
    Effect.gen(function*() {
      const state = yield* TxRef.get(self.stateRef)

      if (state._tag !== "Open") {
        return false // Already closing/done
      }

      if (yield* isEmpty(self)) {
        // Can transition directly to Done
        yield* TxRef.set(self.stateRef, { _tag: "Done", cause })
      } else {
        // Need to go through Closing state
        yield* TxRef.set(self.stateRef, { _tag: "Closing", cause })
      }

      return true
    })
)

/**
 * Ends a queue by signaling completion with a Done error.
 *
 * This function provides a clean way to signal the end of a queue by calling
 * `failCause` with `Cause.Done`. This is a convenience function for
 * queues that are typed to accept `Cause.Done` in their error channel.
 * When a queue is ended, all subsequent operations (take, peek, etc.) will fail with
 * `Cause.Done`, propagating through the E-channel.
 *
 * @example
 * ```ts
 * import { Cause, Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number, Cause.Done>(10)
 *   yield* TxQueue.offer(queue, 1)
 *   yield* TxQueue.offer(queue, 2)
 *
 *   // Signal the end of the queue
 *   const result = yield* TxQueue.end(queue)
 *   console.log(result) // true
 *
 *   // All operations will now fail with Done
 *   const takeResult = yield* Effect.flip(TxQueue.take(queue))
 *   console.log(Cause.isDone(takeResult)) // true
 *
 *   const peekResult = yield* Effect.flip(TxQueue.peek(queue))
 *   console.log(Cause.isDone(peekResult)) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const end = <A, E>(self: TxEnqueue<A, E | Cause.Done>): Effect.Effect<boolean, never, Effect.Transaction> =>
  failCause(self, Cause.fail(Cause.Done()))

/**
 * Clears all elements from the queue without affecting its state.
 * Returns the cleared elements, or an empty array if the queue is done with Done or interrupt.
 *
 * **Mutation behavior**: This function mutates the original TxQueue by removing
 * all elements. It does not return a new TxQueue reference.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(10)
 *   yield* TxQueue.offerAll(queue, [1, 2, 3, 4, 5])
 *
 *   const sizeBefore = yield* TxQueue.size(queue)
 *   console.log(sizeBefore) // 5
 *
 *   const cleared = yield* TxQueue.clear(queue)
 *   console.log(cleared) // [1, 2, 3, 4, 5]
 *
 *   const sizeAfter = yield* TxQueue.size(queue)
 *   console.log(sizeAfter) // 0
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const clear = <A, E>(self: TxEnqueue<A, E>): Effect.Effect<Array<A>, ExcludeDone<E>, Effect.Transaction> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    if (state._tag === "Done") {
      // Return empty array only for halt causes (like Cause.Done)
      if (isDoneCause(state.cause)) {
        return []
      }
      return yield* Effect.failCause(state.cause)
    }
    const chunk = yield* TxChunk.get(self.items)
    yield* TxChunk.set(self.items, Chunk.empty())
    return Chunk.toArray(chunk)
  })

/**
 * Shuts down the queue immediately by clearing all items and interrupting it (legacy compatibility).
 *
 * This operation performs two atomic steps:
 * 1. **Clears** all items from the queue using `clear()`
 * 2. **Interrupts** the queue using `interrupt()`
 *
 * **Mutation behavior**: This function mutates the original TxQueue by clearing
 * its contents and marking it as shutdown. It does not return a new TxQueue reference.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(10)
 *   yield* TxQueue.offerAll(queue, [1, 2, 3, 4, 5])
 *
 *   const sizeBefore = yield* TxQueue.size(queue)
 *   console.log(sizeBefore) // 5
 *
 *   yield* TxQueue.shutdown(queue)
 *
 *   const sizeAfter = yield* TxQueue.size(queue)
 *   console.log(sizeAfter) // 0 (cleared)
 *
 *   const isShutdown = yield* TxQueue.isShutdown(queue)
 *   console.log(isShutdown) // true (interrupted)
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const shutdown = <A, E>(self: TxEnqueue<A, E>): Effect.Effect<boolean, never, Effect.Transaction> =>
  Effect.gen(function*() {
    yield* Effect.ignore(clear(self))
    return yield* interrupt(self)
  })

/**
 * Checks if the queue is in the open state.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(10)
 *
 *   const open = yield* TxQueue.isOpen(queue)
 *   console.log(open) // true
 *
 *   yield* TxQueue.interrupt(queue)
 *   const stillOpen = yield* TxQueue.isOpen(queue)
 *   console.log(stillOpen) // false
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const isOpen = (self: TxQueueState): Effect.Effect<boolean, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    return state._tag === "Open"
  })

/**
 * Checks if the queue is in the closing state.
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(10)
 *   yield* TxQueue.offer(queue, 42)
 *
 *   const closing = yield* TxQueue.isClosing(queue)
 *   console.log(closing) // false
 *
 *   yield* TxQueue.interrupt(queue)
 *   const nowClosing = yield* TxQueue.isClosing(queue)
 *   console.log(nowClosing) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const isClosing = (self: TxQueueState): Effect.Effect<boolean, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    return state._tag === "Closing"
  })

/**
 * Checks if the queue is done (completed or failed).
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(10)
 *
 *   const done = yield* TxQueue.isDone(queue)
 *   console.log(done) // false
 *
 *   yield* TxQueue.interrupt(queue)
 *   const nowDone = yield* TxQueue.isDone(queue)
 *   console.log(nowDone) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const isDone = (self: TxQueueState): Effect.Effect<boolean, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    return state._tag === "Done"
  })

/**
 * Checks if the queue is shutdown (legacy compatibility).
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number>(10)
 *
 *   const isShutdown = yield* TxQueue.isShutdown(queue)
 *   console.log(isShutdown) // false
 *
 *   yield* TxQueue.shutdown(queue)
 *   const nowShutdown = yield* TxQueue.isShutdown(queue)
 *   console.log(nowShutdown) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const isShutdown = (self: TxQueueState): Effect.Effect<boolean, never, Effect.Transaction> => isDone(self)

/**
 * Waits for the queue to complete (either successfully or with failure).
 *
 * @example
 * ```ts
 * import { Effect, TxQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* TxQueue.bounded<number, string>(10)
 *
 *   // In another fiber, end the queue
 *   yield* Effect.forkChild(Effect.delay(TxQueue.interrupt(queue), "100 millis"))
 *
 *   // Wait for completion - succeeds when queue ends
 *   yield* TxQueue.awaitCompletion(queue)
 *   console.log("Queue completed successfully")
 * })
 * ```
 *
 * @since 4.0.0
 * @category combinators
 */
export const awaitCompletion = (self: TxQueueState): Effect.Effect<void, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)

    if (state._tag === "Done") {
      return void 0
    }

    // Not done yet, retry transaction
    return yield* Effect.retryTransaction
  })

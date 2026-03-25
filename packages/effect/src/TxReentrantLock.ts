/**
 * TxReentrantLock is a transactional read/write lock with reentrant semantics using Software
 * Transactional Memory (STM). Multiple readers can hold the lock concurrently, OR a single
 * writer can hold exclusive access. A fiber holding a write lock may acquire additional
 * read or write locks (reentrancy).
 *
 * @since 4.0.0
 */
import * as Effect from "./Effect.ts"
import * as HashMap from "./HashMap.ts"
import type { Inspectable } from "./Inspectable.ts"
import { NodeInspectSymbol, toJson } from "./Inspectable.ts"
import * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import type * as Scope from "./Scope.ts"
import * as TxRef from "./TxRef.ts"

const TypeId = "~effect/transactions/TxReentrantLock"

/**
 * @since 4.0.0
 * @category models
 */
interface LockState {
  readonly readers: HashMap.HashMap<number, number>
  readonly writer: Option.Option<readonly [fiberId: number, count: number]>
}

const emptyState: LockState = {
  readers: HashMap.empty<number, number>(),
  writer: Option.none()
}

/**
 * A TxReentrantLock provides a transactional read/write lock with reentrant semantics.
 * Multiple readers can hold the lock concurrently, or a single writer can hold exclusive
 * access. A fiber holding the write lock may acquire additional read/write locks (reentrancy).
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *
 *   // Multiple readers can proceed concurrently
 *   yield* TxReentrantLock.withReadLock(lock, Effect.succeed("reading"))
 *
 *   // Writer gets exclusive access
 *   yield* TxReentrantLock.withWriteLock(lock, Effect.succeed("writing"))
 * })
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export interface TxReentrantLock extends Inspectable, Pipeable {
  readonly [TypeId]: typeof TypeId
  /** @internal */
  readonly stateRef: TxRef.TxRef<LockState>
}

const TxReentrantLockProto: Omit<TxReentrantLock, typeof TypeId | "stateRef"> = {
  [NodeInspectSymbol](this: TxReentrantLock) {
    return toJson(this)
  },
  toJSON(this: TxReentrantLock) {
    return { _id: "TxReentrantLock" }
  },
  toString() {
    return "TxReentrantLock"
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

// =============================================================================
// Constructors
// =============================================================================

/**
 * Creates a new TxReentrantLock.
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const isLocked = yield* TxReentrantLock.locked(lock)
 *   console.log(isLocked) // false
 * })
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const make = (): Effect.Effect<TxReentrantLock, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const stateRef = yield* TxRef.make<LockState>(emptyState)
    const self = Object.create(TxReentrantLockProto)
    self[TypeId] = TypeId
    self.stateRef = stateRef
    return self
  })

// =============================================================================
// Mutations
// =============================================================================

/**
 * Acquires a read lock. Blocks if another fiber holds the write lock.
 * If the current fiber already holds the write lock, the read lock is granted (reentrancy).
 * Returns the current number of read locks held by this fiber.
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const count = yield* TxReentrantLock.acquireRead(lock)
 *   console.log(count) // 1
 *   yield* TxReentrantLock.releaseRead(lock)
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const acquireRead = (self: TxReentrantLock): Effect.Effect<number, never, Effect.Transaction> =>
  Effect.withFiber((fiber) =>
    Effect.gen(function*() {
      const state = yield* TxRef.get(self.stateRef)
      const fiberId = fiber.id

      // If another fiber holds the write lock, retry
      if (Option.isSome(state.writer) && state.writer.value[0] !== fiberId) {
        return yield* Effect.retryTransaction
      }

      // Grant read lock
      const currentCount = Option.getOrElse(HashMap.get(state.readers, fiberId), () => 0)
      const newCount = currentCount + 1
      yield* TxRef.set(self.stateRef, {
        ...state,
        readers: HashMap.set(state.readers, fiberId, newCount)
      })
      return newCount
    })
  )

/**
 * Acquires a write lock. Blocks if any other fiber holds any lock.
 * If the current fiber already holds the write lock, the count is incremented (reentrancy).
 * If the current fiber holds a read lock, the write lock is granted (upgrade).
 * Returns the current number of write locks held by this fiber.
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const count = yield* TxReentrantLock.acquireWrite(lock)
 *   console.log(count) // 1
 *   yield* TxReentrantLock.releaseWrite(lock)
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const acquireWrite = (self: TxReentrantLock): Effect.Effect<number, never, Effect.Transaction> =>
  Effect.withFiber((fiber) =>
    Effect.gen(function*() {
      const state = yield* TxRef.get(self.stateRef)
      const fiberId = fiber.id

      // If another fiber holds the write lock, retry
      if (Option.isSome(state.writer) && state.writer.value[0] !== fiberId) {
        return yield* Effect.retryTransaction
      }

      // If other fibers hold read locks, retry
      for (const [readerId] of state.readers) {
        if (readerId !== fiberId && Option.getOrElse(HashMap.get(state.readers, readerId), () => 0) > 0) {
          return yield* Effect.retryTransaction
        }
      }

      // Grant write lock
      if (Option.isSome(state.writer)) {
        // Reentrant: increment write count
        const newCount = state.writer.value[1] + 1
        yield* TxRef.set(self.stateRef, {
          ...state,
          writer: Option.some([fiberId, newCount] as const)
        })
        return newCount
      }

      // First write lock acquisition
      yield* TxRef.set(self.stateRef, {
        ...state,
        writer: Option.some([fiberId, 1] as const)
      })
      return 1
    })
  )

/**
 * Releases a read lock held by the current fiber.
 * Returns the remaining number of read locks held by this fiber.
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   yield* TxReentrantLock.acquireRead(lock)
 *   const remaining = yield* TxReentrantLock.releaseRead(lock)
 *   console.log(remaining) // 0
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const releaseRead = (self: TxReentrantLock): Effect.Effect<number, never, Effect.Transaction> =>
  Effect.withFiber((fiber) =>
    Effect.gen(function*() {
      const state = yield* TxRef.get(self.stateRef)
      const fiberId = fiber.id
      const currentCount = Option.getOrElse(HashMap.get(state.readers, fiberId), () => 0)

      if (currentCount <= 0) return 0

      const newCount = currentCount - 1
      const newReaders = newCount === 0
        ? HashMap.remove(state.readers, fiberId)
        : HashMap.set(state.readers, fiberId, newCount)

      yield* TxRef.set(self.stateRef, { ...state, readers: newReaders })
      return newCount
    })
  )

/**
 * Releases a write lock held by the current fiber.
 * Returns the remaining number of write locks held by this fiber.
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   yield* TxReentrantLock.acquireWrite(lock)
 *   const remaining = yield* TxReentrantLock.releaseWrite(lock)
 *   console.log(remaining) // 0
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const releaseWrite = (self: TxReentrantLock): Effect.Effect<number, never, Effect.Transaction> =>
  Effect.withFiber((fiber) =>
    Effect.gen(function*() {
      const state = yield* TxRef.get(self.stateRef)
      const fiberId = fiber.id

      if (Option.isNone(state.writer) || state.writer.value[0] !== fiberId) return 0

      const newCount = state.writer.value[1] - 1
      const newWriter = newCount <= 0
        ? Option.none<readonly [number, number]>()
        : Option.some([fiberId, newCount] as const)

      yield* TxRef.set(self.stateRef, { ...state, writer: newWriter })
      return newCount
    })
  )

/**
 * Acquires a read lock for the duration of the scope.
 * The lock is automatically released when the scope closes.
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *
 *   yield* Effect.scoped(
 *     Effect.gen(function*() {
 *       yield* TxReentrantLock.readLock(lock)
 *       // read lock is held for the duration of the scope
 *     })
 *   )
 *   // read lock is released
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const readLock = (self: TxReentrantLock): Effect.Effect<number, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.transaction(acquireRead(self)),
    () => Effect.transaction(releaseRead(self))
  )

/**
 * Acquires a write lock for the duration of the scope.
 * The lock is automatically released when the scope closes.
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *
 *   yield* Effect.scoped(
 *     Effect.gen(function*() {
 *       yield* TxReentrantLock.writeLock(lock)
 *       // write lock is held for the duration of the scope
 *     })
 *   )
 *   // write lock is released
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const writeLock = (self: TxReentrantLock): Effect.Effect<number, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.transaction(acquireWrite(self)),
    () => Effect.transaction(releaseWrite(self))
  )

/**
 * Alias for `writeLock`. Acquires a write lock for the duration of the scope.
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *
 *   yield* Effect.scoped(
 *     Effect.gen(function*() {
 *       yield* TxReentrantLock.lock(lock)
 *       // exclusive lock is held
 *     })
 *   )
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const lock = writeLock

/**
 * Runs the provided effect while holding a read lock. The lock is automatically
 * released after the effect completes, fails, or is interrupted.
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const result = yield* TxReentrantLock.withReadLock(
 *     lock,
 *     Effect.succeed("read data")
 *   )
 *   console.log(result) // "read data"
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const withReadLock: {
  <A, E, R>(effect: Effect.Effect<A, E, R>): (self: TxReentrantLock) => Effect.Effect<A, E, R>
  <A, E, R>(self: TxReentrantLock, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = ((...args: Array<any>) => {
  if (args.length === 1) {
    const [effect] = args
    return (self: TxReentrantLock) =>
      Effect.acquireUseRelease(
        Effect.transaction(acquireRead(self)),
        () => effect,
        () => Effect.transaction(releaseRead(self))
      )
  }
  const [self, effect] = args
  return Effect.acquireUseRelease(
    Effect.transaction(acquireRead(self)),
    () => effect,
    () => Effect.transaction(releaseRead(self))
  )
}) as any

/**
 * Runs the provided effect while holding a write lock. The lock is automatically
 * released after the effect completes, fails, or is interrupted.
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const result = yield* TxReentrantLock.withWriteLock(
 *     lock,
 *     Effect.succeed("wrote data")
 *   )
 *   console.log(result) // "wrote data"
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const withWriteLock: {
  <A, E, R>(effect: Effect.Effect<A, E, R>): (self: TxReentrantLock) => Effect.Effect<A, E, R>
  <A, E, R>(self: TxReentrantLock, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = ((...args: Array<any>) => {
  if (args.length === 1) {
    const [effect] = args
    return (self: TxReentrantLock) =>
      Effect.acquireUseRelease(
        Effect.transaction(acquireWrite(self)),
        () => effect,
        () => Effect.transaction(releaseWrite(self))
      )
  }
  const [self, effect] = args
  return Effect.acquireUseRelease(
    Effect.transaction(acquireWrite(self)),
    () => effect,
    () => Effect.transaction(releaseWrite(self))
  )
}) as any

/**
 * Alias for `withWriteLock`. Runs the provided effect while holding a write lock.
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const result = yield* TxReentrantLock.withLock(
 *     lock,
 *     Effect.succeed("exclusive operation")
 *   )
 *   console.log(result) // "exclusive operation"
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const withLock: {
  <A, E, R>(effect: Effect.Effect<A, E, R>): (self: TxReentrantLock) => Effect.Effect<A, E, R>
  <A, E, R>(self: TxReentrantLock, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = withWriteLock

// =============================================================================
// Getters
// =============================================================================

/**
 * Returns the total number of read locks held across all fibers.
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   yield* TxReentrantLock.acquireRead(lock)
 *   const count = yield* TxReentrantLock.readLocks(lock)
 *   console.log(count) // 1
 *   yield* TxReentrantLock.releaseRead(lock)
 * })
 * ```
 *
 * @since 4.0.0
 * @category getters
 */
export const readLocks = (self: TxReentrantLock): Effect.Effect<number, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    let total = 0
    for (const [, count] of state.readers) {
      total += count
    }
    return total
  })

/**
 * Returns the number of write locks held (0 or the reentrant count).
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const count = yield* TxReentrantLock.writeLocks(lock)
 *   console.log(count) // 0
 * })
 * ```
 *
 * @since 4.0.0
 * @category getters
 */
export const writeLocks = (self: TxReentrantLock): Effect.Effect<number, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    return Option.isSome(state.writer) ? state.writer.value[1] : 0
  })

/**
 * Checks if the lock is held by any fiber (read or write).
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const isLocked = yield* TxReentrantLock.locked(lock)
 *   console.log(isLocked) // false
 * })
 * ```
 *
 * @since 4.0.0
 * @category getters
 */
export const locked = (self: TxReentrantLock): Effect.Effect<boolean, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    return HashMap.size(state.readers) > 0 || Option.isSome(state.writer)
  })

/**
 * Checks if any fiber holds a read lock.
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const isReadLocked = yield* TxReentrantLock.readLocked(lock)
 *   console.log(isReadLocked) // false
 * })
 * ```
 *
 * @since 4.0.0
 * @category getters
 */
export const readLocked = (self: TxReentrantLock): Effect.Effect<boolean, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    return HashMap.size(state.readers) > 0
  })

/**
 * Checks if any fiber holds a write lock.
 *
 * @example
 * ```ts
 * import { Effect, TxReentrantLock } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const lock = yield* TxReentrantLock.make()
 *   const isWriteLocked = yield* TxReentrantLock.writeLocked(lock)
 *   console.log(isWriteLocked) // false
 * })
 * ```
 *
 * @since 4.0.0
 * @category getters
 */
export const writeLocked = (self: TxReentrantLock): Effect.Effect<boolean, never, Effect.Transaction> =>
  Effect.gen(function*() {
    const state = yield* TxRef.get(self.stateRef)
    return Option.isSome(state.writer)
  })

// =============================================================================
// Guards
// =============================================================================

/**
 * Checks if the given value is a TxReentrantLock.
 *
 * @example
 * ```ts
 * import { TxReentrantLock } from "effect"
 *
 * declare const someValue: unknown
 *
 * if (TxReentrantLock.isTxReentrantLock(someValue)) {
 *   console.log("This is a TxReentrantLock")
 * }
 * ```
 *
 * @since 4.0.0
 * @category guards
 */
export const isTxReentrantLock = (u: unknown): u is TxReentrantLock => hasProperty(u, TypeId)

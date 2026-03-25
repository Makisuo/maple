# Missing Tx Modules — Implementation Plan

## Overview

Six transactional modules from Effect v3 (STM-based `T*` modules) are missing
from the current codebase. This document specifies what to build, in what order,
and how each module maps to the existing Tx architecture.

### Current Tx Modules (already implemented)

| Module        | Wraps                      | Notes                                         |
| ------------- | -------------------------- | --------------------------------------------- |
| `TxRef`       | raw transaction journal    | Foundational primitive                        |
| `TxChunk`     | `TxRef<Chunk<A>>`          | Internal building block for TxQueue           |
| `TxHashMap`   | `TxRef<HashMap<K,V>>`      |                                               |
| `TxHashSet`   | `TxRef<HashSet<V>>`        |                                               |
| `TxQueue`     | `TxChunk` + `TxRef<State>` | Bounded/unbounded/dropping/sliding strategies |
| `TxSemaphore` | `TxRef<number>`            |                                               |

### Modules to Implement (in dependency order)

| # | Module              | v3 Name            | Internal Storage                   | Depends On                  |
| - | ------------------- | ------------------ | ---------------------------------- | --------------------------- |
| 1 | `TxDeferred`        | `TDeferred`        | `TxRef<Option<Either<A, E>>>`      | TxRef                       |
| 2 | `TxPriorityQueue`   | `TPriorityQueue`   | `TxRef<SortedMap<A, [A, ...A[]]>>` | TxRef                       |
| 3 | `TxRandom`          | `TRandom`          | `TxRef<PcgState>`                  | TxRef                       |
| 4 | `TxPubSub`          | `TPubSub`          | TxRef + TxQueue internals          | TxRef, TxQueue              |
| 5 | `TxReentrantLock`   | `TReentrantLock`   | `TxRef<LockState>`                 | TxRef                       |
| 6 | `TxSubscriptionRef` | `TSubscriptionRef` | TxRef + TxPubSub                   | TxRef, TxPubSub, TxDeferred |

---

## Conventions (from existing modules)

All new modules must follow these patterns:

- **TypeId**: `const TypeId = "~effect/transactions/TxModuleName"`
- **Prototype**: `const TxModuleProto = { [NodeInspectSymbol], toString, toJSON, pipe }`
- **Construction**: `Object.create(TxModuleProto)` + assign fields
- **Interface**: extends `Inspectable` and `Pipeable`, has `readonly [TypeId]: typeof TypeId`
- **Dual functions**: all functions with `self` parameter use `dual(arity, impl)`
- **Transactions**: single-ref ops delegate to `TxRef.modify/update/get/set`;
  multi-ref ops wrap in `Effect.atomic(Effect.gen(function*() { ... }))`
- **Blocking**: use `Effect.retryTransaction` for operations that should retry
  until a condition is met
- **JSDoc**: `@since 4.0.0`, `@category` tags, `@example` blocks with runnable
  code
- **Tests**: use `import { assert, describe, it } from "@effect/vitest"` with
  `it.effect`
- **Barrel export**: add `export * as TxModule from "./TxModule.ts"` to
  `index.ts` via `pnpm codegen`

---

## Module 1: TxDeferred

Write-once transactional promise. Readers retry until a value is set.

### Internal State

```ts
TxRef<Option<Either<A, E>>>
```

- `None` → not yet completed
- `Some(Right(a))` → succeeded with `a`
- `Some(Left(e))` → failed with `e`

### Public API

| Export             | Signature                                                        | Category     |
| ------------------ | ---------------------------------------------------------------- | ------------ |
| `TypeId`           | `"~effect/transactions/TxDeferred"`                              | symbols      |
| `TxDeferred<A, E>` | interface, invariant in both `A` and `E`                         | models       |
| `make`             | `<A, E = never>() => Effect<TxDeferred<A, E>>`                   | constructors |
| `await`            | `<A, E>(self: TxDeferred<A, E>) => Effect<A, E>`                 | getters      |
| `poll`             | `<A, E>(self: TxDeferred<A, E>) => Effect<Option<Either<A, E>>>` | getters      |
| `done`             | dual: `(self, either) => Effect<boolean>`                        | mutations    |
| `succeed`          | dual: `(self, value) => Effect<boolean>`                         | mutations    |
| `fail`             | dual: `(self, error) => Effect<boolean>`                         | mutations    |
| `isTxDeferred`     | `(u: unknown) => u is TxDeferred<unknown, unknown>`              | guards       |

### Behavior

- `await`: reads the ref; if `None`, calls `Effect.retryTransaction`; if
  `Some(Right(a))`, returns `a`; if `Some(Left(e))`, fails with `e`
- `done`/`succeed`/`fail`: if ref is `None`, sets it and returns `true`;
  if already `Some`, returns `false` (no-op)
- `poll`: reads ref and returns as-is (never retries)

### Tests (`packages/effect/test/TxDeferred.test.ts`)

Uses `import { assert, describe, it } from "@effect/vitest"` with `it.effect`.

#### constructors

- `make` creates a deferred that polls as `None`

#### getters

- `poll` returns `None` on fresh deferred
- `poll` returns `Some(Right(value))` after `succeed`
- `poll` returns `Some(Left(error))` after `fail`
- `await` returns value after `succeed`
- `await` fails with error after `fail`
- `await` retries (blocks) until completed — fork a fiber that awaits, then
  succeed from the main fiber, join the awaiting fiber and check the value

#### mutations

- `succeed` returns `true` on fresh deferred
- `succeed` returns `false` if already completed
- `fail` returns `true` on fresh deferred
- `fail` returns `false` if already completed
- `done` with `Either.right` behaves like `succeed`
- `done` with `Either.left` behaves like `fail`

#### guards

- `isTxDeferred` returns `true` for deferred, `false` for plain objects/null

#### transactional behavior

- `succeed` + `await` composed in `Effect.atomic` works correctly
- Two deferred values modified atomically: both succeed or neither do (wrap
  in `Effect.atomic`, verify both changed)

#### concurrency

- Multiple fibers awaiting the same deferred all unblock on `succeed`
- Race between `succeed` and `fail`: only first wins, second returns `false`

### File

`packages/effect/src/TxDeferred.ts` (~200 lines)

---

## Module 2: TxPriorityQueue

Transactional priority queue. Elements dequeue in priority order.

### Internal State

```ts
TxRef<SortedMap<A, [A, ...Array<A>]>>
```

Uses `SortedMap` keyed by value with `Order<A>`. Duplicate-priority elements
stored in the value array.

### Public API

| Export               | Signature                                                                       | Category     |
| -------------------- | ------------------------------------------------------------------------------- | ------------ |
| `TypeId`             | `"~effect/transactions/TxPriorityQueue"`                                        | symbols      |
| `TxPriorityQueue<A>` | interface, invariant in `A`                                                     | models       |
| `empty`              | `<A>(order: Order<A>) => Effect<TxPriorityQueue<A>>`                            | constructors |
| `fromIterable`       | dual: `(order, iterable) => Effect<TxPriorityQueue<A>>`                         | constructors |
| `make`               | `<A>(order: Order<A>) => (...elements: Array<A>) => Effect<TxPriorityQueue<A>>` | constructors |
| `size`               | `(self) => Effect<number>`                                                      | getters      |
| `isEmpty`            | `(self) => Effect<boolean>`                                                     | getters      |
| `isNonEmpty`         | `(self) => Effect<boolean>`                                                     | getters      |
| `peek`               | `(self) => Effect<A>`                                                           | getters      |
| `peekOption`         | `(self) => Effect<Option<A>>`                                                   | getters      |
| `offer`              | dual: `(self, value) => Effect<void>`                                           | mutations    |
| `offerAll`           | dual: `(self, values) => Effect<void>`                                          | mutations    |
| `take`               | `(self) => Effect<A>`                                                           | mutations    |
| `takeAll`            | `(self) => Effect<Array<A>>`                                                    | mutations    |
| `takeOption`         | `(self) => Effect<Option<A>>`                                                   | mutations    |
| `takeUpTo`           | dual: `(self, n) => Effect<Array<A>>`                                           | mutations    |
| `removeIf`           | dual: `(self, predicate) => Effect<void>`                                       | filtering    |
| `retainIf`           | dual: `(self, predicate) => Effect<void>`                                       | filtering    |
| `toArray`            | `(self) => Effect<Array<A>>`                                                    | conversions  |
| `isTxPriorityQueue`  | guard                                                                           | guards       |

### Behavior

- `peek`/`take`: retry transaction if empty
- `offer`: always succeeds (unbounded)
- Internal: `SortedMap` from `effect` provides ordered iteration

### Dependencies

- `SortedMap` from `effect` (already available)

### Tests

- Offer + take → priority order
- Duplicate priorities → all returned
- take on empty → blocks until offer
- peek does not remove
- takeUpTo returns min(n, size) elements in order
- removeIf/retainIf filter correctly
- Concurrent offer/take

### File

`packages/effect/src/TxPriorityQueue.ts` (~500 lines)

---

## Module 3: TxRandom

Transactional random number generator. PRNG state is stored in a `TxRef` so
random values are consistent within a transaction (rolling back a transaction
also rolls back the PRNG state).

### Internal State

```ts
TxRef<PcgState>
```

PCG (Permuted Congruential Generator) state — same algorithm as v3.

### Public API

| Export           | Signature                                    | Category     |
| ---------------- | -------------------------------------------- | ------------ |
| `TypeId`         | `"~effect/transactions/TxRandom"`            | symbols      |
| `TxRandom`       | interface                                    | models       |
| `make`           | `(seed?: number) => Effect<TxRandom>`        | constructors |
| `next`           | `(self) => Effect<number>`                   | combinators  |
| `nextBoolean`    | `(self) => Effect<boolean>`                  | combinators  |
| `nextInt`        | `(self) => Effect<number>`                   | combinators  |
| `nextRange`      | dual: `(self, min, max) => Effect<number>`   | combinators  |
| `nextIntBetween` | dual: `(self, min, max) => Effect<number>`   | combinators  |
| `shuffle`        | dual: `(self, elements) => Effect<Array<A>>` | combinators  |
| `isTxRandom`     | guard                                        | guards       |

### Design Decision — No Service Pattern

v3 exposed `TRandom` as a `Context.Tag` service with a `live` layer. In the
current codebase, Tx modules are plain values, not services. We follow this
pattern: `TxRandom` is a regular value created with `make`, not a service tag.
Users who want it in context can wrap it themselves.

### Tests

- Deterministic: same seed → same sequence
- Transaction rollback → PRNG state also rolls back
- nextRange/nextIntBetween stay within bounds
- shuffle returns all elements

### File

`packages/effect/src/TxRandom.ts` (~300 lines)

---

## Module 4: TxPubSub

Transactional publish/subscribe hub. Publishers broadcast messages to all
current subscribers.

### Internal Architecture

This is the most complex module. It needs to manage:

- A set of subscriber queues
- Back-pressure / dropping / sliding strategies
- Shutdown lifecycle

Approach: store subscribers as `TxRef<HashSet<TxQueue<A>>>` and fan out
publishes to each subscriber's queue.

### Public API

| Export          | Signature                                              | Category     |
| --------------- | ------------------------------------------------------ | ------------ |
| `TypeId`        | `"~effect/transactions/TxPubSub"`                      | symbols      |
| `TxPubSub<A>`   | interface                                              | models       |
| `bounded`       | `<A>(capacity: number) => Effect<TxPubSub<A>>`         | constructors |
| `dropping`      | `<A>(capacity: number) => Effect<TxPubSub<A>>`         | constructors |
| `sliding`       | `<A>(capacity: number) => Effect<TxPubSub<A>>`         | constructors |
| `unbounded`     | `<A>() => Effect<TxPubSub<A>>`                         | constructors |
| `capacity`      | `(self) => number`                                     | getters      |
| `size`          | `(self) => Effect<number>`                             | getters      |
| `isEmpty`       | `(self) => Effect<boolean>`                            | getters      |
| `isFull`        | `(self) => Effect<boolean>`                            | getters      |
| `isShutdown`    | `(self) => Effect<boolean>`                            | getters      |
| `publish`       | dual: `(self, value) => Effect<boolean>`               | mutations    |
| `publishAll`    | dual: `(self, iterable) => Effect<boolean>`            | mutations    |
| `subscribe`     | `(self) => Effect<TxQueue.TxDequeue<A>, never, Scope>` | mutations    |
| `awaitShutdown` | `(self) => Effect<void>`                               | mutations    |
| `shutdown`      | `(self) => Effect<void>`                               | mutations    |
| `isTxPubSub`    | guard                                                  | guards       |

### Strategy Behavior

- **bounded**: publisher retries if any subscriber queue is full
- **dropping**: drops message if any subscriber queue is full, returns `false`
- **sliding**: drops oldest message in full subscriber queues to make room
- **unbounded**: always accepts

### Design Decision — Scoped Subscribe Only

v3 had both `subscribe` (manual cleanup) and `subscribeScoped`. We only expose
the scoped version to prevent leaks. Signature:

```ts
subscribe: ;
;(<A>(self: TxPubSub<A>) => Effect<TxQueue.TxDequeue<A>, never, Scope>)
```

### Tests

- Publish with no subscribers → no-op
- Subscribe → publish → take from subscription
- Multiple subscribers each get all messages
- Bounded back-pressure: publisher blocks when subscriber queue full
- Dropping: messages dropped when full
- Sliding: oldest messages dropped when full
- Shutdown: subsequent operations fail/complete
- Unsubscribe (scope close) removes subscriber

### File

`packages/effect/src/TxPubSub.ts` (~600 lines)

---

## Module 5: TxReentrantLock

Transactional read/write lock with reentrant semantics. Multiple readers OR
one writer. A fiber holding a write lock may acquire additional read/write
locks.

### Internal State

```ts
interface LockState {
  readonly readers: HashMap<FiberId, number> // fiberId → read lock count
  readonly writer: Option<readonly [FiberId, number]> // fiberId + write lock count
}

TxRef<LockState>
```

### Public API

| Export              | Signature                                 | Category     |
| ------------------- | ----------------------------------------- | ------------ |
| `TypeId`            | `"~effect/transactions/TxReentrantLock"`  | symbols      |
| `TxReentrantLock`   | interface                                 | models       |
| `make`              | `() => Effect<TxReentrantLock>`           | constructors |
| `acquireRead`       | `(self) => Effect<number>`                | mutations    |
| `acquireWrite`      | `(self) => Effect<number>`                | mutations    |
| `releaseRead`       | `(self) => Effect<number>`                | mutations    |
| `releaseWrite`      | `(self) => Effect<number>`                | mutations    |
| `readLock`          | `(self) => Effect<number, never, Scope>`  | mutations    |
| `writeLock`         | `(self) => Effect<number, never, Scope>`  | mutations    |
| `lock`              | `(self) => Effect<number, never, Scope>`  | mutations    |
| `withReadLock`      | dual: `(self, effect) => Effect<A, E, R>` | mutations    |
| `withWriteLock`     | dual: `(self, effect) => Effect<A, E, R>` | mutations    |
| `withLock`          | dual: `(self, effect) => Effect<A, E, R>` | mutations    |
| `readLocks`         | `(self) => Effect<number>`                | getters      |
| `writeLocks`        | `(self) => Effect<number>`                | getters      |
| `locked`            | `(self) => Effect<boolean>`               | getters      |
| `readLocked`        | `(self) => Effect<boolean>`               | getters      |
| `writeLocked`       | `(self) => Effect<boolean>`               | getters      |
| `isTxReentrantLock` | guard                                     | guards       |

### Behavior

- `acquireRead`: retry if another fiber holds write lock (same fiber OK)
- `acquireWrite`: retry if any other fiber holds any lock (same fiber OK,
  reentrancy increments count)
- `readLock`/`writeLock`/`lock`: scoped — acquire on enter, release on scope
  close
- `withReadLock`/`withWriteLock`/`withLock`: bracket pattern — acquire, run
  effect, release

### Implementation Notes

- Needs `Effect.fiberId` to track per-fiber lock counts — verify this is
  available within the transaction system
- Lock state must be checked atomically via `TxRef.modify`

### Tests

- Multiple readers concurrently → all succeed
- Writer blocks readers and vice versa
- Reentrancy: same fiber can acquire write then read
- Scoped: lock released on scope close
- withLock: effect runs under lock, lock released after

### File

`packages/effect/src/TxReentrantLock.ts` (~500 lines)

---

## Module 6: TxSubscriptionRef

A `TxRef` that allows subscribing to all committed changes. Subscribers
receive a queue containing the current value followed by every subsequent
update.

### Internal Architecture

```ts
{
  ref: TxRef<A>
  pubsub: TxPubSub<A>
}
```

Every `set`/`update`/`modify` on the ref also publishes to the pubsub.
Subscribing creates a new pubsub subscription, prepends the current value.

### Public API

| Export                 | Signature                                              | Category      |
| ---------------------- | ------------------------------------------------------ | ------------- |
| `TypeId`               | `"~effect/transactions/TxSubscriptionRef"`             | symbols       |
| `TxSubscriptionRef<A>` | interface, extends conceptual TxRef API                | models        |
| `make`                 | `<A>(value: A) => Effect<TxSubscriptionRef<A>>`        | constructors  |
| `get`                  | `(self) => Effect<A>`                                  | getters       |
| `set`                  | dual: `(self, value) => Effect<void>`                  | mutations     |
| `update`               | dual: `(self, f) => Effect<void>`                      | mutations     |
| `modify`               | dual: `(self, f) => Effect<B>`                         | mutations     |
| `getAndSet`            | dual: `(self, value) => Effect<A>`                     | mutations     |
| `getAndUpdate`         | dual: `(self, f) => Effect<A>`                         | mutations     |
| `updateAndGet`         | dual: `(self, f) => Effect<A>`                         | mutations     |
| `changes`              | `(self) => Effect<TxQueue.TxDequeue<A>, never, Scope>` | subscriptions |
| `changesStream`        | `(self) => Stream<A>`                                  | subscriptions |
| `isTxSubscriptionRef`  | guard                                                  | guards        |

### Design Decisions

- `changes` is scoped (no manual-cleanup variant) — consistent with TxPubSub
- `changesStream` returns a `Stream<A>` for ergonomic consumption
- Only include the commonly used ref operations (`get`, `set`, `modify`,
  `update`, `getAndSet`, `getAndUpdate`, `updateAndGet`). Skip the `*Some`
  variants from v3 — they can be built from `modify` if needed.

### Behavior

- All writes go through `modify` internally, which updates the ref AND
  publishes the new value to the pubsub atomically (in `Effect.atomic`)
- `changes`: subscribes to pubsub, immediately enqueues current ref value,
  returns the dequeue
- `changesStream`: wraps `changes` in a `Stream` that repeatedly takes from
  the dequeue

### Tests

- make + get → initial value
- set + get → new value
- subscribe → set multiple times → dequeue all values in order
- Multiple subscribers each see all changes
- changes includes current value as first element
- changesStream emits initial + updates
- Scope close unsubscribes

### File

`packages/effect/src/TxSubscriptionRef.ts` (~400 lines)

---

## Implementation Order & Estimated Effort

| # | Module            | Est. Lines | Effort | Blocked By |
| - | ----------------- | ---------- | ------ | ---------- |
| 1 | TxDeferred        | ~200       | Small  | —          |
| 2 | TxPriorityQueue   | ~500       | Medium | —          |
| 3 | TxRandom          | ~300       | Small  | —          |
| 4 | TxPubSub          | ~600       | Large  | —          |
| 5 | TxReentrantLock   | ~500       | Medium | —          |
| 6 | TxSubscriptionRef | ~400       | Medium | TxPubSub   |

Modules 1–3 are independent and can be implemented in parallel.
Module 4 (TxPubSub) should be implemented before Module 6 (TxSubscriptionRef).
Module 5 is independent.

## Checklist Per Module

For each module:

- [ ] Create `packages/effect/src/TxModule.ts`
- [ ] Create `packages/effect/test/TxModule.test.ts`
- [ ] Run `pnpm codegen` to update barrel exports
- [ ] Run `pnpm lint-fix`
- [ ] Run `pnpm test TxModule.test.ts`
- [ ] Run `pnpm check:tsgo`
- [ ] Run `pnpm docgen` to verify JSDoc examples
- [ ] Add changeset in `.changeset/`

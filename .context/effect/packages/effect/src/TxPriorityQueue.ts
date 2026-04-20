/**
 * A transactional priority queue. Elements are dequeued in order determined by the
 * provided `Order` instance. All operations participate in the STM transaction system.
 *
 * @since 4.0.0
 */

import type { Chunk } from "./Chunk.ts"
import * as C from "./Chunk.ts"
import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import type { Inspectable } from "./Inspectable.ts"
import { NodeInspectSymbol, toJson } from "./Inspectable.ts"
import type { Option } from "./Option.ts"
import * as O from "./Option.ts"
import type { Order } from "./Order.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty, type Predicate } from "./Predicate.ts"
import * as TxRef from "./TxRef.ts"

const TypeId = "~effect/transactions/TxPriorityQueue"

/**
 * A transactional priority queue backed by a sorted `Chunk`.
 *
 * Elements are stored in ascending order according to the `Order` provided at
 * construction time. `take` returns the smallest element, `peek` observes it
 * without removing.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   yield* TxPriorityQueue.offer(pq, 3)
 *   yield* TxPriorityQueue.offer(pq, 1)
 *   yield* TxPriorityQueue.offer(pq, 2)
 *   const first = yield* TxPriorityQueue.take(pq)
 *   console.log(first) // 1
 * })
 * ```
 *
 * @since 4.0.0
 * @category models
 */
export interface TxPriorityQueue<in out A> extends Inspectable, Pipeable {
  readonly [TypeId]: typeof TypeId
  readonly ref: TxRef.TxRef<Chunk<A>>
  readonly ord: Order<A>
}

const TxPriorityQueueProto: Omit<TxPriorityQueue<unknown>, typeof TypeId | "ref" | "ord"> = {
  [NodeInspectSymbol](this: TxPriorityQueue<unknown>) {
    return toJson(this)
  },
  toJSON(this: TxPriorityQueue<unknown>) {
    return {
      _id: "TxPriorityQueue"
    }
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

const makeTxPriorityQueue = <A>(ref: TxRef.TxRef<Chunk<A>>, ord: Order<A>): TxPriorityQueue<A> => {
  const self = Object.create(TxPriorityQueueProto)
  self[TypeId] = TypeId
  self.ref = ref
  self.ord = ord
  return self
}

const insertSorted = <A>(chunk: Chunk<A>, value: A, ord: Order<A>): Chunk<A> => {
  const arr = C.toArray(chunk) as Array<A>
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (ord(arr[mid], value) <= 0) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  const out = Array(arr.length + 1) as Array<A>
  for (let i = 0; i < lo; i++) out[i] = arr[i]
  out[lo] = value
  for (let i = lo; i < arr.length; i++) out[i + 1] = arr[i]
  return C.fromIterable(out)
}

/**
 * Creates an empty `TxPriorityQueue` with the given ordering.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   const empty = yield* TxPriorityQueue.isEmpty(pq)
 *   console.log(empty) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const empty = <A>(order: Order<A>): Effect.Effect<TxPriorityQueue<A>> =>
  Effect.map(TxRef.make<Chunk<A>>(C.empty()), (ref) => makeTxPriorityQueue(ref, order))

/**
 * Creates a `TxPriorityQueue` from an iterable of elements.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [3, 1, 2])
 *   const first = yield* TxPriorityQueue.take(pq)
 *   console.log(first) // 1
 * })
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const fromIterable: {
  <A>(order: Order<A>): (iterable: Iterable<A>) => Effect.Effect<TxPriorityQueue<A>>
  <A>(order: Order<A>, iterable: Iterable<A>): Effect.Effect<TxPriorityQueue<A>>
} = dual(
  2,
  <A>(order: Order<A>, iterable: Iterable<A>): Effect.Effect<TxPriorityQueue<A>> => {
    const arr = Array.from(iterable).sort((a, b) => order(a, b))
    return Effect.map(
      TxRef.make<Chunk<A>>(C.fromIterable(arr)),
      (ref) => makeTxPriorityQueue(ref, order)
    )
  }
)

/**
 * Creates a `TxPriorityQueue` from variadic elements.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.make(Order.Number)(3, 1, 2)
 *   const first = yield* TxPriorityQueue.take(pq)
 *   console.log(first) // 1
 * })
 * ```
 *
 * @since 4.0.0
 * @category constructors
 */
export const make = <A>(order: Order<A>) => (...elements: Array<A>): Effect.Effect<TxPriorityQueue<A>> =>
  fromIterable(order, elements)

/**
 * Returns the number of elements in the queue.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [1, 2, 3])
 *   const s = yield* TxPriorityQueue.size(pq)
 *   console.log(s) // 3
 * })
 * ```
 *
 * @since 4.0.0
 * @category getters
 */
export const size = <A>(self: TxPriorityQueue<A>): Effect.Effect<number> => Effect.map(TxRef.get(self.ref), C.size)

/**
 * Returns `true` if the queue is empty.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   const empty = yield* TxPriorityQueue.isEmpty(pq)
 *   console.log(empty) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category getters
 */
export const isEmpty = <A>(self: TxPriorityQueue<A>): Effect.Effect<boolean> => Effect.map(size(self), (n) => n === 0)

/**
 * Returns `true` if the queue has at least one element.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [1])
 *   const nonEmpty = yield* TxPriorityQueue.isNonEmpty(pq)
 *   console.log(nonEmpty) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category getters
 */
export const isNonEmpty = <A>(self: TxPriorityQueue<A>): Effect.Effect<boolean> => Effect.map(size(self), (n) => n > 0)

/**
 * Observes the smallest element without removing it. Retries if the queue is
 * empty.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [3, 1, 2])
 *   const top = yield* TxPriorityQueue.peek(pq)
 *   console.log(top) // 1
 * })
 * ```
 *
 * @since 4.0.0
 * @category getters
 */
export const peek = <A>(self: TxPriorityQueue<A>): Effect.Effect<A> =>
  Effect.gen(function*() {
    const chunk = yield* TxRef.get(self.ref)
    const head = C.head(chunk)
    if (O.isNone(head)) {
      return yield* Effect.txRetry
    }
    return head.value
  }).pipe(Effect.tx)

/**
 * Observes the smallest element without removing it. Returns `None` if the
 * queue is empty.
 *
 * @example
 * ```ts
 * import { Effect, Option, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   const result = yield* TxPriorityQueue.peekOption(pq)
 *   console.log(Option.isNone(result)) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category getters
 */
export const peekOption = <A>(self: TxPriorityQueue<A>): Effect.Effect<Option<A>> =>
  Effect.map(TxRef.get(self.ref), C.head)

/**
 * Inserts an element into the queue in sorted position.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   yield* TxPriorityQueue.offer(pq, 2)
 *   yield* TxPriorityQueue.offer(pq, 1)
 *   const first = yield* TxPriorityQueue.take(pq)
 *   console.log(first) // 1
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const offer: {
  <A>(value: A): (self: TxPriorityQueue<A>) => Effect.Effect<void>
  <A>(self: TxPriorityQueue<A>, value: A): Effect.Effect<void>
} = dual(
  2,
  <A>(self: TxPriorityQueue<A>, value: A): Effect.Effect<void> =>
    TxRef.update(self.ref, (chunk) => insertSorted(chunk, value, self.ord))
)

/**
 * Inserts all elements from an iterable into the queue.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   yield* TxPriorityQueue.offerAll(pq, [3, 1, 2])
 *   const first = yield* TxPriorityQueue.take(pq)
 *   console.log(first) // 1
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const offerAll: {
  <A>(values: Iterable<A>): (self: TxPriorityQueue<A>) => Effect.Effect<void>
  <A>(self: TxPriorityQueue<A>, values: Iterable<A>): Effect.Effect<void>
} = dual(
  2,
  <A>(self: TxPriorityQueue<A>, values: Iterable<A>): Effect.Effect<void> =>
    TxRef.update(self.ref, (chunk) => {
      const arr = [...C.toArray(chunk), ...values].sort((a, b) => self.ord(a, b))
      return C.fromIterable(arr)
    })
)

/**
 * Takes the smallest element from the queue. Retries if the queue is empty.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [3, 1, 2])
 *   const first = yield* TxPriorityQueue.take(pq)
 *   console.log(first) // 1
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const take = <A>(self: TxPriorityQueue<A>): Effect.Effect<A> =>
  Effect.gen(function*() {
    const chunk = yield* TxRef.get(self.ref)
    const head = C.head(chunk)
    if (O.isNone(head)) {
      return yield* Effect.txRetry
    }
    yield* TxRef.set(self.ref, C.drop(chunk, 1))
    return head.value
  }).pipe(Effect.tx)

/**
 * Takes all elements from the queue, returning them in priority order.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [3, 1, 2])
 *   const all = yield* TxPriorityQueue.takeAll(pq)
 *   console.log(all) // [1, 2, 3]
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const takeAll = <A>(self: TxPriorityQueue<A>): Effect.Effect<Array<A>> =>
  Effect.map(
    TxRef.modify(self.ref, (chunk) => [chunk, C.empty()]),
    C.toArray
  )

/**
 * Tries to take the smallest element. Returns `None` if the queue is empty.
 *
 * @example
 * ```ts
 * import { Effect, Option, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   const result = yield* TxPriorityQueue.takeOption(pq)
 *   console.log(Option.isNone(result)) // true
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const takeOption = <A>(self: TxPriorityQueue<A>): Effect.Effect<Option<A>> =>
  TxRef.modify(self.ref, (chunk) => {
    const head = C.head(chunk)
    if (O.isNone(head)) {
      return [O.none<A>(), chunk]
    }
    return [O.some(head.value), C.drop(chunk, 1)]
  })

/**
 * Takes up to `n` elements from the queue in priority order.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [5, 3, 1, 4, 2])
 *   const top2 = yield* TxPriorityQueue.takeUpTo(pq, 2)
 *   console.log(top2) // [1, 2]
 * })
 * ```
 *
 * @since 4.0.0
 * @category mutations
 */
export const takeUpTo: {
  (n: number): <A>(self: TxPriorityQueue<A>) => Effect.Effect<Array<A>>
  <A>(self: TxPriorityQueue<A>, n: number): Effect.Effect<Array<A>>
} = dual(
  2,
  <A>(self: TxPriorityQueue<A>, n: number): Effect.Effect<Array<A>> =>
    Effect.map(
      TxRef.modify(self.ref, (chunk) => {
        const taken = C.take(chunk, n)
        const rest = C.drop(chunk, n)
        return [taken, rest]
      }),
      C.toArray
    )
)

/**
 * Removes elements matching the predicate.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [1, 2, 3, 4, 5])
 *   yield* TxPriorityQueue.removeIf(pq, (n) => n % 2 === 0)
 *   const all = yield* TxPriorityQueue.takeAll(pq)
 *   console.log(all) // [1, 3, 5]
 * })
 * ```
 *
 * @since 4.0.0
 * @category filtering
 */
export const removeIf: {
  <A>(predicate: Predicate<A>): (self: TxPriorityQueue<A>) => Effect.Effect<void>
  <A>(self: TxPriorityQueue<A>, predicate: Predicate<A>): Effect.Effect<void>
} = dual(
  2,
  <A>(self: TxPriorityQueue<A>, predicate: Predicate<A>): Effect.Effect<void> =>
    TxRef.update(self.ref, (chunk) => C.filter(chunk, (a) => !predicate(a)))
)

/**
 * Retains only elements matching the predicate.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [1, 2, 3, 4, 5])
 *   yield* TxPriorityQueue.retainIf(pq, (n) => n % 2 === 0)
 *   const all = yield* TxPriorityQueue.takeAll(pq)
 *   console.log(all) // [2, 4]
 * })
 * ```
 *
 * @since 4.0.0
 * @category filtering
 */
export const retainIf: {
  <A>(predicate: Predicate<A>): (self: TxPriorityQueue<A>) => Effect.Effect<void>
  <A>(self: TxPriorityQueue<A>, predicate: Predicate<A>): Effect.Effect<void>
} = dual(
  2,
  <A>(self: TxPriorityQueue<A>, predicate: Predicate<A>): Effect.Effect<void> =>
    TxRef.update(self.ref, (chunk) => C.filter(chunk, predicate))
)

/**
 * Returns all elements in priority order without removing them.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.fromIterable(Order.Number, [3, 1, 2])
 *   const all = yield* TxPriorityQueue.toArray(pq)
 *   console.log(all) // [1, 2, 3]
 * })
 * ```
 *
 * @since 4.0.0
 * @category conversions
 */
export const toArray = <A>(self: TxPriorityQueue<A>): Effect.Effect<Array<A>> =>
  Effect.map(TxRef.get(self.ref), C.toArray)

/**
 * Determines if the provided value is a `TxPriorityQueue`.
 *
 * @example
 * ```ts
 * import { Effect, Order, TxPriorityQueue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const pq = yield* TxPriorityQueue.empty<number>(Order.Number)
 *   console.log(TxPriorityQueue.isTxPriorityQueue(pq)) // true
 *   console.log(TxPriorityQueue.isTxPriorityQueue("nope")) // false
 * })
 * ```
 *
 * @since 4.0.0
 * @category guards
 */
export const isTxPriorityQueue = (u: unknown): u is TxPriorityQueue<unknown> => hasProperty(u, TypeId)

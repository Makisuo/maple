import { assert, describe, it } from "@effect/vitest"
import { type Collection, createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { InstanceScope, Registry, Store } from "../src/core/index.js"
import * as Db from "../src/db/index.js"

interface Todo {
	readonly id: number
	readonly label: string
}

const makeTodos = (initial: ReadonlyArray<Todo> = []) =>
	createCollection(
		localOnlyCollectionOptions<Todo, number>({
			getKey: (todo) => todo.id,
			initialData: [...initial],
		}),
	)

const rowsOf = <T>(state: AsyncResult.AsyncResult<ReadonlyArray<T>, Db.CollectionError>): ReadonlyArray<T> => {
	assert.strictEqual(state._tag, "Success")
	return state._tag === "Success" ? state.value : []
}

/** Synced rows carry virtual props (`$synced`); compare on the data fields only. */
const todosOf = (state: AsyncResult.AsyncResult<ReadonlyArray<Todo>, Db.CollectionError>): ReadonlyArray<Todo> =>
	rowsOf(state).map(({ id, label }) => ({ id, label }))

const successWith =
	(length: number) =>
	<T>(state: AsyncResult.AsyncResult<ReadonlyArray<T>, Db.CollectionError>): boolean =>
		state._tag === "Success" && state.value.length === length

describe("Db.fromCollection", () => {
	it.effect("reflects rows and follows inserts", () =>
		Effect.gen(function* () {
			const todos = makeTodos([{ id: 1, label: "first" }])
			const store = yield* Db.fromCollection(todos)

			const loaded = yield* Store.waitFor(store, successWith(1), { timeout: "1 second" })
			assert.deepStrictEqual(todosOf(loaded), [{ id: 1, label: "first" }])

			todos.insert({ id: 2, label: "second" })
			const updated = yield* Store.waitFor(store, successWith(2), { timeout: "1 second" })
			assert.strictEqual(rowsOf(updated).length, 2)
		}).pipe(Effect.provide(Registry.layer)),
	)

	it.effect("reaches success for an empty collection instead of hanging on loading", () =>
		Effect.gen(function* () {
			const todos = makeTodos()
			const store = yield* Db.fromCollection(todos)
			const state = yield* Store.waitFor(store, successWith(0), { timeout: "1 second" })
			assert.deepStrictEqual(rowsOf(state), [])
		}).pipe(Effect.provide(Registry.layer)),
	)

	it.effect("holds exactly one subscription across many changes", () =>
		Effect.gen(function* () {
			const todos = makeTodos([{ id: 0, label: "seed" }])
			const store = yield* Db.fromCollection(todos)
			yield* Store.waitFor(store, successWith(1), { timeout: "1 second" })
			assert.strictEqual(todos.subscriberCount, 1)

			for (let i = 1; i <= 20; i++) {
				todos.insert({ id: i, label: `todo-${i}` })
			}
			yield* Store.waitFor(store, successWith(21), { timeout: "1 second" })
			// The regression this guards: re-creating the subscription per change
			// event (the makeQuery-inside-compute bug class) would tear down and
			// resubscribe 20 times; a raced teardown leaves count !== 1.
			assert.strictEqual(todos.subscriberCount, 1)
		}).pipe(Effect.provide(Registry.layer)),
	)

	it.effect("coalesces a same-tick burst of changes into one snapshot", () =>
		Effect.gen(function* () {
			const todos = makeTodos([{ id: 0, label: "seed" }])
			const store = yield* Db.fromCollection(todos)
			yield* Store.waitFor(store, successWith(1), { timeout: "1 second" })

			let emissions = 0
			yield* Registry.run(
				Store.stream(store).pipe(
					Stream.drop(1),
					Stream.tap(() =>
						Effect.sync(() => {
							emissions += 1
						}),
					),
				),
			)

			// One synchronous burst — the transaction fires one change callback per
			// row, but only one microtask-deferred snapshot may reach the store.
			for (let i = 1; i <= 50; i++) {
				todos.insert({ id: i, label: `todo-${i}` })
			}
			yield* Store.waitFor(store, successWith(51), { timeout: "1 second" })
			assert.strictEqual(emissions, 1)
		}).pipe(Effect.provide(Registry.layer)),
	)

	it.effect("releases the subscription when the owning scope closes", () =>
		Effect.gen(function* () {
			const todos = makeTodos([{ id: 1, label: "first" }])
			const scope = yield* Scope.make()

			const store = yield* Db.fromCollection(todos).pipe(Effect.provideService(InstanceScope, scope))
			yield* Store.waitFor(store, successWith(1), { timeout: "1 second" })
			assert.strictEqual(todos.subscriberCount, 1)

			yield* Scope.close(scope, Exit.void)
			assert.strictEqual(todos.subscriberCount, 0)
		}).pipe(Effect.provide(Registry.layer)),
	)
})

describe("Db.fromCollectionByKey", () => {
	it.effect("switches collections when the key changes, releasing the old subscription", () =>
		Effect.gen(function* () {
			const collections = {
				a: makeTodos([{ id: 1, label: "in-a" }]),
				b: makeTodos([
					{ id: 2, label: "in-b" },
					{ id: 3, label: "also-b" },
				]),
			}
			const key = Store.make<"a" | "b">("a")
			const store = yield* Db.fromCollectionByKey(key, (k) => collections[k])

			const first = yield* Store.waitFor(store, successWith(1), { timeout: "1 second" })
			assert.deepStrictEqual(todosOf(first), [{ id: 1, label: "in-a" }])
			assert.strictEqual(collections.a.subscriberCount, 1)
			assert.strictEqual(collections.b.subscriberCount, 0)

			yield* Store.set(key, "b")
			const second = yield* Store.waitFor(store, successWith(2), { timeout: "1 second" })
			assert.strictEqual(rowsOf(second).length, 2)
			assert.strictEqual(collections.a.subscriberCount, 0)
			assert.strictEqual(collections.b.subscriberCount, 1)
		}).pipe(Effect.provide(Registry.layer)),
	)
})

/**
 * A hand-rolled collection stub that stays in `loading` until told otherwise —
 * `changes()` only touches status/toArray/startSyncImmediate/subscribeChanges/
 * the status listener, so this is enough to drive the stuck watchdog without a
 * real (never-stuck) TanStack collection.
 */
const stuckCollectionStub = <T extends object>() => {
	const statusListeners = new Set<() => void>()
	const changeListeners = new Set<() => void>()
	let status = "loading"
	let rows: ReadonlyArray<T> = []
	const stub = {
		get status() {
			return status
		},
		get toArray() {
			return [...rows]
		},
		startSyncImmediate: () => {},
		subscribeChanges: (callback: () => void) => {
			changeListeners.add(callback)
			return { unsubscribe: () => changeListeners.delete(callback) }
		},
		on: (_event: string, callback: () => void) => {
			statusListeners.add(callback)
			return () => statusListeners.delete(callback)
		},
		/** Test hook: re-announce the (unchanged) loading status — "activity". */
		pokeStatus: () => {
			for (const callback of [...statusListeners]) callback()
		},
		/** Test hook: finish the sync. */
		setReady: (data: ReadonlyArray<T>) => {
			rows = data
			status = "ready"
			for (const callback of [...statusListeners]) callback()
		},
	}
	return stub
}
const asCollection = <T extends object>(stub: ReturnType<typeof stuckCollectionStub<T>>) =>
	stub as unknown as Collection<T, any, any>

/** Lets forked pipelines (the snapshot stream + watchdog) park before the clock moves. */
const settle = Effect.gen(function* () {
	for (let i = 0; i < 10; i++) yield* Effect.yieldNow
})

const isLoadTimeout = <T>(state: AsyncResult.AsyncResult<ReadonlyArray<T>, Db.CollectionError>): boolean =>
	AsyncResult.isFailure(state) &&
	state.cause.reasons.some(
		(reason) => reason._tag === "Fail" && reason.error.reason === "load-timeout",
	)

describe("stuck watchdog", () => {
	it.effect("fails with load-timeout after the stuck window, fires onStuck, and recovers on a late ready", () =>
		Effect.gen(function* () {
			const stub = stuckCollectionStub<Todo>()
			let stuckCalls = 0
			const store = yield* Db.fromCollection(asCollection(stub), {
				stuckTimeoutMs: 30_000,
				onStuck: () => {
					stuckCalls += 1
				},
			})
			yield* settle

			// Still inside the window: loading is not yet "stuck".
			yield* TestClock.adjust("29 seconds")
			yield* settle
			assert.isTrue(AsyncResult.isInitial(yield* Store.get(store)))
			assert.strictEqual(stuckCalls, 0)

			yield* TestClock.adjust("1 second")
			yield* settle
			assert.isTrue(isLoadTimeout(yield* Store.get(store)))
			assert.strictEqual(stuckCalls, 1)

			// The subscription stayed live: a late ready overwrites the failure.
			stub.setReady([{ id: 1, label: "late" }])
			const recovered = yield* Store.waitFor(store, successWith(1), { timeout: "1 second" })
			assert.deepStrictEqual(todosOf(recovered), [{ id: 1, label: "late" }])
		}).pipe(Effect.provide(Registry.layer)),
	)

	it.effect("any emission resets the stuck window", () =>
		Effect.gen(function* () {
			const stub = stuckCollectionStub<Todo>()
			let stuckCalls = 0
			const store = yield* Db.fromCollection(asCollection(stub), {
				stuckTimeoutMs: 30_000,
				onStuck: () => {
					stuckCalls += 1
				},
			})
			yield* settle

			// Activity at t=20s (a status listener firing re-snapshots the store)
			// re-arms the window: t=40s is only 20s since activity → not stuck.
			yield* TestClock.adjust("20 seconds")
			stub.pokeStatus()
			yield* settle
			yield* TestClock.adjust("20 seconds")
			yield* settle
			assert.isTrue(AsyncResult.isInitial(yield* Store.get(store)))
			assert.strictEqual(stuckCalls, 0)

			// …but t=50s is 30s past the last activity → stuck.
			yield* TestClock.adjust("10 seconds")
			yield* settle
			assert.isTrue(isLoadTimeout(yield* Store.get(store)))
			assert.strictEqual(stuckCalls, 1)
		}).pipe(Effect.provide(Registry.layer)),
	)

	it.effect("re-arms after a key switch hands over a fresh collection", () =>
		Effect.gen(function* () {
			const first = stuckCollectionStub<Todo>()
			const second = stuckCollectionStub<Todo>()
			const collections = { a: first, b: second }
			let stuckCalls = 0
			const key = Store.make<"a" | "b">("a")
			const store = yield* Db.fromCollectionByKey(key, (k) => asCollection(collections[k]), {
				stuckTimeoutMs: 30_000,
				onStuck: () => {
					stuckCalls += 1
				},
			})
			yield* settle

			yield* TestClock.adjust("30 seconds")
			yield* settle
			assert.isTrue(isLoadTimeout(yield* Store.get(store)))
			assert.strictEqual(stuckCalls, 1)

			// The recovery hook recreates collections → the key flips → the fresh
			// collection's snapshot clears the failure, and the watchdog re-arms
			// against the new stream.
			yield* Store.set(key, "b")
			yield* settle
			assert.isTrue(AsyncResult.isInitial(yield* Store.get(store)))

			second.setReady([{ id: 2, label: "fresh" }])
			const recovered = yield* Store.waitFor(store, successWith(1), { timeout: "1 second" })
			assert.deepStrictEqual(todosOf(recovered), [{ id: 2, label: "fresh" }])
			assert.strictEqual(stuckCalls, 1)
		}).pipe(Effect.provide(Registry.layer)),
	)
})

describe("Db.liveQuery", () => {
	it.effect("tracks a derived live query over a source collection", () =>
		Effect.gen(function* () {
			const todos = makeTodos([
				{ id: 1, label: "keep" },
				{ id: 2, label: "drop" },
			])
			const store = yield* Db.liveQuery((q) =>
				q.from({ todo: todos }).select(({ todo }) => ({ id: todo.id, label: todo.label })),
			)

			yield* Store.waitFor(store, successWith(2), { timeout: "1 second" })
			todos.insert({ id: 3, label: "more" })
			const grown = yield* Store.waitFor(store, successWith(3), { timeout: "1 second" })
			assert.strictEqual(rowsOf(grown).length, 3)
		}).pipe(Effect.provide(Registry.layer)),
	)
})

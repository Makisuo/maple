import { assert, describe, it } from "@effect/vitest"
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
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

/**
 * In-memory todo store. This is where the "interesting" telemetry comes from:
 *
 * - Each public method is an `Effect.fn("TodoService.<op>")`, so it gets its
 *   own named span automatically.
 * - The actual `Ref` read/write is wrapped in a child `db.*` span with a small
 *   artificial delay, so trace waterfalls show realistic nested timing.
 * - `Effect.logInfo(...)` calls flow out as OTLP logs (the Maple SDK exports
 *   logs alongside traces), correlated to the active trace.
 * - `toggle` fails ~15% of the time with `ToggleFailedError` so Maple's Errors
 *   view and error-rate metrics have data.
 */
import { Context, Duration, Effect, Layer, Random, Ref } from "effect"
import { Todo, TodoNotFoundError, ToggleFailedError } from "../shared/api.ts"

const seedTodos: ReadonlyArray<Todo> = [
	new Todo({
		id: "seed-1",
		title: "Ship the Maple demo",
		completed: false,
		createdAt: "2026-01-01T00:00:00.000Z",
	}),
	new Todo({
		id: "seed-2",
		title: "Instrument the backend",
		completed: true,
		createdAt: "2026-01-01T00:00:00.000Z",
	}),
	new Todo({
		id: "seed-3",
		title: "Watch the distributed trace",
		completed: false,
		createdAt: "2026-01-01T00:00:00.000Z",
	}),
]

/** Sleep a random number of ms in [min, max] to make spans visibly wide. */
const jitter = (minMs: number, maxMs: number) =>
	Random.nextBetween(minMs, maxMs).pipe(
		Effect.flatMap((delayMs) => Effect.sleep(Duration.millis(Math.floor(delayMs)))),
	)

export class TodoService extends Context.Service<TodoService>()("@maple-examples/todo/TodoService", {
	make: Effect.gen(function* () {
		const store = yield* Ref.make(new Map<string, Todo>(seedTodos.map((t) => [t.id, t])))

		const list = Effect.fn("TodoService.list")(function* () {
			const todos = yield* Effect.gen(function* () {
				yield* jitter(10, 40)
				const map = yield* Ref.get(store)
				return [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
			}).pipe(
				Effect.withSpan("db.read", {
					attributes: { "db.system.name": "memory", "db.operation.name": "scan" },
				}),
			)
			yield* Effect.annotateCurrentSpan("todo.count", todos.length)
			return todos
		})

		const create = Effect.fn("TodoService.create")(function* (title: string) {
			const id = crypto.randomUUID()
			const todo = new Todo({ id, title, completed: false, createdAt: new Date().toISOString() })
			yield* Effect.gen(function* () {
				yield* jitter(20, 90)
				yield* Ref.update(store, (map) => new Map(map).set(id, todo))
			}).pipe(
				Effect.withSpan("db.persist", {
					attributes: { "db.system.name": "memory", "db.operation.name": "insert", "todo.id": id },
				}),
			)
			yield* Effect.logInfo("todo.created").pipe(
				Effect.annotateLogs({ "todo.id": id, "todo.title": title }),
			)
			return todo
		})

		const toggle = Effect.fn("TodoService.toggle")(function* (id: string) {
			const map = yield* Ref.get(store)
			const existing = map.get(id)
			if (!existing) {
				return yield* new TodoNotFoundError({ id, message: `Todo ${id} not found` })
			}

			// The simulated flake: a slow write that occasionally loses a race.
			yield* jitter(40, 160)
			if ((yield* Random.next) < 0.15) {
				yield* Effect.logWarning("todo.toggle.conflict").pipe(Effect.annotateLogs({ "todo.id": id }))
				return yield* new ToggleFailedError({ message: `Transient write conflict toggling ${id}` })
			}

			const updated = new Todo({ ...existing, completed: !existing.completed })
			yield* Ref.update(store, (m) => new Map(m).set(id, updated)).pipe(
				Effect.withSpan("db.persist", {
					attributes: { "db.system.name": "memory", "db.operation.name": "update", "todo.id": id },
				}),
			)
			yield* Effect.logInfo("todo.toggled").pipe(
				Effect.annotateLogs({ "todo.id": id, "todo.completed": updated.completed }),
			)
			return updated
		})

		const remove = Effect.fn("TodoService.remove")(function* (id: string) {
			const map = yield* Ref.get(store)
			const existing = map.get(id)
			if (!existing) {
				return yield* new TodoNotFoundError({ id, message: `Todo ${id} not found` })
			}
			yield* Effect.gen(function* () {
				yield* jitter(15, 60)
				yield* Ref.update(store, (m) => {
					const next = new Map(m)
					next.delete(id)
					return next
				})
			}).pipe(
				Effect.withSpan("db.persist", {
					attributes: { "db.system.name": "memory", "db.operation.name": "delete", "todo.id": id },
				}),
			)
			yield* Effect.logInfo("todo.removed").pipe(Effect.annotateLogs({ "todo.id": id }))
			return existing
		})

		return { list, create, toggle, remove } as const
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

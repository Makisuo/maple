/**
 * In-memory todo store. This is where most of the "interesting" telemetry
 * comes from:
 *
 * - Each public method is an `Effect.fn("TodoService.<op>")`, so it gets its
 *   own named span automatically.
 * - `list` is a **read-through cache**: `cache.get` (carrying `cache.hit`),
 *   and on a miss `db.read` + `cache.set`. Writes invalidate it, so alternating
 *   reads and writes produce visibly different waterfalls for the same route.
 * - The `db.*` spans carry OTel database semconv attributes (`db.system.name`,
 *   `db.operation.name`, `db.collection.name`, `db.query.text`), which is what
 *   makes a database node appear on Maple's service map.
 * - Every mutation calls `todo-notifier` over HTTP, extending the trace to a
 *   third service. Notifier failures are **caught** — the request still
 *   succeeds while the trace shows an `Error` span underneath it.
 * - Counters and a latency histogram feed Maple's metrics views.
 * - `Effect.logInfo(...)` calls flow out as OTLP logs, correlated to the trace.
 * - `toggle` fails ~15% of the time, and `create` rejects bad input, so the
 *   Errors view has two distinct groups.
 */
import { Clock, Context, Duration, Effect, Exit, Layer, Metric, Random, Ref } from "effect"
import { NotifyRequest } from "../shared/notifier-api.ts"
import { InvalidTodoError, Todo, TodoNotFoundError, ToggleFailedError } from "../shared/api.ts"
import { NotifierClient } from "./NotifierClient.ts"

const MAX_TITLE_LENGTH = 120

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

/** Operation counter, split by outcome — the numerator/denominator of an error rate. */
const operations = Metric.counter("todo.operations", {
	description: "Todo operations handled, tagged by operation and outcome",
})

/** Server-side latency per operation, in milliseconds. */
const operationLatency = Metric.histogram("todo.operation.duration", {
	description: "Todo operation latency in milliseconds",
	boundaries: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
})

/** Current number of stored todos. */
const storedTodos = Metric.gauge("todo.items", { description: "Todos currently stored" })

/** Sleep a random number of ms in [min, max] to make spans visibly wide. */
const jitter = (minMs: number, maxMs: number) =>
	Random.nextBetween(minMs, maxMs).pipe(
		Effect.flatMap((delayMs) => Effect.sleep(Duration.millis(Math.floor(delayMs)))),
	)

/**
 * Attach an OTel span event to the current span. `Tracer.Span.event` needs an
 * explicit timestamp in nanos, which `Clock.currentTimeNanos` supplies. Outside
 * a span this is a no-op rather than a failure.
 */
const spanEvent = (name: string, attributes?: Record<string, unknown>) =>
	Effect.currentSpan.pipe(
		Effect.flatMap((span) =>
			Clock.currentTimeNanos.pipe(Effect.map((nanos) => span.event(name, nanos, attributes))),
		),
		Effect.ignore,
	)

/** Time an operation and record its outcome into the metrics stream. */
const measured = <A, E, R>(op: string, effect: Effect.Effect<A, E, R>) =>
	Clock.currentTimeMillis.pipe(
		Effect.flatMap((started) =>
			effect.pipe(
				Effect.onExit((exit) =>
					Clock.currentTimeMillis.pipe(
						Effect.flatMap((finished) =>
							Metric.update(
								Metric.withAttributes(operations, {
									operation: op,
									outcome: Exit.isSuccess(exit) ? "success" : "failure",
								}),
								1,
							).pipe(
								Effect.flatMap(() =>
									Metric.update(
										Metric.withAttributes(operationLatency, { operation: op }),
										finished - started,
									),
								),
							),
						),
					),
				),
			),
		),
	)

export class TodoService extends Context.Service<TodoService>()("@maple-examples/todo/TodoService", {
	make: Effect.gen(function* () {
		const notifier = yield* NotifierClient
		const store = yield* Ref.make(new Map<string, Todo>(seedTodos.map((t) => [t.id, t])))
		/** The read-through cache for `list`, dropped on every write. */
		const listCache = yield* Ref.make<ReadonlyArray<Todo> | undefined>(undefined)

		const invalidate = (reason: string) =>
			Ref.set(listCache, undefined).pipe(
				Effect.flatMap(() =>
					spanEvent("todo.cache.invalidated", { "cache.invalidation.reason": reason }),
				),
			)

		const publishCount = Effect.gen(function* () {
			const map = yield* Ref.get(store)
			yield* Metric.update(storedTodos, map.size)
		})

		/**
		 * Fire the notification for a mutation. Failures are swallowed on purpose:
		 * the user's request already succeeded, and the interesting part is that
		 * the trace still shows the failed hop.
		 */
		const notify = Effect.fn("todo.notify")(function* (event: NotifyRequest["event"], todo: Todo) {
			const result = yield* Effect.exit(
				notifier.dispatch({
					payload: new NotifyRequest({ todoId: todo.id, event, title: todo.title }),
				}),
			)
			if (Exit.isSuccess(result)) {
				yield* Effect.annotateCurrentSpan({
					"notification.delivery_id": result.value.deliveryId,
					"notification.channel": result.value.channel,
					"notification.template_cached": result.value.cached,
				})
				return
			}
			// Degraded, not failed: annotate and move on.
			yield* Effect.annotateCurrentSpan("notification.delivered", false)
			yield* spanEvent("todo.notify.dropped", { "notification.event": event, "todo.id": todo.id })
			yield* Effect.logWarning("todo.notify.dropped").pipe(
				Effect.annotateLogs({ "todo.id": todo.id, "notification.event": event }),
			)
		})

		const list = Effect.fn("TodoService.list")(function* () {
			const cached = yield* Effect.gen(function* () {
				yield* jitter(1, 5)
				const hit = yield* Ref.get(listCache)
				yield* Effect.annotateCurrentSpan("cache.hit", hit !== undefined)
				return hit
			}).pipe(
				Effect.withSpan("cache.get", {
					kind: "client",
					attributes: {
						"cache.system": "memory",
						"cache.operation": "get",
						"cache.key": "todos:all",
					},
				}),
			)

			if (cached) {
				yield* Effect.annotateCurrentSpan({ "todo.count": cached.length, "cache.hit": true })
				return cached
			}

			const todos = yield* Effect.gen(function* () {
				yield* jitter(10, 40)
				const map = yield* Ref.get(store)
				const rows = [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
				yield* Effect.annotateCurrentSpan("db.response.returned_rows", rows.length)
				return rows
			}).pipe(
				Effect.withSpan("db.read", {
					kind: "client",
					attributes: {
						"db.system.name": "memory",
						"db.operation.name": "scan",
						"db.collection.name": "todos",
						"db.query.text":
							"SELECT id, title, completed, created_at FROM todos ORDER BY created_at",
					},
				}),
			)

			yield* Ref.set(listCache, todos).pipe(
				Effect.withSpan("cache.set", {
					kind: "client",
					attributes: {
						"cache.system": "memory",
						"cache.operation": "set",
						"cache.key": "todos:all",
						"cache.entry.size": todos.length,
					},
				}),
			)

			yield* Effect.annotateCurrentSpan({ "todo.count": todos.length, "cache.hit": false })
			return todos
		})

		const create = Effect.fn("TodoService.create")(function* (rawTitle: string) {
			const title = yield* Effect.gen(function* () {
				const trimmed = rawTitle.trim()
				if (trimmed.length === 0) {
					yield* spanEvent("todo.validation.failed", {
						"validation.field": "title",
						"validation.rule": "non_empty",
					})
					return yield* new InvalidTodoError({ field: "title", message: "Title must not be empty" })
				}
				if (trimmed.length > MAX_TITLE_LENGTH) {
					yield* spanEvent("todo.validation.failed", {
						"validation.field": "title",
						"validation.rule": "max_length",
					})
					return yield* new InvalidTodoError({
						field: "title",
						message: `Title must be at most ${MAX_TITLE_LENGTH} characters`,
					})
				}
				return trimmed
			}).pipe(
				Effect.withSpan("todo.validate", {
					attributes: { "validation.input_length": rawTitle.length },
				}),
				Effect.tapError((error) =>
					Effect.logWarning("todo.rejected").pipe(
						Effect.annotateLogs({ "validation.field": error.field, "error.type": error._tag }),
					),
				),
			)

			const id = crypto.randomUUID()
			const todo = new Todo({ id, title, completed: false, createdAt: new Date().toISOString() })
			yield* Effect.gen(function* () {
				yield* jitter(20, 90)
				yield* Ref.update(store, (map) => new Map(map).set(id, todo))
			}).pipe(
				Effect.withSpan("db.persist", {
					kind: "client",
					attributes: {
						"db.system.name": "memory",
						"db.operation.name": "insert",
						"db.collection.name": "todos",
						"db.query.text":
							"INSERT INTO todos (id, title, completed, created_at) VALUES (?, ?, ?, ?)",
						"todo.id": id,
					},
				}),
			)
			yield* invalidate("create")
			yield* publishCount
			yield* Effect.logInfo("todo.created").pipe(
				Effect.annotateLogs({ "todo.id": id, "todo.title": title }),
			)
			yield* notify("created", todo)
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
				yield* spanEvent("todo.write.conflict", { "todo.id": id, "retry.attempts": 3 })
				yield* Effect.logWarning("todo.toggle.conflict").pipe(Effect.annotateLogs({ "todo.id": id }))
				return yield* new ToggleFailedError({ message: `Transient write conflict toggling ${id}` })
			}

			const updated = new Todo({ ...existing, completed: !existing.completed })
			yield* Ref.update(store, (m) => new Map(m).set(id, updated)).pipe(
				Effect.withSpan("db.persist", {
					kind: "client",
					attributes: {
						"db.system.name": "memory",
						"db.operation.name": "update",
						"db.collection.name": "todos",
						"db.query.text": "UPDATE todos SET completed = ? WHERE id = ?",
						"todo.id": id,
					},
				}),
			)
			yield* invalidate("toggle")
			yield* Effect.logInfo("todo.toggled").pipe(
				Effect.annotateLogs({ "todo.id": id, "todo.completed": updated.completed }),
			)
			yield* notify("toggled", updated)
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
					kind: "client",
					attributes: {
						"db.system.name": "memory",
						"db.operation.name": "delete",
						"db.collection.name": "todos",
						"db.query.text": "DELETE FROM todos WHERE id = ?",
						"todo.id": id,
					},
				}),
			)
			yield* invalidate("remove")
			yield* publishCount
			yield* Effect.logInfo("todo.removed").pipe(Effect.annotateLogs({ "todo.id": id }))
			yield* notify("removed", existing)
			return existing
		})

		return {
			list: () => measured("list", list()),
			create: (title: string) => measured("create", create(title)),
			toggle: (id: string) => measured("toggle", toggle(id)),
			remove: (id: string) => measured("remove", remove(id)),
		} as const
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

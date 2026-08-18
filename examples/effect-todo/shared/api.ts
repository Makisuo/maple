/**
 * The Todo API contract — a single Effect `HttpApi` definition shared by BOTH
 * the Effect backend (`server/`) and the React client (`web/`).
 *
 * The backend implements it with `HttpApiBuilder.group`; the browser consumes
 * it with `AtomHttpApi.Service`. One schema, type-safe end to end. Because the
 * client and server both speak Effect's HTTP stack, every request automatically
 * carries a W3C `traceparent` header, so the browser span and the server span
 * land in the *same* distributed trace inside Maple.
 */
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { HttpApi } from "effect/unstable/httpapi"

export class Todo extends Schema.Class<Todo>("Todo")({
	id: Schema.String,
	title: Schema.String,
	completed: Schema.Boolean,
	createdAt: Schema.String,
}) {}

export class CreateTodoRequest extends Schema.Class<CreateTodoRequest>("CreateTodoRequest")({
	title: Schema.String,
}) {}

/** Returned when an id doesn't exist (toggle/remove of a missing todo). */
export class TodoNotFoundError extends Schema.TaggedError<TodoNotFoundError>()(
	"@maple-examples/todo/TodoNotFoundError",
	{ id: Schema.String, message: Schema.String },
	{ httpApiStatus: 404 },
) {}

/** Rejected input — an empty or oversized title. A second, deterministic error
 * group in Maple's Errors view, so it isn't all random flakes. */
export class InvalidTodoError extends Schema.TaggedError<InvalidTodoError>()(
	"@maple-examples/todo/InvalidTodoError",
	{ field: Schema.String, message: Schema.String },
	{ httpApiStatus: 400 },
) {}

/**
 * The intentionally-flaky failure: `toggle` fails ~15% of the time with this
 * error so Maple's Errors view, the Error span status, and the apdex/error-rate
 * metrics all have something to show during the demo.
 */
export class ToggleFailedError extends Schema.TaggedError<ToggleFailedError>()(
	"@maple-examples/todo/ToggleFailedError",
	{ message: Schema.String },
	{ httpApiStatus: 500 },
) {}

export class TodosApiGroup extends HttpApiGroup.make("todos")
	.add(
		HttpApiEndpoint.get("list", "/", {
			success: Schema.Array(Todo),
		}),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: CreateTodoRequest,
			success: Todo,
			error: InvalidTodoError,
		}),
	)
	.add(
		HttpApiEndpoint.post("toggle", "/:id/toggle", {
			params: { id: Schema.String },
			success: Todo,
			error: [TodoNotFoundError, ToggleFailedError],
		}),
	)
	.add(
		HttpApiEndpoint.delete("remove", "/:id", {
			params: { id: Schema.String },
			success: Todo,
			error: TodoNotFoundError,
		}),
	)
	.prefix("/api/todos") {}

export class TodoApi extends HttpApi.make("TodoApi").add(TodosApiGroup) {}

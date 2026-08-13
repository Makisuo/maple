/**
 * User actions as traced atoms.
 *
 * Calling the API directly from a component would give you a bare
 * `http.client` span in Maple — accurate, but it tells you nothing about what
 * the person was doing. Each action here runs inside a named `ui.todo.*` span
 * carrying the interaction's own attributes, and the HTTP span nests underneath
 * it. So the trace reads top-down as: *user clicked toggle* → *browser called
 * the API* → *api hit its store* → *notifier fanned out a webhook*.
 *
 * They're built with `TodoApiClient.runtime.fn`, so they run inside the same
 * atom runtime that carries the Maple tracer (wired in `registry.ts`).
 */
import { Effect } from "effect"
import { CreateTodoRequest } from "../../../shared/api.ts"
import { TodoApiClient } from "./atom-client.ts"

export const addTodoAtom = TodoApiClient.runtime.fn<string>()(
	Effect.fn("ui.todo.add")(function* (title: string) {
		yield* Effect.annotateCurrentSpan({
			"ui.component": "todo-form",
			"ui.action": "submit",
			"todo.title_length": title.length,
		})
		const client = yield* TodoApiClient
		const todo = yield* client.todos.create({ payload: new CreateTodoRequest({ title }) })
		yield* Effect.annotateCurrentSpan("todo.id", todo.id)
		return todo
	}),
)

export const toggleTodoAtom = TodoApiClient.runtime.fn<string>()(
	Effect.fn("ui.todo.toggle")(function* (id: string) {
		yield* Effect.annotateCurrentSpan({
			"ui.component": "todo-list-item",
			"ui.action": "toggle",
			"todo.id": id,
		})
		const client = yield* TodoApiClient
		return yield* client.todos.toggle({ params: { id } })
	}),
)

export const removeTodoAtom = TodoApiClient.runtime.fn<string>()(
	Effect.fn("ui.todo.remove")(function* (id: string) {
		yield* Effect.annotateCurrentSpan({
			"ui.component": "todo-list-item",
			"ui.action": "delete",
			"todo.id": id,
		})
		const client = yield* TodoApiClient
		return yield* client.todos.remove({ params: { id } })
	}),
)

/**
 * Fired once on mount. Gives `todo-web` a root span and a log line that aren't
 * tied to a request, so the service shows up in Maple even before anyone
 * clicks anything.
 */
export const appStartedAtom = TodoApiClient.runtime.fn<void>()(
	Effect.fn("ui.app.start")(function* () {
		yield* Effect.annotateCurrentSpan({
			"ui.component": "app",
			"browser.viewport.width": typeof window === "undefined" ? 0 : window.innerWidth,
		})
		yield* Effect.logInfo("app.started")
	}),
)

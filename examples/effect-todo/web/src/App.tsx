import { Exit } from "effect"
import { useState } from "react"
import { CreateTodoRequest, type Todo } from "../../shared/api.ts"
import { TodoApiClient } from "./lib/atom-client.ts"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "./lib/effect-atom.ts"

// Module-scope singletons — one atom per query, memoized by the client.
const listAtom = TodoApiClient.query("todos", "list", { reactivityKeys: ["todos"] })

export function App() {
	const listResult = useAtomValue(listAtom)
	const refresh = useAtomRefresh(listAtom)

	const createTodo = useAtomSet(TodoApiClient.mutation("todos", "create"), { mode: "promiseExit" })
	const toggleTodo = useAtomSet(TodoApiClient.mutation("todos", "toggle"), { mode: "promiseExit" })
	const removeTodo = useAtomSet(TodoApiClient.mutation("todos", "remove"), { mode: "promiseExit" })

	const [title, setTitle] = useState("")
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const todos = Result.builder(listResult)
		.onSuccess((items) => items)
		.orElse(() => [] as ReadonlyArray<Todo>)
	const loading = Result.isInitial(listResult)

	async function add() {
		const value = title.trim()
		if (!value || busy) return
		setBusy(true)
		setError(null)
		setTitle("")
		const exit = await createTodo({ payload: new CreateTodoRequest({ title: value }) })
		if (Exit.isSuccess(exit)) refresh()
		else setError("Failed to add todo.")
		setBusy(false)
	}

	async function toggle(id: string) {
		setError(null)
		const exit = await toggleTodo({ params: { id } })
		if (Exit.isSuccess(exit)) refresh()
		else setError("Toggle failed — simulated write conflict. See it in Maple → Errors.")
	}

	async function remove(id: string) {
		setError(null)
		const exit = await removeTodo({ params: { id } })
		if (Exit.isSuccess(exit)) refresh()
		else setError("Failed to delete todo.")
	}

	return (
		<div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-200 px-4 py-12 text-slate-900 dark:from-slate-950 dark:to-slate-900 dark:text-slate-100">
			<main className="mx-auto w-full max-w-lg">
				<header className="mb-6">
					<div className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
						<span aria-hidden>🌳</span>
						<h1>Todos</h1>
					</div>
					<p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
						Effect backend · effect-atom client · every action traced into Maple local mode.
					</p>
				</header>

				<div className="rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
					<form
						className="flex gap-2 border-b border-slate-100 p-4 dark:border-slate-800"
						onSubmit={(e) => {
							e.preventDefault()
							void add()
						}}
					>
						<input
							className="flex-1 rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-slate-700"
							placeholder="Add a todo…"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
						/>
						<button
							type="submit"
							disabled={busy || !title.trim()}
							className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
						>
							Add
						</button>
					</form>

					{error && (
						<p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
							{error}
						</p>
					)}

					<ul className="divide-y divide-slate-100 dark:divide-slate-800">
						{loading && (
							<li className="px-4 py-6 text-center text-sm text-slate-400">Loading…</li>
						)}
						{Result.isFailure(listResult) && (
							<li className="flex items-center justify-center gap-3 px-4 py-6 text-sm text-rose-600 dark:text-rose-400">
								<span>Failed to load todos.</span>
								<button
									type="button"
									onClick={refresh}
									className="rounded-md border border-rose-300 px-2 py-1 text-xs font-medium hover:bg-rose-50 dark:border-rose-800 dark:hover:bg-rose-950/40"
								>
									Try again
								</button>
							</li>
						)}
						{Result.isSuccess(listResult) && todos.length === 0 && (
							<li className="px-4 py-6 text-center text-sm text-slate-400">
								Nothing yet — add one above.
							</li>
						)}
						{todos.map((todo) => (
							<li key={todo.id} className="group flex items-center gap-3 px-4 py-3">
								<button
									type="button"
									aria-label={todo.completed ? "Mark incomplete" : "Mark complete"}
									onClick={() => void toggle(todo.id)}
									className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition ${
										todo.completed
											? "border-emerald-600 bg-emerald-600 text-white"
											: "border-slate-300 hover:border-emerald-500 dark:border-slate-600"
									}`}
								>
									{todo.completed && (
										<svg
											viewBox="0 0 12 12"
											className="h-3 w-3"
											fill="none"
											stroke="currentColor"
											strokeWidth={2}
										>
											<path
												d="M2.5 6.5l2 2 5-5"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
										</svg>
									)}
								</button>
								<span
									className={`flex-1 text-sm ${
										todo.completed
											? "text-slate-400 line-through"
											: "text-slate-700 dark:text-slate-200"
									}`}
								>
									{todo.title}
								</span>
								<button
									type="button"
									aria-label="Delete"
									onClick={() => void remove(todo.id)}
									className="rounded-md px-1.5 py-1 text-slate-300 opacity-0 transition hover:text-rose-500 group-hover:opacity-100"
								>
									✕
								</button>
							</li>
						))}
					</ul>
				</div>

				<p className="mt-4 text-center text-xs text-slate-400">
					Open{" "}
					<span className="font-medium text-slate-500 dark:text-slate-300">Maple → Traces</span> to
					watch each click flow <span className="font-mono">todo-web → todo-api</span>.
				</p>
			</main>
		</div>
	)
}

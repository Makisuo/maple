/**
 * A `DurableObjectState` backed by a real in-memory SQLite database.
 *
 * `ChatSession` is mostly SQL: the event log, the transcript fold, and the turn mutex are all
 * statements against `ctx.storage.sql`. Mocking that away would test a paraphrase of the class
 * rather than the class, and the fold bug this harness exists to pin (an `indexOf` on an object
 * that had just been replaced) lived entirely in the code a mock would have skipped.
 *
 * `node:sqlite` is the same engine Durable Object storage exposes, and the `SqlStorage` surface the
 * class touches is small: `exec(sql, ...bindings)` returning a cursor with `one()` and `toArray()`.
 */
import { DatabaseSync } from "node:sqlite"

/** Everything the DO under test reads off its state, and nothing more. */
export interface FakeDurableObjectState {
	readonly storage: { readonly sql: SqlStorage }
	/** Collected rather than awaited, so a test can drive the turn itself. */
	readonly waitUntil: (promise: Promise<unknown>) => void
	readonly pending: Array<Promise<unknown>>
}

export const makeFakeDurableObjectState = (): FakeDurableObjectState => {
	const db = new DatabaseSync(":memory:")
	const pending: Array<Promise<unknown>> = []

	const sql = {
		exec: (statement: string, ...bindings: ReadonlyArray<unknown>) => {
			// `ChatSession`'s CREATE TABLE block is several statements in one string; `node:sqlite`
			// splits those only through `exec`, while parameterised statements need `prepare`.
			if (bindings.length === 0 && /;\s*\S/.test(statement.trim())) {
				db.exec(statement)
				return makeCursor([])
			}
			const prepared = db.prepare(statement)
			if (/^\s*(select|pragma)/i.test(statement)) {
				return makeCursor(prepared.all(...(bindings as never[])) as Array<Record<string, unknown>>)
			}
			prepared.run(...(bindings as never[]))
			return makeCursor([])
		},
	}

	return {
		storage: { sql: sql as unknown as SqlStorage },
		waitUntil: (promise) => {
			// Swallow rejections here the way the runtime does; a test that cares awaits `pending`.
			pending.push(promise.catch(() => undefined))
		},
		pending,
	}
}

const makeCursor = (rows: Array<Record<string, unknown>>) => ({
	toArray: () => rows,
	one: () => {
		if (rows.length !== 1) {
			throw new Error(`Expected exactly one row, got ${rows.length}`)
		}
		return rows[0]
	},
	[Symbol.iterator]: () => rows[Symbol.iterator](),
})

/**
 * `scheduler.wait` is a Workers global that node does not define. `ChatSession.tail` polls with it,
 * so tests that exercise the tail need it present.
 */
export const installSchedulerWait = (): void => {
	const globals = globalThis as { scheduler?: { wait?: (ms: number) => Promise<void> } }
	if (globals.scheduler?.wait) return
	globals.scheduler = {
		...globals.scheduler,
		wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	}
}

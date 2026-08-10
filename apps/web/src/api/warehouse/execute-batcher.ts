import {
	QueryEngineExecuteRequest,
	QueryEngineExecuteResponse,
	QUERY_ENGINE_BATCH_MAX,
	type QueryEngineBatchOutcome,
} from "@maple/query-engine"

/**
 * Coalesces `/api/query-engine/execute` calls into `/execute-batch`.
 *
 * Every warehouse module funnels through one choke point, and each atom runs on
 * its own fiber, so a render pass used to emit one POST per query — each with
 * its own CORS preflight, against a worker pinned to us-east-1. A dashboard
 * could open dozens of round trips before painting anything.
 *
 * A *timer* window (not `queueMicrotask`) is what makes this work: atoms mount
 * across separate React commits, and a microtask can't span a commit boundary,
 * so most calls would still go out alone.
 *
 * Deliberately NOT `Effect.request`/`RequestResolver` — those batch within a
 * single fiber's execution graph, and these callers are on unrelated fibers.
 */

/** How long to hold a query waiting for siblings. Long enough for one React commit. */
export const EXECUTE_BATCH_WINDOW_MS = 15

/** Issues one batch request. Injected so tests don't need the API client. */
export type SendExecuteBatch = (
	requests: ReadonlyArray<QueryEngineExecuteRequest>,
) => Promise<ReadonlyArray<QueryEngineBatchOutcome>>

interface PendingExecute {
	readonly payload: QueryEngineExecuteRequest
	readonly resolve: (response: QueryEngineExecuteResponse) => void
	readonly reject: (cause: unknown) => void
}

export interface ExecuteBatcher {
	readonly enqueue: (payload: QueryEngineExecuteRequest) => Promise<QueryEngineExecuteResponse>
}

export const makeExecuteBatcher = (
	send: SendExecuteBatch,
	windowMs: number = EXECUTE_BATCH_WINDOW_MS,
): ExecuteBatcher => {
	let pending: Array<PendingExecute> = []
	let flushHandle: ReturnType<typeof setTimeout> | undefined

	const schedule = () => {
		if (flushHandle !== undefined) return
		flushHandle = setTimeout(flush, windowMs)
	}

	const flush = () => {
		if (flushHandle !== undefined) {
			clearTimeout(flushHandle)
			flushHandle = undefined
		}
		if (pending.length === 0) return

		const batch = pending.slice(0, QUERY_ENGINE_BATCH_MAX)
		// Anything over the cap goes out as the next batch rather than being dropped.
		pending = pending.slice(QUERY_ENGINE_BATCH_MAX)
		if (pending.length > 0) schedule()

		send(batch.map((entry) => entry.payload)).then(
			(results) => {
				batch.forEach((entry, index) => {
					const outcome = results[index]
					if (outcome === undefined) {
						entry.reject(new Error("Batch response was missing a result for this query."))
					} else if (outcome.outcome === "failure") {
						// Carries the server's original `_tag`, so normalizeWarehouseError
						// passes it through and the UI keeps its specific error copy.
						entry.reject(outcome.error)
					} else {
						entry.resolve(new QueryEngineExecuteResponse({ result: outcome.result }))
					}
				})
			},
			(cause: unknown) => {
				// Whole-request failure (auth, transport, decode) — every query in
				// this batch failed for the same reason.
				for (const entry of batch) entry.reject(cause)
			},
		)
	}

	return {
		enqueue: (payload) =>
			new Promise<QueryEngineExecuteResponse>((resolve, reject) => {
				pending.push({ payload, resolve, reject })
				// A full batch has nothing to gain from waiting out the window.
				if (pending.length >= QUERY_ENGINE_BATCH_MAX) flush()
				else schedule()
			}),
	}
}

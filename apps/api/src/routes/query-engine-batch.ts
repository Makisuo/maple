import type { QueryEngineBatchOutcome, QueryEngineResult } from "@maple/query-engine"
import { Clock, Duration, Effect } from "effect"

/**
 * Fan-out for `POST /api/query-engine/execute-batch`.
 *
 * Extracted from the route handler so the two things that actually carry risk —
 * the shared deadline and per-item failure isolation — are testable without an
 * HTTP harness.
 */

/**
 * Concurrency for the fan-out. Matches the bucket-cache fill concurrency, which
 * is already tuned for the Cloudflare six-connection limit — going unbounded
 * would reintroduce exactly the outbound contention `warmRoute` exists to avoid.
 *
 * `QUERY_ENGINE_BATCH_MAX` (the client-side cap, in @maple/domain) is held equal
 * to this on purpose, so a batch is exactly one wave and can't be gated by a
 * tail query in a later wave. Keep them in step until outcomes stream.
 */
export const QE_BATCH_CONCURRENCY = 4

/**
 * Wall-clock ceiling for one batch, shared by every item. The browser aborts at
 * 45s, so the response has to land before that: better to return the results
 * that finished plus one timeout than to have the client throw the batch away.
 */
export const QE_BATCH_DEADLINE_MS = 25_000

const timedOut = (): QueryEngineBatchOutcome => ({
	outcome: "failure",
	error: {
		_tag: "@maple/http/errors/QueryEngineTimeoutError",
		message: "Query exceeded the batch deadline.",
	},
})

/**
 * Runs every request against a SHARED deadline, so total wall time is bounded
 * no matter how many items or waves there are. Per-item failures are returned
 * as `failure` outcomes rather than failing the effect: one bad widget must not
 * take down the others sharing its request.
 */
export const runQueryEngineBatch = <
	Request,
	Error extends { readonly _tag: string; readonly message: string },
>(options: {
	readonly requests: ReadonlyArray<Request>
	readonly execute: (request: Request) => Effect.Effect<QueryEngineResult, Error>
	readonly deadlineMs?: number
	readonly concurrency?: number
}): Effect.Effect<ReadonlyArray<QueryEngineBatchOutcome>> =>
	Effect.gen(function* () {
		const deadline = (yield* Clock.currentTimeMillis) + (options.deadlineMs ?? QE_BATCH_DEADLINE_MS)
		return yield* Effect.forEach(
			options.requests,
			(request) =>
				Effect.gen(function* () {
					// Each item races what's LEFT of the batch budget, not a fresh
					// per-item timeout — otherwise N waves could each take the full
					// timeout and blow past the client's abort.
					const remaining = deadline - (yield* Clock.currentTimeMillis)
					if (remaining <= 0) return timedOut()
					return yield* options.execute(request).pipe(
						Effect.map(
							(result) => ({ outcome: "success", result }) satisfies QueryEngineBatchOutcome,
						),
						Effect.timeoutOrElse({
							duration: Duration.millis(remaining),
							orElse: () => Effect.succeed(timedOut()),
						}),
						Effect.catch((error) =>
							Effect.succeed({
								outcome: "failure",
								error: { _tag: error._tag, message: error.message },
							} satisfies QueryEngineBatchOutcome),
						),
					)
				}),
			{ concurrency: options.concurrency ?? QE_BATCH_CONCURRENCY },
		)
	})

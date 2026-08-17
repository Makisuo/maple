import type { Effect } from "effect"
import type { QueryEngineResult, QuerySpec } from "@maple/domain/query-engine"

export interface QuerySetExecuteRequest {
	readonly startTime: string
	readonly endTime: string
	readonly query: QuerySpec
}

/**
 * "Execute one QuerySpec over one window" — the only thing the runner needs from
 * a host, and the only thing its two hosts genuinely share.
 *
 * The web app satisfies it with `executeQueryEngine` (an HTTP call that a
 * per-tick batcher coalesces into one `POST /execute-batch`); the API satisfies
 * it with `QueryEngineService.execute`, straight to the warehouse.
 *
 * Every part of this shape is load-bearing:
 *
 *   - **No tenant parameter.** The web app has no tenant to pass — it is the JWT
 *     — while the API adapter closes over `TenantContext`. A tenant parameter
 *     would force the web side to invent one.
 *   - **`R = never`.** The web executor self-provides through its runtime, and
 *     the API adapter is built inside a generator that has already yielded
 *     `QueryEngineService`, so the requirement is discharged at construction. An
 *     `R` type parameter would infect every runner signature to buy nothing.
 *   - **`E` stays generic.** The runner never inspects it; each host keeps its
 *     own error union rather than being mapped into a lowest common denominator
 *     that both then have to map back out of.
 *   - **Returns the whole `QueryEngineResult` union**, not a narrowed arm. The
 *     runner asserts `result.kind` itself and folds a mismatch into a per-query
 *     error, which is what keeps one wrong-shaped query from failing the batch.
 *   - **One method, no batch method.** Batching, caching and HTTP-vs-direct are
 *     adapter policy. What the runner owes the adapter in return is issuing its
 *     per-query calls in ONE tick — see the concurrency note on
 *     `runQuerySetWindow`.
 */
export interface QuerySetExecutor<E> {
	readonly execute: (request: QuerySetExecuteRequest) => Effect.Effect<QueryEngineResult, E>
	/**
	 * Render a host failure as the per-query message a chart shows on its failed
	 * series card. On the web that is `displayError`; on the API it is the
	 * failure's own message. Neither belongs in this package.
	 */
	readonly describeError: (error: E) => string
}

/**
 * The API's `QuerySetExecutor` — the server-side twin of the browser's.
 *
 * The browser satisfies the same port with an HTTP call that a per-tick batcher
 * coalesces into one `POST /execute-batch`; here there is no transport to
 * cross, so it goes straight to `QueryEngineService.execute` — the identical
 * call the batch handler makes on the far side of that HTTP hop.
 *
 * Having both hosts drive the *same* runners (`runTimeseriesQuerySet` and
 * friends) is what keeps a shared dashboard's numbers equal to the signed-in
 * dashboard's. A second server-side implementation of "query set to rows" would
 * be a second set of bucketing, formula and comparison-window decisions to keep
 * in step, and they would drift.
 */
import type { QuerySetExecutor } from "@maple/query-engine/query-set"
import { Effect } from "effect"
import type { QueryEngineServiceApi } from "@/services/warehouse/QueryEngineService"
import type { TenantContext } from "@/services/auth/tenant-context"

export const makeServerQuerySetExecutor = (
	tenant: TenantContext,
	queryEngine: QueryEngineServiceApi,
): QuerySetExecutor<unknown> => ({
	execute: (request) =>
		queryEngine
			.execute(tenant, {
				startTime: request.startTime,
				endTime: request.endTime,
				query: request.query,
			})
			.pipe(Effect.map((response) => response.result)),
	// The failure's own message. `displayError` is a web concern — the runner
	// only needs a string for the per-query card, and on this side the tagged
	// error already carries a useful one.
	describeError: (error) => (error instanceof Error ? error.message : "Query failed"),
})

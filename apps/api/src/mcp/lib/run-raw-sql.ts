import { Effect } from "effect"
import type { RawSqlValidationError } from "@maple/domain/http"
import type { WarehouseExecutionError } from "@maple/query-engine/execution"
import { computeBucketSecondsForRange } from "@maple/query-engine"
import { makeExecuteRawSql } from "@maple/query-engine/runtime"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import type { TenantContext } from "@/services/auth/tenant-context"

/**
 * `$__interval_s` when the caller doesn't pin `granularitySeconds`.
 *
 * `BUCKET_POLICIES.rawSql` — the same policy the signed-in raw-SQL route
 * (`executeRawSql` in `routes/internal/query-engine.http.ts`) applies. This
 * used to be a private 120-point ladder starting at 1s that "mirrored" the web
 * path and drifted from it, so `inspect_chart_data` and a shared dashboard's
 * raw-SQL tile bucketed a 12h window at 5m while the board itself used 30m —
 * different values for the same chart. One policy now.
 */
export function autoBucketSeconds(startTime: string, endTime: string): number {
	return computeBucketSecondsForRange(startTime, endTime, "rawSql")
}

export interface RunRawSqlInput {
	readonly tenant: TenantContext
	readonly sql: string
	readonly startTime: string
	readonly endTime: string
	readonly granularitySeconds: number
}

/**
 * Expand the raw-SQL macros (`$__orgFilter`, `$__timeFilter(col)`, …) with the
 * full safety pass (required org filter, DDL/DML deny-list, single-statement,
 * auto-LIMIT) and run the result through `WarehouseQueryService.rawSqlQuery`,
 * returning the rows plus column/row metadata. Shared by the `run_sql` MCP tool
 * and `inspect_chart_data`'s raw_sql_chart branch so both honor the identical
 * guardrails. Fails with `RawSqlValidationError` (macro/safety) or a
 * `WarehouseError` (execution); callers surface these to the agent.
 */
export const runRawSql = Effect.fn("runRawSql")(function* (input: RunRawSqlInput) {
	const warehouse = yield* WarehouseQueryService
	const executeRawSql = makeExecuteRawSql<TenantContext, WarehouseExecutionError | RawSqlValidationError>(
		warehouse,
	)
	return yield* executeRawSql(input.tenant, {
		sql: input.sql,
		orgId: input.tenant.orgId,
		startTime: input.startTime,
		endTime: input.endTime,
		granularitySeconds: input.granularitySeconds,
		workload: "interactive",
		context: "mcp.run_sql",
	})
})

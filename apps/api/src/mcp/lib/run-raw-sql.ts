import { Effect } from "effect"
import type { RawSqlValidationError } from "@maple/domain/http"
import type { WarehouseSqlError } from "@maple/query-engine/execution"
import { makeExecuteRawSql, type ExecuteRawSqlResult } from "@maple/query-engine/runtime"
import { WarehouseQueryService } from "@/lib/WarehouseQueryService"
import type { TenantContext } from "@/lib/tenant-context"

// Auto-bucket ladder mirrors the web/HTTP raw-SQL path so `$__interval_s`
// resolves to a sensible value when the caller doesn't pin granularity.
const TARGET_POINTS = 120
const AUTO_BUCKET_LADDER = [1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400]

/** Pick a bucket width that yields ~TARGET_POINTS points over the window. */
export function autoBucketSeconds(startTime: string, endTime: string): number {
	const toEpochMs = (value: string) => new Date(value.replace(" ", "T") + "Z").getTime()
	const startMs = toEpochMs(startTime)
	const endMs = toEpochMs(endTime)
	if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return 300
	const rangeSeconds = Math.max((endMs - startMs) / 1000, 1)
	const raw = Math.ceil(rangeSeconds / TARGET_POINTS)
	return AUTO_BUCKET_LADDER.reduce(
		(best, candidate) => (Math.abs(candidate - raw) < Math.abs(best - raw) ? candidate : best),
		AUTO_BUCKET_LADDER[0],
	)
}

export interface RunRawSqlInput {
	readonly tenant: TenantContext
	readonly sql: string
	readonly startTime: string
	readonly endTime: string
	readonly granularitySeconds: number
}

export type RunRawSqlResult = ExecuteRawSqlResult

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
	const executeRawSql = makeExecuteRawSql<TenantContext, WarehouseSqlError | RawSqlValidationError>(
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

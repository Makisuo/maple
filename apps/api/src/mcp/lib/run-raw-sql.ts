import { Effect } from "effect"
import {
	MAX_RAW_SQL_LENGTH,
	RawSqlValidationError,
} from "@maple/domain/http"
import { makeExpandMacros, rawSqlResultLimitError } from "@maple/query-engine/runtime"
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

export interface RunRawSqlResult {
	readonly rows: ReadonlyArray<Record<string, unknown>>
	readonly columns: ReadonlyArray<string>
	readonly rowCount: number
	readonly expandedSql: string
	readonly granularitySeconds: number
}

/**
 * Expand the raw-SQL macros (`$__orgFilter`, `$__timeFilter(col)`, …) with the
 * full safety pass (required org filter, DDL/DML deny-list, single-statement,
 * auto-LIMIT) and run the result through `WarehouseQueryService.sqlQuery`,
 * returning the rows plus column/row metadata. Shared by the `run_sql` MCP tool
 * and `inspect_chart_data`'s raw_sql_chart branch so both honor the identical
 * guardrails. Fails with `RawSqlValidationError` (macro/safety) or a
 * `WarehouseError` (execution); callers surface these to the agent.
 */
export const runRawSql = Effect.fn("runRawSql")(function* (input: RunRawSqlInput) {
	if (input.sql.length > MAX_RAW_SQL_LENGTH) {
		return yield* new RawSqlValidationError({
			code: "ResourceLimit",
			message: `Raw SQL is limited to ${MAX_RAW_SQL_LENGTH} characters`,
		})
	}
	if (!Number.isFinite(input.granularitySeconds) || input.granularitySeconds <= 0) {
		return yield* new RawSqlValidationError({
			code: "ResourceLimit",
			message: "Raw SQL granularity must be a positive finite number",
		})
	}
	const expanded = yield* makeExpandMacros({
		sql: input.sql,
		orgId: input.tenant.orgId,
		startTime: input.startTime,
		endTime: input.endTime,
		granularitySeconds: input.granularitySeconds,
	})

	const warehouse = yield* WarehouseQueryService
	const rows = yield* warehouse.sqlQuery(input.tenant, expanded.sql, {
		profile: "rawInteractive",
		context: "mcp.run_sql",
		// Untrusted user SQL — scope to a per-org Tinybird JWT (server-enforced isolation).
		scopeToOrgJwt: true,
	})
	const resultLimitError = rawSqlResultLimitError(rows)
	if (resultLimitError != null) {
		return yield* new RawSqlValidationError({
			code: "ResourceLimit",
			message: resultLimitError,
		})
	}

	const records = rows as ReadonlyArray<Record<string, unknown>>
	const columns = records.length > 0 ? Object.keys(records[0]) : []

	return {
		rows: records,
		columns,
		rowCount: records.length,
		expandedSql: expanded.sql,
		granularitySeconds: expanded.granularitySeconds,
	} satisfies RunRawSqlResult
})

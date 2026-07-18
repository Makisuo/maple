import {
	optionalNumberParam,
	optionalStringParam,
	requiredStringParam,
	type McpToolRegistrar,
	type McpToolResult,
} from "./types"
import { Effect, Schema } from "effect"
import { resolveTenant } from "@/mcp/lib/query-warehouse"
import { resolveTimeRange } from "../lib/time"
import { autoBucketSeconds, runRawSql } from "../lib/run-raw-sql"
import { createDualContent } from "../lib/structured-output"
import { formatTable, truncate } from "../lib/format"
import { toMcpQueryError } from "../lib/map-warehouse-error"

// Rows returned to the model are capped so a wide/long result doesn't blow the
// context. The full count is always reported via meta.rowCount.
const MAX_RENDERED_ROWS = 100

const runSqlSchema = Schema.Struct({
	sql: requiredStringParam(
		"Raw ClickHouse SQL to run read-only. MUST reference the `$__orgFilter` macro " +
			"(expands to `OrgId = '<your-org>'`) so the query is scoped to your org — queries without it are rejected. " +
			"Optional macros: `$__timeFilter(Column)` (expands to `Column >= <start> AND Column <= <end>`), " +
			"`$__startTime`, `$__endTime`, `$__interval_s` (bucket width in seconds for toStartOfInterval). " +
			"Only a single SELECT is allowed; DDL/DML keywords (INSERT, DROP, ALTER, …) are rejected. " +
			"An outer 1,000-row result cap is always enforced. " +
			"Use describe_warehouse_tables to discover table/column names.",
	),
	start_time: optionalStringParam("Start time (YYYY-MM-DD HH:mm:ss UTC). Defaults to 1 hour ago."),
	end_time: optionalStringParam("End time (YYYY-MM-DD HH:mm:ss UTC). Defaults to now."),
	granularity_seconds: optionalNumberParam(
		"Value substituted for the `$__interval_s` macro. Auto-computed from the time range if omitted.",
	),
})

const runSqlDescription =
	"Run read-only ClickHouse SQL against your org's warehouse and return the rows. " +
	"Use this to verify a raw query before saving it as a raw_sql_chart widget, to spot-check data, " +
	"or to answer questions the structured tools (query_data, explore_attributes) can't express. " +
	"Org isolation is automatic and required via the `$__orgFilter` macro. Read-only: writes/DDL are rejected and an auto-LIMIT is applied. " +
	"For dashboard widgets prefer add_dashboard_widget; for trends/top-N prefer query_data."

function cellToString(value: unknown): string {
	if (value === null || value === undefined) return "null"
	if (typeof value === "object") return truncate(JSON.stringify(value), 60)
	return truncate(String(value), 60)
}

export function registerRunSqlTool(server: McpToolRegistrar) {
	server.tool(
		"run_sql",
		runSqlDescription,
		runSqlSchema,
		Effect.fn("McpTool.runSql")(function* (params) {
			const tenant = yield* resolveTenant
			const { st, et } = resolveTimeRange(params.start_time, params.end_time)
			const granularitySeconds = params.granularity_seconds ?? autoBucketSeconds(st, et)

			const outcome = yield* runRawSql({
				tenant,
				sql: params.sql,
				startTime: st,
				endTime: et,
				granularitySeconds,
			}).pipe(
				Effect.map((value) => ({ ok: true as const, value })),
				// Macro/safety failures are caller-fixable: echo the reason + an example.
				Effect.catchTag("@maple/http/errors/RawSqlValidationError", (error) =>
					Effect.succeed({
						ok: false as const,
						result: {
							isError: true,
							content: [
								{
									type: "text" as const,
									text:
										`SQL rejected (${error.code}): ${error.message}\n\n` +
										`Example:\n  SELECT count() AS c FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)`,
								},
							],
						} satisfies McpToolResult,
					}),
				),
				// Execution failures (CH syntax/schema/quota) surface the warehouse message so the agent can fix the SQL.
				Effect.mapError(toMcpQueryError("run_sql")),
			)

			if (!outcome.ok) return outcome.result

			const { rows, columns, rowCount, expandedSql } = outcome.value
			const rendered = rows.slice(0, MAX_RENDERED_ROWS)
			const truncated = rowCount > rendered.length

			const lines: string[] = [
				`## SQL result`,
				`Rows: ${rowCount}${truncated ? ` (showing first ${rendered.length})` : ""} | Columns: ${columns.length}`,
				`Time range: ${st} — ${et}`,
				``,
			]

			if (rowCount === 0) {
				lines.push("No rows returned.")
			} else {
				lines.push(
					formatTable(
						[...columns],
						rendered.map((row) => columns.map((col) => cellToString(row[col]))),
					),
				)
				if (truncated) lines.push(``, `… +${rowCount - rendered.length} more rows (refine with LIMIT or filters)`)
			}

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "run_sql",
					data: {
						expandedSql,
						rowCount,
						columns,
						rows: rendered,
						truncated,
						timeRange: { start: st, end: et },
					},
				}),
			}
		}),
	)
}

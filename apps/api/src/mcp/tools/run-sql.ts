import {
	optionalNumberParam,
	optionalStringParam,
	optionalTimeParam,
	requiredStringParam,
	type McpToolRegistrar,
	type McpToolResult,
} from "./types"
import { Effect, Schema } from "effect"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { resolveTimeRange } from "@/mcp/lib/time"
import { autoBucketSeconds, runRawSql } from "@/mcp/lib/run-raw-sql"
import { createDualContent } from "@/mcp/lib/structured-output"
import { formatTable, truncate } from "@/mcp/lib/format"
import { toMcpQueryError } from "@/mcp/lib/map-warehouse-error"
import { McpQueryError } from "./types"
import { describeWarehouseTable, listWarehouseTables } from "@/services/warehouse/warehouse-catalog"

// Rows returned to the model are capped so a wide/long result doesn't blow the
// context. The full count is always reported via meta.rowCount.
const MAX_RENDERED_ROWS = 100

/**
 * Matches how each backend words a missing relation: ClickHouse says "Unknown
 * table"/"doesn't exist", the Tinybird gateway says "Resource '<name>' not found".
 */
const UNKNOWN_TABLE = /unknown table|table .* does(?:n't| not) exist|Resource '[^']*' not found/i

export const withTableListOnUnknownTable = (error: McpQueryError): McpQueryError => {
	if (!UNKNOWN_TABLE.test(error.message)) return error
	const names = listWarehouseTables()
		.map((t) => t.name)
		.join(", ")
	return new McpQueryError({
		message: `${error.message}\n\nAvailable tables: ${names}.\nCall describe_warehouse_tables with a table name for its columns.`,
		pipeName: error.pipeName,
		cause: error.cause,
	})
}

/**
 * Matches how each backend words a column that isn't on the referenced table.
 * ClickHouse's analyzer says "Unknown expression or function identifier '<x>' in
 * scope <query>"; the older paths say "Unknown identifier" / "Missing columns" /
 * "There's no column".
 */
const UNKNOWN_COLUMN = /unknown (?:expression or function )?identifier|missing columns|there'?s no column/i

/** Cap on how many tables one enrichment describes. */
const MAX_DESCRIBED_TABLES = 3

/** Catalog tables the submitted SQL actually names, in first-mention order. */
const referencedTables = (sql: string): ReadonlyArray<string> =>
	listWarehouseTables()
		.map((t) => ({ name: t.name, at: sql.search(new RegExp(`\\b${t.name}\\b`)) }))
		.filter((t) => t.at >= 0)
		.sort((a, b) => a.at - b.at)
		.map((t) => t.name)

/**
 * The column counterpart of `withTableListOnUnknownTable`, and it exists for the
 * same reason: the warehouse names the column the agent invented but never the
 * ones that exist, so a wrong guess on a rollup table (`Count`/`Timestamp`/
 * `ServiceName` against `attribute_keys_hourly`, whose columns are `Hour` and
 * `UsageCount` and which has no per-service dimension at all) fails every retry.
 * Put the real columns in the error rather than pointing at a tool agents skip.
 */
export const withColumnListOnUnknownColumn =
	(sql: string) =>
	(error: McpQueryError): McpQueryError => {
		if (!UNKNOWN_COLUMN.test(error.message)) return error

		// Only the tables the query names; a schema dump of all 38 would bury the
		// message it is attached to.
		const described = referencedTables(sql)
			.slice(0, MAX_DESCRIBED_TABLES)
			.map((name) => describeWarehouseTable(name))
			.filter((info) => info !== null)
		if (described.length === 0) return error

		const listing = described.map(
			(info) => `\`${info.name}\`: ${info.columns.map((c) => c.name).join(", ")}`,
		)
		return new McpQueryError({
			message: `${error.message}\n\nColumns available —\n${listing.join("\n")}`,
			pipeName: error.pipeName,
			cause: error.cause,
		})
	}

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
	start_time: optionalTimeParam("Start time (YYYY-MM-DD HH:mm:ss UTC). Defaults to 1 hour ago."),
	end_time: optionalTimeParam("End time (YYYY-MM-DD HH:mm:ss UTC). Defaults to now."),
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
			const tenant = yield* CurrentMcpTenant
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
				// ...but "no such table" is the one failure the warehouse message cannot
				// resolve on its own: the agent invented a name (`otel_traces` was the
				// most common) and the reply never says what the real names are. It
				// points at describe_warehouse_tables instead, which agents skip — 60
				// calls against 1,008 run_sql calls. Put the answer in the error.
				Effect.mapError(withTableListOnUnknownTable),
				// Same gap one level down: the table exists but the column was invented.
				Effect.mapError(withColumnListOnUnknownColumn(params.sql)),
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
				if (truncated)
					lines.push(
						``,
						`… +${rowCount - rendered.length} more rows (refine with LIMIT or filters)`,
					)
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

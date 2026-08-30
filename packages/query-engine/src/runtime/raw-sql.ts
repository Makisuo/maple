import { Effect, Option } from "effect"
import {
	MAX_RAW_SQL_CELL_LENGTH,
	MAX_RAW_SQL_RESULT_BYTES,
	MAX_RAW_SQL_RESULT_ROWS,
	RawSqlValidationError,
} from "@maple/domain/http"
import { rawSqlIssue, type RawSqlWorkload } from "@maple/domain/raw-sql"
import type { QueryProfileName } from "../profiles"
import { escapeClickHouseString, splitTerminalClauses } from "@maple-dev/clickhouse-builder/sql"

// User-authored ClickHouse SQL: validation, macro expansion, and execution.
//
// Tenant isolation is enforced by the rawSqlQuery warehouse capability:
// Tinybird uses a per-org datasource-scoped JWT, BYO ClickHouse uses per-org
// credentials, and shared vanilla ClickHouse is limited to single-org mode.
// `$__orgFilter` remains mandatory as defense in depth and because OrgId is the
// leading sorting-key filter on Maple telemetry tables.

/** One extra row is the overflow sentinel for the public 1,000-row cap. */
export const RAW_SQL_FETCH_ROW_LIMIT = MAX_RAW_SQL_RESULT_ROWS + 1

export type { RawSqlWorkload }

export interface PrepareRawSqlInput {
	readonly sql: string
	readonly orgId: string
	readonly startTime: string
	readonly endTime: string
	readonly granularitySeconds: number
	readonly workload: RawSqlWorkload
}

export interface PreparedRawSql {
	readonly sql: string
	readonly granularitySeconds: number
}

export interface ExecuteRawSqlInput extends PrepareRawSqlInput {
	readonly context: string
}

export interface ExecuteRawSqlResult {
	readonly rows: ReadonlyArray<Record<string, unknown>>
	readonly columns: ReadonlyArray<string>
	readonly rowCount: number
	readonly expandedSql: string
	readonly granularitySeconds: number
}

export interface RawSqlWarehouse<TTenant, E> {
	readonly rawSqlQuery: (
		tenant: TTenant,
		sql: string,
		options: { readonly profile: QueryProfileName; readonly context: string },
	) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, E>
}

const fail = (code: RawSqlValidationError["code"], message: string) =>
	Effect.fail(new RawSqlValidationError({ code, message }))

/**
 * Validate and expand a raw query without accessing the warehouse.
 *
 * Static validation is `rawSqlIssue` in `@maple/domain` — shared with every
 * editor and tool that accepts user SQL. What is left here is what needs the
 * runtime values: macro expansion and the row-cap wrapper.
 */
export const prepareRawSql = Effect.fn("RawSql.prepare")(function* (input: PrepareRawSqlInput) {
	if (!Number.isFinite(input.granularitySeconds) || input.granularitySeconds <= 0) {
		return yield* fail("ResourceLimit", "Raw SQL granularity must be a positive finite number")
	}
	const issue = rawSqlIssue(input.sql, { workload: input.workload })
	if (issue !== null) return yield* fail(issue.code, issue.message)

	let sql = input.sql
	const orgLiteral = `'${escapeClickHouseString(input.orgId)}'`
	const startLiteral = `toDateTime('${escapeClickHouseString(input.startTime)}')`
	const endLiteral = `toDateTime('${escapeClickHouseString(input.endTime)}')`
	const granularity = Math.max(1, Math.round(input.granularitySeconds))

	// Function-form replacements throughout: a `$&`, `` $` `` or `$'` in an
	// interpolated value is a substitution pattern to `String.replace`, and
	// `escapeClickHouseString` escapes quotes and backslashes but not `$`. With a
	// string replacement, `$'` would splice the rest of the statement into the
	// literal — quotes and all.
	sql = sql.replaceAll("$__orgFilter", () => `OrgId = ${orgLiteral}`)
	sql = sql.replaceAll("$__startTime", () => startLiteral)
	sql = sql.replaceAll("$__endTime", () => endLiteral)
	sql = sql.replaceAll("$__interval_s", () => String(granularity))

	// Materialized before the loop mutates `sql`: the matches are positions in the
	// text as it was when `matchAll` was called.
	const timeFilterMatches = [...sql.matchAll(/\$__timeFilter\(([^)]*)\)/g)]
	for (const match of timeFilterMatches) {
		const column = match[1].trim()
		sql = sql.replace(match[0], () => `${column} >= ${startLiteral} AND ${column} <= ${endLiteral}`)
	}

	// Bucketing macro. An alert query that selects `$__timeGroup(Timestamp) AS bucket`
	// returns one row per evaluation window, so the preview chart renders a real
	// series instead of a single point; without it the whole range collapses into
	// one synthetic bucket, which reduces to exactly the same scalar.
	const timeGroupMatches = [...sql.matchAll(/\$__timeGroup\(([^)]*)\)/g)]
	for (const match of timeGroupMatches) {
		const column = match[1].trim()
		sql = sql.replace(match[0], () => `toStartOfInterval(${column}, INTERVAL ${granularity} SECOND)`)
	}

	// A trailing FORMAT is dropped rather than rejected: the wire format belongs
	// to the driver (the ClickHouse client asks for JSONEachRow, the Tinybird SDK
	// for JSON), so the author's choice was never going to be honoured. Erroring
	// on the most idiomatic way to end a ClickHouse query buys nothing. A
	// `SETTINGS` clause is rejected upstream by `rawSqlIssue`.

	// The wrapper is what caps rows server-side — `max_result_rows` is Tinybird-
	// restricted, so there is no settings-level equivalent. The cost is that
	// modifiers attached to the inner result (`WITH TOTALS`, `LIMIT BY`,
	// `WITH FILL`) are discarded by the outer SELECT.
	return {
		sql: `SELECT * FROM (\n${splitTerminalClauses(sql).body.trim()}\n) AS maple_raw_sql_limited\nLIMIT ${RAW_SQL_FETCH_ROW_LIMIT}`,
		granularitySeconds: granularity,
	} satisfies PreparedRawSql
})

const rawSqlResultLimitError = (rows: ReadonlyArray<Record<string, unknown>>): string | null => {
	if (rows.length > MAX_RAW_SQL_RESULT_ROWS) {
		return `Raw SQL results may contain at most ${MAX_RAW_SQL_RESULT_ROWS} rows`
	}

	let totalBytes = 2
	for (const row of rows) {
		for (const value of Object.values(row)) {
			if (typeof value === "string" && value.length > MAX_RAW_SQL_CELL_LENGTH) {
				return `Raw SQL result cells may contain at most ${MAX_RAW_SQL_CELL_LENGTH} characters`
			}
		}

		// A cyclic value or a BigInt cell throws out of `JSON.stringify` rather
		// than returning, and the caller owes the user that as a 400.
		const encoded = Effect.runSync(Effect.option(Effect.try(() => JSON.stringify(row) ?? "null")))
		if (Option.isNone(encoded)) return "Raw SQL results must be JSON serializable"
		totalBytes += new TextEncoder().encode(encoded.value).byteLength + 1
		if (totalBytes > MAX_RAW_SQL_RESULT_BYTES) {
			return `Raw SQL results may contain at most ${MAX_RAW_SQL_RESULT_BYTES} encoded bytes`
		}
	}
	return null
}

/**
 * Build the single prepare/execute workflow shared by HTTP, MCP, and alerts.
 *
 * Rows come back as `Record<string, unknown>` and stay that way. Handwritten SQL
 * has no SELECT the builder can read, so there is nothing to derive a row schema
 * from — and three of the four callers (MCP `run_sql`, dashboard raw widgets,
 * the share API) genuinely have no shape to validate against: whatever the user
 * wrote is the shape. The fourth, alert rules, decodes through
 * `RawSqlAlertRowSchema` at the point it knows what it asked for.
 *
 * An optional `rowSchema` here would give that one caller a parameter the other
 * three have to skip, with no new guarantee — the same "silently validates
 * nothing" default this DSL has spent the rest of its surface closing. Decode
 * where the contract is instead.
 */
export const makeExecuteRawSql = <TTenant, E>(warehouse: RawSqlWarehouse<TTenant, E>) =>
	Effect.fn("RawSql.execute")(function* (tenant: TTenant, input: ExecuteRawSqlInput) {
		const prepared = yield* prepareRawSql(input)
		const rows = yield* warehouse.rawSqlQuery(tenant, prepared.sql, {
			profile: input.workload === "alert" ? "rawAlert" : "rawInteractive",
			context: input.context,
		})

		const limitError = rawSqlResultLimitError(rows)
		if (limitError !== null) {
			return yield* new RawSqlValidationError({ code: "ResourceLimit", message: limitError })
		}

		return {
			rows,
			columns: rows.length > 0 ? Object.keys(rows[0]) : [],
			rowCount: rows.length,
			expandedSql: prepared.sql,
			granularitySeconds: prepared.granularitySeconds,
		} satisfies ExecuteRawSqlResult
	})

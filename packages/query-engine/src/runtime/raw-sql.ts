import { Effect } from "effect"
import {
	MAX_RAW_SQL_CELL_LENGTH,
	MAX_RAW_SQL_LENGTH,
	MAX_RAW_SQL_RESULT_BYTES,
	MAX_RAW_SQL_RESULT_ROWS,
	RawSqlValidationError,
} from "@maple/domain/http"
import type { QueryProfileName } from "../profiles"
import {
	escapeClickHouseString,
	maskLiteralsAndComments,
	splitTerminalClauses,
} from "@maple-dev/clickhouse-builder/sql"

// User-authored ClickHouse SQL: validation, macro expansion, and execution.
//
// Tenant isolation is enforced by the rawSqlQuery warehouse capability:
// Tinybird uses a per-org datasource-scoped JWT, BYO ClickHouse uses per-org
// credentials, and shared vanilla ClickHouse is limited to single-org mode.
// `$__orgFilter` remains mandatory as defense in depth and because OrgId is the
// leading sorting-key filter on Maple telemetry tables.

const COLUMN_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/

const DENY_LIST = [
	"INSERT",
	"UPDATE",
	"DELETE",
	"DROP",
	"ALTER",
	"TRUNCATE",
	"RENAME",
	"ATTACH",
	"DETACH",
	"CREATE",
	"GRANT",
	"REVOKE",
	"OPTIMIZE",
	"SYSTEM",
	"KILL",
] as const

const DENY_LIST_RE = new RegExp(`\\b(${DENY_LIST.join("|")})\\b`, "i")

/**
 * `INTO OUTFILE` is a SELECT terminal clause, so it slips past the deny list's
 * statement-keyword check while asking the server to write a file.
 */
const INTO_OUTFILE_RE = /\bINTO\s+OUTFILE\b/i

/** One extra row is the overflow sentinel for the public 1,000-row cap. */
export const RAW_SQL_FETCH_ROW_LIMIT = MAX_RAW_SQL_RESULT_ROWS + 1

export type RawSqlWorkload = "interactive" | "alert"

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

/** Validate and expand a raw query without accessing the warehouse. */
export const prepareRawSql = Effect.fn("RawSql.prepare")(function* (input: PrepareRawSqlInput) {
	if (input.sql.length === 0 || input.sql.length > MAX_RAW_SQL_LENGTH) {
		return yield* fail(
			"ResourceLimit",
			`Raw SQL must contain between 1 and ${MAX_RAW_SQL_LENGTH} characters`,
		)
	}
	if (!Number.isFinite(input.granularitySeconds) || input.granularitySeconds <= 0) {
		return yield* fail("ResourceLimit", "Raw SQL granularity must be a positive finite number")
	}
	if (!input.sql.includes("$__orgFilter")) {
		return yield* fail(
			"MissingOrgFilter",
			"SQL must reference $__orgFilter so the query is scoped to your org.",
		)
	}
	if (input.workload === "alert" && !input.sql.includes("$__timeFilter(")) {
		return yield* fail(
			"InvalidMacro",
			"Raw SQL alerts must reference $__timeFilter(...) to bound alert reads.",
		)
	}

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

	const timeFilterMatches = [...sql.matchAll(/\$__timeFilter\(([^)]*)\)/g)]
	for (const match of timeFilterMatches) {
		const column = match[1].trim()
		if (!COLUMN_IDENT_RE.test(column)) {
			return yield* fail(
				"InvalidMacro",
				`$__timeFilter argument '${column}' must be a column identifier (letters, digits, underscores, dots).`,
			)
		}
		sql = sql.replace(match[0], () => `${column} >= ${startLiteral} AND ${column} <= ${endLiteral}`)
	}

	// Bucketing macro. An alert query that selects `$__timeGroup(Timestamp) AS bucket`
	// returns one row per evaluation window, so the preview chart renders a real
	// series instead of a single point; without it the whole range collapses into
	// one synthetic bucket, which reduces to exactly the same scalar.
	const timeGroupMatches = [...sql.matchAll(/\$__timeGroup\(([^)]*)\)/g)]
	for (const match of timeGroupMatches) {
		const column = match[1].trim()
		if (!COLUMN_IDENT_RE.test(column)) {
			return yield* fail(
				"InvalidMacro",
				`$__timeGroup argument '${column}' must be a column identifier (letters, digits, underscores, dots).`,
			)
		}
		sql = sql.replace(match[0], () => `toStartOfInterval(${column}, INTERVAL ${granularity} SECOND)`)
	}

	if (sql.includes("$__")) {
		const leftover = sql.match(/\$__\w+/)?.[0] ?? "$__?"
		return yield* fail(
			"UnresolvedMacro",
			`Unknown macro ${leftover}. Supported: $__orgFilter, $__timeFilter(col), $__timeGroup(col), $__startTime, $__endTime, $__interval_s.`,
		)
	}

	// A single trailing terminator is one statement, not several — rejecting it as
	// "multiple statements" is a false error on the most common way to end a query.
	let masked = maskLiteralsAndComments(sql)
	const terminatorMatch = masked.match(/;\s*$/)
	if (terminatorMatch?.index !== undefined) {
		sql = sql.slice(0, terminatorMatch.index)
		masked = masked.slice(0, terminatorMatch.index)
	}
	if (masked.includes(";")) {
		return yield* fail(
			"MultipleStatements",
			"Multiple SQL statements are not allowed. Remove ';' separators.",
		)
	}

	const denyMatch = masked.match(DENY_LIST_RE)
	if (denyMatch) {
		return yield* fail(
			"DisallowedStatement",
			`Statement keyword '${denyMatch[1].toUpperCase()}' is not allowed in raw SQL.`,
		)
	}
	if (INTO_OUTFILE_RE.test(masked)) {
		return yield* fail(
			"DisallowedStatement",
			"INTO OUTFILE is not allowed in raw SQL — results are returned over the API.",
		)
	}
	if (!/^\s*(?:SELECT|WITH)\b/i.test(masked)) {
		return yield* fail(
			"DisallowedStatement",
			"Raw SQL must be a SELECT query (WITH common table expressions are supported).",
		)
	}

	// The row cap nests the query, and `SETTINGS` / `FORMAT` are statement
	// terminators — legal only at the very end of a top-level statement. Left in
	// place they land mid-statement and ClickHouse fails with a syntax error at
	// the clause keyword.
	const terminal = splitTerminalClauses(sql)
	if (terminal.settings !== undefined) {
		return yield* fail(
			"DisallowedStatement",
			"SETTINGS is managed by Maple — raw queries run under a fixed time and memory budget. Remove the SETTINGS clause.",
		)
	}
	// A trailing FORMAT is dropped rather than rejected: the wire format belongs
	// to the driver (the ClickHouse client asks for JSONEachRow, the Tinybird SDK
	// for JSON), so the author's choice was never going to be honoured. Erroring
	// on the most idiomatic way to end a ClickHouse query buys nothing.

	// The wrapper is what caps rows server-side — `max_result_rows` is Tinybird-
	// restricted, so there is no settings-level equivalent. The cost is that
	// modifiers attached to the inner result (`WITH TOTALS`, `LIMIT BY`,
	// `WITH FILL`) are discarded by the outer SELECT.

	return {
		sql: `SELECT * FROM (\n${terminal.body.trim()}\n) AS maple_raw_sql_limited\nLIMIT ${RAW_SQL_FETCH_ROW_LIMIT}`,
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

		let encoded: string
		try {
			encoded = JSON.stringify(row) ?? "null"
		} catch {
			return "Raw SQL results must be JSON serializable"
		}
		totalBytes += new TextEncoder().encode(encoded).byteLength + 1
		if (totalBytes > MAX_RAW_SQL_RESULT_BYTES) {
			return `Raw SQL results may contain at most ${MAX_RAW_SQL_RESULT_BYTES} encoded bytes`
		}
	}
	return null
}

/** Build the single prepare/execute workflow shared by HTTP, MCP, and alerts. */
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

import { Effect } from "effect"
import {
	MAX_RAW_SQL_CELL_LENGTH,
	MAX_RAW_SQL_LENGTH,
	MAX_RAW_SQL_RESULT_BYTES,
	MAX_RAW_SQL_RESULT_ROWS,
	RawSqlValidationError,
} from "@maple/domain/http"
import type { QueryProfileName } from "../profiles"
import { escapeClickHouseString } from "../sql"

// ---------------------------------------------------------------------------
// User-authored ClickHouse SQL: validation, macro expansion, and execution.
//
// Tenant isolation is enforced by the rawSqlQuery warehouse capability:
// Tinybird uses a per-org datasource-scoped JWT, BYO ClickHouse uses per-org
// credentials, and shared vanilla ClickHouse is limited to single-org mode.
// `$__orgFilter` remains mandatory as defense in depth and because OrgId is the
// leading sorting-key filter on Maple telemetry tables.
// ---------------------------------------------------------------------------

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

/**
 * Strip ClickHouse-style comments and string literals so keyword and semicolon
 * checks do not false-positive on their contents.
 */
function maskLiteralsAndComments(sql: string): string {
	let out = ""
	let i = 0
	while (i < sql.length) {
		const ch = sql[i]
		const next = sql[i + 1]

		if (ch === "-" && next === "-") {
			const nl = sql.indexOf("\n", i)
			i = nl === -1 ? sql.length : nl
			continue
		}
		if (ch === "/" && next === "*") {
			const end = sql.indexOf("*/", i + 2)
			i = end === -1 ? sql.length : end + 2
			continue
		}
		if (ch === "'" || ch === "`" || ch === '"') {
			const quote = ch
			out += " "
			i++
			while (i < sql.length) {
				const c = sql[i]
				if (c === "\\") {
					i += 2
					continue
				}
				if (c === quote) {
					i++
					break
				}
				out += " "
				i++
			}
			continue
		}

		out += ch
		i++
	}
	return out
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

	sql = sql.replaceAll("$__orgFilter", `OrgId = ${orgLiteral}`)
	sql = sql.replaceAll("$__startTime", startLiteral)
	sql = sql.replaceAll("$__endTime", endLiteral)
	sql = sql.replaceAll("$__interval_s", String(granularity))

	const timeFilterMatches = [...sql.matchAll(/\$__timeFilter\(([^)]*)\)/g)]
	for (const match of timeFilterMatches) {
		const column = match[1].trim()
		if (!COLUMN_IDENT_RE.test(column)) {
			return yield* fail(
				"InvalidMacro",
				`$__timeFilter argument '${column}' must be a column identifier (letters, digits, underscores, dots).`,
			)
		}
		sql = sql.replace(match[0], `${column} >= ${startLiteral} AND ${column} <= ${endLiteral}`)
	}

	if (sql.includes("$__")) {
		const leftover = sql.match(/\$__\w+/)?.[0] ?? "$__?"
		return yield* fail(
			"UnresolvedMacro",
			`Unknown macro ${leftover}. Supported: $__orgFilter, $__timeFilter(col), $__startTime, $__endTime, $__interval_s.`,
		)
	}

	const masked = maskLiteralsAndComments(sql)
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
	if (!/^\s*(?:SELECT|WITH)\b/i.test(masked)) {
		return yield* fail(
			"DisallowedStatement",
			"Raw SQL must be a SELECT query (WITH common table expressions are supported).",
		)
	}

	return {
		sql: `SELECT * FROM (\n${sql.trim()}\n) AS maple_raw_sql_limited\nLIMIT ${RAW_SQL_FETCH_ROW_LIMIT}`,
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

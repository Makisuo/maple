import { Context, Effect, Layer } from "effect"
import { MAX_RAW_SQL_RESULT_ROWS, RawSqlValidationError } from "@maple/domain/http"
import { escapeClickHouseString } from "../sql"

// ---------------------------------------------------------------------------
// Raw SQL chart macro expansion + safety checks.
//
// Users author a ClickHouse SQL string that references a handful of server-
// evaluated macros. We expand them with escaped values, then run a deny-list
// pass before handing the string off to WarehouseQueryService.sqlQuery.
//
// SECURITY NOTE: org isolation rests on three layers:
//   1. `$__orgFilter` MUST appear in the user SQL — expanded to OrgId = '<id>'.
//   2. WarehouseQueryService.sqlQuery() string-matches "OrgId" as belt+braces.
//   3. Deny-listed statements (INSERT/DROP/…) are rejected pre-execution.
//
// TODO(security): migrate to ClickHouse row policies + a read-only CH user so
// org isolation is enforced at the DB layer instead of by SQL substring checks.
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

/** Shared execution guards required by every HTTP, MCP, and alert raw-SQL caller. */
export const RAW_SQL_EXECUTION_GUARDS = {
	scopeToOrgJwt: true,
	rawResponseLimits: true,
} as const

export interface ExpandMacrosInput {
	readonly sql: string
	readonly orgId: string
	readonly startTime: string
	readonly endTime: string
	readonly granularitySeconds: number
}

export interface ExpandMacrosResult {
	readonly sql: string
	readonly granularitySeconds: number
}

export interface RawSqlChartServiceShape {
	readonly expandMacros: (
		input: ExpandMacrosInput,
	) => Effect.Effect<ExpandMacrosResult, RawSqlValidationError>
}

/**
 * Strip ClickHouse-style comments and string literals so deny-list scans and
 * semicolon detection don't false-positive on words inside them.
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

/**
 * Pure macro-expansion + safety pass. Exported so non-service callers (e.g.
 * raw-SQL alert evaluation in QueryEngineService) can reuse it without wiring
 * the `RawSqlChartService` layer.
 */
export const makeExpandMacros = Effect.fn("RawSqlChartService.expandMacros")(function* (
	input: ExpandMacrosInput,
) {
	let sql = input.sql

	if (!sql.includes("$__orgFilter")) {
		return yield* fail(
			"MissingOrgFilter",
			"SQL must reference $__orgFilter so the query is scoped to your org.",
		)
	}

	const orgLiteral = `'${escapeClickHouseString(input.orgId)}'`
	const startLiteral = `toDateTime('${escapeClickHouseString(input.startTime)}')`
	const endLiteral = `toDateTime('${escapeClickHouseString(input.endTime)}')`
	const granularity = Math.max(1, Math.round(input.granularitySeconds))

	sql = sql.replaceAll("$__orgFilter", `OrgId = ${orgLiteral}`)
	sql = sql.replaceAll("$__startTime", startLiteral)
	sql = sql.replaceAll("$__endTime", endLiteral)
	sql = sql.replaceAll("$__interval_s", String(granularity))

	// $__timeFilter(Column) -> Column >= <start> AND Column <= <end>
	// Match anything inside the parens (greedy up to next `)`), then strictly
	// validate the captured argument is a single column identifier. Catching
	// the whole inner string lets us return InvalidMacro for injection
	// attempts like `$__timeFilter(1 OR 1=1)` instead of letting them slip
	// through to the UnresolvedMacro fallback.
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
			`Statement keyword '${denyMatch[1].toUpperCase()}' is not allowed in raw SQL charts.`,
		)
	}

	if (!/^\s*(?:SELECT|WITH)\b/i.test(masked)) {
		return yield* fail(
			"DisallowedStatement",
			"Raw SQL must be a SELECT query (WITH common table expressions are supported).",
		)
	}

	// An inner LIMIT is not a trustworthy response bound: users can request a
	// much larger value, and UNION / nested queries can make textual rewriting
	// ambiguous. Put every validated query behind one outer cap instead. Fetching
	// one extra row lets the caller distinguish exactly 1,000 rows from overflow
	// without ever buffering an unbounded result.
	sql = `SELECT * FROM (\n${sql.trim()}\n) AS maple_raw_sql_limited\nLIMIT ${RAW_SQL_FETCH_ROW_LIMIT}`

	return {
		sql,
		granularitySeconds: granularity,
	} satisfies ExpandMacrosResult
})

export class RawSqlChartService extends Context.Service<RawSqlChartService, RawSqlChartServiceShape>()(
	"@maple/api/services/RawSqlChartService",
	{
		make: Effect.succeed({ expandMacros: makeExpandMacros } satisfies RawSqlChartServiceShape),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

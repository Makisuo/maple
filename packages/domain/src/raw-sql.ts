import { Schema } from "effect"
import { maskLiteralsAndComments, splitTerminalClauses } from "@maple-dev/clickhouse-builder/sql"

// The static half of raw-SQL validation: everything that can be decided from the
// query text alone, without an org, a time window, or a granularity.
//
// It lives here rather than in the query engine because the same rules have to
// be applied by every surface that accepts user SQL — the execute route, the MCP
// widget tools, the dashboard and alert editors — and each one that reimplements
// a subset of them accepts queries the others reject. Macro *expansion* stays in
// `prepareRawSql`, which is the only caller with the runtime values to do it.

export const MAX_RAW_SQL_LENGTH = 32_768
export const MAX_RAW_SQL_RESULT_ROWS = 1_000
export const MAX_RAW_SQL_RESULT_BYTES = 5_000_000
export const MAX_RAW_SQL_CELL_LENGTH = 64_000
export const MAX_RAW_SQL_ALERT_GROUPS = 100
export const MAX_RAW_SQL_GROUP_KEY_LENGTH = 256

/** What a raw query is being validated for. Alerts carry one extra rule. */
export type RawSqlWorkload = "interactive" | "alert"

export type RawSqlIssueCode =
	| "MissingOrgFilter"
	| "InvalidMacro"
	| "DisallowedStatement"
	| "DisallowedFunction"
	| "MultipleStatements"
	| "UnresolvedMacro"
	| "ResourceLimit"

export interface RawSqlIssue {
	readonly code: RawSqlIssueCode
	readonly message: string
}

/** Macro argument: a column identifier, optionally table-qualified. */
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

/**
 * ClickHouse table functions that read from somewhere other than this warehouse.
 *
 * Everything above this line polices what *kind of statement* a query is; none
 * of it constrains where a SELECT reads from. `SELECT * FROM url('http://…')`
 * is a perfectly well-formed single SELECT, and it makes the ClickHouse server —
 * not the API — issue the request, so per-org credentials and the row cap do not
 * touch it. On BYO and self-hosted clusters that is a working SSRF primitive
 * with the response handed back as rows.
 *
 * A deny list is the wrong shape long-term — only an allow list of Maple's own
 * tables closes the class, which needs a parser. Until then the shape that
 * matters is *prefix* matching, below: ClickHouse suffixes these families freely
 * (`iceberg`, `icebergS3`, `icebergAzure`, `icebergS3Cluster`, `deltaLakeAzure`,
 * `s3Cluster`), so an exact-name list goes stale the moment a variant lands —
 * and goes stale silently, because the check keeps passing. No ClickHouse scalar
 * function begins with any of these, which is what makes the prefix safe.
 */
const DISALLOWED_FUNCTION_PREFIXES = [
	"iceberg",
	"deltaLake",
	"hudi",
	"s3",
	"gcs",
	"azureBlobStorage",
	"hdfs",
	"remote",
	"cluster",
	"mysql",
	"postgresql",
	"mongodb",
	"redis",
	"sqlite",
	"odbc",
	"jdbc",
	"executable",
	"arrowFlight",
	"ytsaurus",
] as const

/**
 * Names that must match *exactly*, because each is a prefix of a legitimate
 * scalar function: `url` would take `URLHash` and `URLPathHierarchy`, `file`
 * would take `filesystemAvailable`, `hive` would take `hiveHash`, `dictionary`
 * would take nothing today but sits beside the whole `dict*` family.
 */
const DISALLOWED_FUNCTION_NAMES = [
	"url",
	"urlCluster",
	"file",
	"fileCluster",
	"input",
	"dictionary",
	"hive",
] as const

// Anchored on the opening paren so a *column* named `file`, or a scalar function
// like `urlHash`, is untouched — only the call form is a table function. The
// leading `\b` is what keeps the exact names exact: there is no word boundary
// inside `urlHash`, so its `url` prefix is never a match start.
const DISALLOWED_FUNCTION_RE = new RegExp(
	`\\b(${DISALLOWED_FUNCTION_PREFIXES.join("|")})[A-Za-z0-9_]*\\s*\\(|\\b(${DISALLOWED_FUNCTION_NAMES.join("|")})\\s*\\(`,
	"i",
)

/** Macros the engine expands. Anything else `$__`-shaped is a typo. */
export const RAW_SQL_MACROS = [
	"$__orgFilter",
	"$__timeFilter",
	"$__timeGroup",
	"$__startTime",
	"$__endTime",
	"$__interval_s",
] as const

const SUPPORTED_MACROS_HELP =
	"Supported: $__orgFilter, $__timeFilter(col), $__timeGroup(col), $__startTime, $__endTime, $__interval_s."

const issue = (code: RawSqlIssueCode, message: string): RawSqlIssue => ({ code, message })

/**
 * Every check `prepareRawSql` makes that does not need runtime values, in the
 * order it makes them. Returns `null` when the query is acceptable.
 *
 * Runs against the query as written, before macro expansion: the macros expand
 * to literals and comparisons, so they can introduce neither a statement
 * keyword nor a terminal clause, and checking the source text is what lets an
 * editor give the same answer as the server before a query is ever sent.
 */
export const rawSqlIssue = (
	sql: string,
	options: { readonly workload: RawSqlWorkload } = { workload: "interactive" },
): RawSqlIssue | null => {
	if (sql.length === 0 || sql.length > MAX_RAW_SQL_LENGTH) {
		return issue("ResourceLimit", `Raw SQL must contain between 1 and ${MAX_RAW_SQL_LENGTH} characters`)
	}

	// Masking is offset-preserving, so it is safe to compute once here and share
	// with the structural checks further down.
	//
	// The org filter is checked against the *masked* text on purpose: expansion is
	// textual, so a `$__orgFilter` written inside a comment expands to a predicate
	// that is still inside the comment — inert — while a raw `includes` reported
	// the requirement as met. That turned the mandatory tenant predicate into an
	// opt-out. The macro checks below stay on the raw text, which is the stricter
	// input: `prepareRawSql` expands macros wherever they appear, literals
	// included, so a macro hidden in a string still has to be a legal one.
	const maskedSql = maskLiteralsAndComments(sql)
	if (!maskedSql.includes("$__orgFilter")) {
		return issue(
			"MissingOrgFilter",
			sql.includes("$__orgFilter")
				? "$__orgFilter must appear in the query itself, not inside a comment or string literal."
				: "SQL must reference $__orgFilter so the query is scoped to your org.",
		)
	}
	// Masked, for the same reason as the org filter: an alert whose only
	// `$__timeFilter(` sits in a comment expands to nothing and then rescans all
	// of history on every evaluation, which is the cost the requirement exists to
	// prevent.
	if (options.workload === "alert" && !maskedSql.includes("$__timeFilter(")) {
		return issue(
			"InvalidMacro",
			sql.includes("$__timeFilter(")
				? "$__timeFilter(...) must appear in the query itself, not inside a comment or string literal."
				: "Raw SQL alerts must reference $__timeFilter(...) to bound alert reads.",
		)
	}

	for (const macro of ["$__timeFilter", "$__timeGroup"] as const) {
		const pattern = new RegExp(`\\${macro}\\(([^)]*)\\)`, "g")
		for (const match of sql.matchAll(pattern)) {
			const column = match[1].trim()
			if (!COLUMN_IDENT_RE.test(column)) {
				return issue(
					"InvalidMacro",
					`${macro} argument '${column}' must be a column identifier (letters, digits, underscores, dots).`,
				)
			}
		}
	}

	const unknownMacro = [...sql.matchAll(/\$__\w+/g)]
		.map((match) => match[0])
		.find((name) => !RAW_SQL_MACROS.includes(name as (typeof RAW_SQL_MACROS)[number]))
	if (unknownMacro !== undefined) {
		return issue("UnresolvedMacro", `Unknown macro ${unknownMacro}. ${SUPPORTED_MACROS_HELP}`)
	}

	// A single trailing terminator is one statement, not several — rejecting it as
	// "multiple statements" is a false error on the most common way to end a query.
	let masked = maskedSql
	const terminatorMatch = masked.match(/;\s*$/)
	if (terminatorMatch?.index !== undefined) masked = masked.slice(0, terminatorMatch.index)
	if (masked.includes(";")) {
		return issue("MultipleStatements", "Multiple SQL statements are not allowed. Remove ';' separators.")
	}

	const denyMatch = masked.match(DENY_LIST_RE)
	if (denyMatch) {
		return issue(
			"DisallowedStatement",
			`Statement keyword '${denyMatch[1].toUpperCase()}' is not allowed in raw SQL.`,
		)
	}
	if (INTO_OUTFILE_RE.test(masked)) {
		return issue(
			"DisallowedStatement",
			"INTO OUTFILE is not allowed in raw SQL — results are returned over the API.",
		)
	}
	if (!/^\s*(?:SELECT|WITH)\b/i.test(masked)) {
		return issue(
			"DisallowedStatement",
			"Raw SQL must be a SELECT query (WITH common table expressions are supported).",
		)
	}
	const functionMatch = masked.match(DISALLOWED_FUNCTION_RE)
	if (functionMatch) {
		return issue(
			"DisallowedFunction",
			`Table function '${functionMatch[1]}' is not allowed in raw SQL — queries may only read Maple's own tables.`,
		)
	}
	// The row cap nests the query, and `SETTINGS` is a statement terminator, so an
	// author-supplied one would end up inside the subquery — where ClickHouse
	// propagates it to the whole query context and it silently outranks the cost
	// profile's time and memory budget. A trailing FORMAT is dropped rather than
	// rejected (the driver owns the wire format); see `prepareRawSql`.
	if (splitTerminalClauses(sql).settings !== undefined) {
		return issue(
			"DisallowedStatement",
			"SETTINGS is managed by Maple — raw queries run under a fixed time and memory budget. Remove the SETTINGS clause.",
		)
	}
	return null
}

/** `rawSqlIssue` as a predicate, for editors that only need a yes/no. */
export const isValidRawSql = (sql: string, workload: RawSqlWorkload = "interactive"): boolean =>
	rawSqlIssue(sql, { workload }) === null

/**
 * Raw SQL as a schema, so a boundary that stores user SQL rejects it on the way
 * in rather than when someone renders it. The filter surfaces `rawSqlIssue`'s
 * own message, so a schema rejection reads the same as an execution one.
 *
 * Deliberately not applied to `RawSqlExecuteRequest` or the alert-rule payloads:
 * those already run through `prepareRawSql`, which fails with a coded
 * `RawSqlValidationError`, and a schema rejection would replace that with a
 * generic decode error.
 */
export const RawSqlText = Schema.String.check(
	Schema.makeFilter((sql: string) => rawSqlIssue(sql)?.message ?? true, {
		description: "Maple raw ClickHouse SQL",
	}),
).annotate({
	title: "Raw SQL",
	description: `ClickHouse SELECT with Maple macros. Must reference $__orgFilter. ${SUPPORTED_MACROS_HELP}`,
})

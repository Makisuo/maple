// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import {
	WarehouseAuthError,
	WarehouseClientError,
	WarehouseConfigError,
	WarehouseInvalidSqlError,
	WarehouseMalformedQueryError,
	WarehouseQueryError,
	WarehouseQuotaExceededError,
	WarehouseSchemaDriftError,
	WarehouseUpstreamError,
	type WarehouseClassifiedError as DomainWarehouseClassifiedError,
	type WarehouseReadError,
	type WarehouseSettingsRouteError,
	type WarehouseTokenRouteError,
} from "@maple/domain/http"
import { detectQuotaSetting } from "../profiles"

const redactWarehouseCredentials = (message: string): string =>
	message
		.replace(/(Invalid token\s+b?)(['"])[\s\S]*?\2/gi, "$1$2[redacted]$2")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")

/** Strip credentials, HTML error pages and whitespace noise before exposing an upstream failure. */
export const cleanErrorMessage = (raw: string): string => {
	const redacted = redactWarehouseCredentials(raw)
	let cleaned = redacted
	const htmlIndex = cleaned.search(/<\s*(html|head|body|center|h1|hr|title)\b/i)
	if (htmlIndex >= 0) cleaned = cleaned.slice(0, htmlIndex)
	cleaned = cleaned
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
	if (cleaned.endsWith(":")) cleaned = cleaned.slice(0, -1).trim()
	return cleaned || redacted.slice(0, 200)
}

const extractUpstreamStatus = (message: string): number | undefined => {
	const match = message.match(/(?:status|HTTP status|response status code)[:\s]+(\d{3})/i)
	if (match) return Number(match[1])
	const titleMatch = message.match(/\b(\d{3})\s+(?:error|service temporarily unavailable)\b/i)
	if (titleMatch) return Number(titleMatch[1])
	return undefined
}

/**
 * Every warehouse error `mapWarehouseError` can produce. Precondition and row
 * decode failures are raised elsewhere in the executor, so they are absent.
 */
export type WarehouseClassifiedError = DomainWarehouseClassifiedError

/** Failures while resolving settings or executing an ordinary read. */
export type WarehouseReadExecutionError = WarehouseClassifiedError | WarehouseSettingsRouteError

/** Raw SQL adds org-token failures to the normal read execution set. */
export type WarehouseExecutionError = WarehouseReadExecutionError | WarehouseTokenRouteError

/** SQL execution plus the result-schema failure unique to compiled queries. */
export type WarehouseCompiledQueryError = WarehouseReadError

type ClickHouseErrorDetails = {
	readonly message: string
	readonly code?: string
	readonly type?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

const optionalString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined

const unknownToMessage = (error: unknown, fallback = "ClickHouse query failed"): string => {
	if (typeof error === "string") return error
	if (error instanceof Error) return error.message
	if (isRecord(error) && typeof error.message === "string") return error.message
	return fallback
}

const getClickHouseErrorDetails = (error: unknown): ClickHouseErrorDetails => {
	const message = unknownToMessage(error)
	if (!isRecord(error)) return { message }
	return {
		message,
		code: optionalString(error.code),
		type: typeof error.type === "string" ? error.type : undefined,
	}
}

/** Fields shared by every warehouse error, built once per classification. */
type ClassifiedBase = {
	readonly pipeName: string
	readonly message: string
	readonly cause: unknown
	readonly clickhouseCode: string | undefined
	readonly clickhouseType: string | undefined
}

/**
 * Who wrote the SQL that failed. The same ClickHouse error means different
 * things depending on the answer: a type mismatch in SQL Maple generated is our
 * bug, the identical message from the raw-SQL widget or the `run_sql` MCP tool
 * is the author's typo and they need to see the database's own explanation.
 */
export type SqlAuthorship = "maple" | "caller"

type ClassificationRule = {
	readonly status?: (status: number) => boolean
	readonly types?: ReadonlySet<string>
	readonly pattern?: RegExp
	readonly extra?: (error: unknown) => boolean
	/** Restricts the rule to SQL with this authorship. Unset means either. */
	readonly authoredBy?: SqlAuthorship
	/** Construct the tagged error for this rule. `upstreamStatus` is only used by the rules that carry it. */
	readonly make: (base: ClassifiedBase, upstreamStatus: number | undefined) => WarehouseClassifiedError
}

// Ordered rules — first match wins. A raw error can satisfy several patterns
// (e.g. a 503 carrying an HTML body, or schema-drift text inside a transient
// failure), so the order encodes precedence:
// auth > upstream > config > client > schema_drift > (default) query.
const CLASSIFICATION_RULES: ReadonlyArray<ClassificationRule> = [
	{
		status: (s) => s === 401 || s === 403,
		types: new Set(["AUTHENTICATION_FAILED", "ACCESS_DENIED", "USER_DOESNT_EXIST", "REQUIRED_PASSWORD"]),
		pattern:
			/authentication failed|access denied|not enough privileges|password is incorrect|invalid authentication token/i,
		make: (base, upstreamStatus) => new WarehouseAuthError({ ...base, upstreamStatus }),
	},
	{
		status: (s) => s === 408 || s === 429 || (s >= 500 && s < 600),
		types: new Set([
			"NETWORK_ERROR",
			"SOCKET_TIMEOUT",
			"TOO_MANY_SIMULTANEOUS_QUERIES",
			"SERVER_OVERLOADED",
			"CANNOT_SCHEDULE_TASK",
			"KEEPER_EXCEPTION",
			"ALL_CONNECTION_TRIES_FAILED",
		]),
		// First alternative is anchored (exact "Timeout error"); the rest match anywhere.
		pattern:
			/^Timeout error\.?$|The user aborted a request|Failed to fetch|fetch failed|NetworkError|Load failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|certificate/i,
		make: (base, upstreamStatus) => new WarehouseUpstreamError({ ...base, upstreamStatus }),
	},
	{
		// A table the CALLER named that does not exist — `run_sql`, the raw_sql
		// widget, `maple query`. The config rule below reads the identical
		// complaint as "Maple is pointed at the wrong database", which told a user
		// who mistyped `FROM spans` that their warehouse was misconfigured. Same
		// caller-before-maple ordering as the malformed-query twin further down.
		//
		// Deliberately no `status` matcher: a bare 404 says nothing about whether a
		// table was named, so `Invalid URL`, `UNKNOWN_SETTING` and Tinybird's
		// "Resource '<name>' not found" (a missing datasource, genuinely config)
		// stay with the rule below.
		authoredBy: "caller",
		types: new Set(["UNKNOWN_DATABASE", "UNKNOWN_TABLE", "TABLE_IS_DROPPED"]),
		pattern: /unknown table|table .* does not exist|database .* does not exist/i,
		make: (base) => new WarehouseInvalidSqlError(base),
	},
	{
		status: (s) => s === 404,
		types: new Set(["UNKNOWN_DATABASE", "UNKNOWN_TABLE", "TABLE_IS_DROPPED", "UNKNOWN_SETTING"]),
		// "Resource '<name>' not found" is the Tinybird gateway's phrasing of
		// UNKNOWN_TABLE; without it a missing datasource fell through to the
		// generic query error and the per-org missing-table fallbacks never fired.
		pattern:
			/Invalid URL|unknown database|unknown table|table .* does not exist|database .* does not exist|Resource '[^']*' not found/i,
		make: (base) => new WarehouseConfigError(base),
	},
	{
		pattern:
			/Cannot decode .* as JSON|Unexpected token .* JSON|Stream has been already consumed|Failed to parse ClickHouse response/i,
		extra: (error) => error instanceof SyntaxError,
		make: (base) => new WarehouseClientError(base),
	},
	{
		// The same analyzer complaints as the Maple-authored rule below, but about
		// SQL the CALLER wrote. Without this twin a plain typo in a raw_sql widget
		// or `run_sql` — a stray comma, a function called with two arguments — fell
		// past every authorship-guarded rule to the default `WarehouseQueryError`:
		// a 502 reading "Database query failed. Contact support" that hid the one
		// thing the author needed, which was ClickHouse's own explanation.
		authoredBy: "caller",
		types: new Set([
			"NO_COMMON_TYPE",
			"ILLEGAL_TYPE_OF_ARGUMENT",
			"ILLEGAL_AGGREGATION",
			"NUMBER_OF_ARGUMENTS_DOESNT_MATCH",
			"TYPE_MISMATCH",
			"SYNTAX_ERROR",
			"UNKNOWN_FUNCTION",
			"AMBIGUOUS_COLUMN_NAME",
		]),
		pattern:
			/There is no supertype|Illegal type .* of argument|Number of arguments doesn't match|Syntax error/i,
		make: (base) => new WarehouseInvalidSqlError(base),
	},
	{
		// The analyzer refused SQL that Maple itself generated: mismatched `if()`
		// arms or UNION branches (NO_COMMON_TYPE), a function applied to the wrong
		// type, the wrong argument count. These are Maple bugs — identical for
		// every org, on every cluster, unaffected by retry or by schema apply — so
		// they get their own tag to be alertable and to keep the UI from blaming
		// the customer's database. Ordered before the schema-drift rule, which is
		// the same shape of complaint but a customer-side cause.
		//
		// `authoredBy: "maple"` is what makes the type list safe. Every error here
		// is also an ordinary hand-written-SQL mistake — comparing a String to a
		// number, calling a function with two arguments instead of three — and the
		// raw_sql widget and `run_sql` MCP tool run caller-authored SQL through
		// this same classifier. Blaming ourselves for those would swallow the
		// database's explanation and page on-call for someone else's typo.
		authoredBy: "maple",
		types: new Set([
			"NO_COMMON_TYPE",
			"ILLEGAL_TYPE_OF_ARGUMENT",
			"ILLEGAL_AGGREGATION",
			"NUMBER_OF_ARGUMENTS_DOESNT_MATCH",
			"TYPE_MISMATCH",
			"SYNTAX_ERROR",
			"UNKNOWN_FUNCTION",
			"AMBIGUOUS_COLUMN_NAME",
		]),
		pattern:
			/There is no supertype|Illegal type .* of argument|Number of arguments doesn't match|Syntax error/i,
		make: (base) => new WarehouseMalformedQueryError(base),
	},
	{
		// The same complaint as the schema-drift rule below, but about SQL the CALLER
		// wrote — the `run_sql` MCP tool and the raw_sql widget. A bad table alias
		// (`t.OrgId`) or a column the author invented is a mistake in that query, not
		// evidence that the cluster's schema is behind.
		//
		// This rule exists because the drift rule below had no authorship guard, so
		// agent typos came back to customers as "your ClickHouse cluster's schema is
		// out of sync — run schema apply". Ordered first so the caller case is claimed
		// before the Maple-authored one can match it.
		authoredBy: "caller",
		types: new Set([
			"UNKNOWN_IDENTIFIER",
			"NO_SUCH_COLUMN_IN_TABLE",
			"THERE_IS_NO_COLUMN",
			"NOT_FOUND_COLUMN_IN_BLOCK",
		]),
		pattern:
			/Unknown (?:expression or function )?identifier|Missing columns|There is no column|No such column/i,
		make: (base) => new WarehouseInvalidSqlError(base),
	},
	{
		// CH error types raised when a column or function reference doesn't exist in
		// the cluster's schema. For BYO-ClickHouse customers this is almost always
		// schema drift between Maple's expected schema and what the cluster has —
		// resolved by running schema apply, not by retrying. Surfacing it as a
		// distinct error lets the MCP layer return an actionable message.
		//
		// `authoredBy: "maple"` is load-bearing for the same reason it is on the
		// malformed-query rule above: only a query WE generated can testify about the
		// cluster's schema. See the caller-authored twin directly above.
		authoredBy: "maple",
		types: new Set([
			"UNKNOWN_IDENTIFIER",
			"NO_SUCH_COLUMN_IN_TABLE",
			"THERE_IS_NO_COLUMN",
			"NOT_FOUND_COLUMN_IN_BLOCK",
		]),
		pattern:
			/Unknown (?:expression or function )?identifier|Missing columns|There is no column|No such column/i,
		make: (base) => new WarehouseSchemaDriftError(base),
	},
]

export const toWarehouseQueryError = (pipe: string, error: unknown) => {
	const rawMessage = unknownToMessage(error, "Warehouse query failed")
	const redacted = redactWarehouseCredentials(rawMessage)
	return new WarehouseQueryError({
		message: cleanErrorMessage(redacted),
		pipeName: pipe,
		cause: redacted === rawMessage ? error : redacted,
	})
}

/**
 * Classify a warehouse failure into a tagged error.
 *
 * `authoredBy` defaults to `"caller"`: the conservative reading. A wrong
 * "this is a bug in Maple" is worse than a generic message, so a call site has
 * to opt in by declaring the SQL was machine-generated.
 */
export const mapWarehouseError = (
	pipe: string,
	error: unknown,
	authoredBy: SqlAuthorship = "caller",
): WarehouseClassifiedError => {
	const { message: rawMessage, code, type } = getClickHouseErrorDetails(error)
	const redacted = redactWarehouseCredentials(rawMessage)
	const message = cleanErrorMessage(rawMessage)
	const base: ClassifiedBase = {
		pipeName: pipe,
		message,
		// Tinybird can echo the rejected JWT. Keeping the original cause would
		// leak it through Effect's cause/stack rendering even with a clean message.
		cause: redacted === rawMessage ? error : redacted,
		clickhouseCode: code,
		clickhouseType: type,
	}

	const setting = detectQuotaSetting(rawMessage, code, type)
	if (setting) {
		return new WarehouseQuotaExceededError({ ...base, setting })
	}

	const upstreamStatus = extractUpstreamStatus(rawMessage)
	for (const rule of CLASSIFICATION_RULES) {
		if (rule.authoredBy !== undefined && rule.authoredBy !== authoredBy) continue
		const matches =
			(rule.status !== undefined && upstreamStatus !== undefined && rule.status(upstreamStatus)) ||
			(rule.types !== undefined && type !== undefined && rule.types.has(type)) ||
			(rule.pattern !== undefined && rule.pattern.test(rawMessage)) ||
			(rule.extra !== undefined && rule.extra(error))
		if (matches) return rule.make(base, upstreamStatus)
	}
	return new WarehouseQueryError(base)
}

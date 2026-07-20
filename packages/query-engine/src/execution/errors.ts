import {
	WarehouseAuthError,
	WarehouseClientError,
	WarehouseConfigError,
	WarehouseQueryError,
	WarehouseQuotaExceededError,
	WarehouseSchemaDriftError,
	WarehouseUpstreamError,
} from "@maple/domain/http"
import { detectQuotaSetting } from "../profiles"

/**
 * Every warehouse error `mapWarehouseError` can produce. Precondition failures
 * (`WarehouseValidationError`) are raised by the executor before a query runs,
 * not by this classifier, so they're intentionally absent here.
 */
export type WarehouseSqlError =
	| WarehouseQueryError
	| WarehouseUpstreamError
	| WarehouseAuthError
	| WarehouseConfigError
	| WarehouseClientError
	| WarehouseSchemaDriftError
	| WarehouseQuotaExceededError

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

export const cleanErrorMessage = (raw: string): string => {
	let cleaned = raw
	const htmlIndex = cleaned.search(/<\s*(html|head|body|center|h1|hr|title)\b/i)
	if (htmlIndex >= 0) cleaned = cleaned.slice(0, htmlIndex)
	cleaned = cleaned
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
	if (cleaned.endsWith(":")) cleaned = cleaned.slice(0, -1).trim()
	return cleaned || raw.slice(0, 200)
}

const extractUpstreamStatus = (message: string): number | undefined => {
	const match = message.match(/(?:status|HTTP status|response status code)[:\s]+(\d{3})/i)
	if (match) return Number(match[1])
	const titleMatch = message.match(/\b(\d{3})\s+(?:error|service temporarily unavailable)\b/i)
	if (titleMatch) return Number(titleMatch[1])
	return undefined
}

/** Fields shared by every warehouse error, built once per classification. */
type ClassifiedBase = {
	readonly pipeName: string
	readonly message: string
	readonly cause: unknown
	readonly clickhouseCode: string | undefined
	readonly clickhouseType: string | undefined
}

type ClassificationRule = {
	readonly status?: (status: number) => boolean
	readonly types?: ReadonlySet<string>
	readonly pattern?: RegExp
	readonly extra?: (error: unknown) => boolean
	/** Construct the tagged error for this rule. `upstreamStatus` is only used by the rules that carry it. */
	readonly make: (base: ClassifiedBase, upstreamStatus: number | undefined) => WarehouseSqlError
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
		status: (s) => s === 404,
		types: new Set(["UNKNOWN_DATABASE", "UNKNOWN_TABLE", "TABLE_IS_DROPPED", "UNKNOWN_SETTING"]),
		pattern:
			/Invalid URL|unknown database|unknown table|table .* does not exist|database .* does not exist/i,
		make: (base) => new WarehouseConfigError(base),
	},
	{
		pattern:
			/Cannot decode .* as JSON|Unexpected token .* JSON|Stream has been already consumed|Failed to parse ClickHouse response/i,
		extra: (error) => error instanceof SyntaxError,
		make: (base) => new WarehouseClientError(base),
	},
	{
		// CH error types raised when a column or function reference doesn't exist in
		// the cluster's schema. For BYO-ClickHouse customers this is almost always
		// schema drift between Maple's expected schema and what the cluster has —
		// resolved by running schema apply, not by retrying. Surfacing it as a
		// distinct error lets the MCP layer return an actionable message.
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

export const toWarehouseQueryError = (pipe: string, error: unknown) =>
	new WarehouseQueryError({
		message: cleanErrorMessage(unknownToMessage(error, "Warehouse query failed")),
		pipeName: pipe,
		cause: error,
	})

export const mapWarehouseError = (pipe: string, error: unknown): WarehouseSqlError => {
	const { message: rawMessage, code, type } = getClickHouseErrorDetails(error)
	const message = cleanErrorMessage(rawMessage)
	const base: ClassifiedBase = {
		pipeName: pipe,
		message,
		cause: error,
		clickhouseCode: code,
		clickhouseType: type,
	}

	const setting = detectQuotaSetting(rawMessage, code, type)
	if (setting) {
		return new WarehouseQuotaExceededError({ ...base, setting })
	}

	const upstreamStatus = extractUpstreamStatus(rawMessage)
	for (const rule of CLASSIFICATION_RULES) {
		const matches =
			(rule.status !== undefined && upstreamStatus !== undefined && rule.status(upstreamStatus)) ||
			(rule.types !== undefined && type !== undefined && rule.types.has(type)) ||
			(rule.pattern !== undefined && rule.pattern.test(rawMessage)) ||
			(rule.extra !== undefined && rule.extra(error))
		if (matches) return rule.make(base, upstreamStatus)
	}
	return new WarehouseQueryError(base)
}

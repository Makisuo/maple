import { Cause, Exit, Option } from "effect"
import { HttpClientError } from "effect/unstable/http"
import {
	cleanErrorMessage,
	isWarehouseErrorTag,
	presentWarehouseError,
	presentWarehouseErrorPublic,
	warehouseErrorMeta,
	type WarehouseErrorLike,
} from "@maple/domain"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { isChunkLoadError } from "./chunk-reload"

export type ErrorCategory =
	| "validation"
	| "authentication"
	| "permission"
	| "not-found"
	| "conflict"
	| "rate-limit"
	| "network"
	| "timeout"
	| "upstream"
	| "server"
	| "client"

export type ErrorRecovery =
	| { readonly kind: "none" }
	| { readonly kind: "retry"; readonly automatic: boolean }
	| { readonly kind: "reauth" }
	| { readonly kind: "fix-input"; readonly param?: string }
	| { readonly kind: "reload" }

export interface ErrorDiagnostics {
	/** Raw telemetry-only value; never render. */
	readonly value: unknown
	readonly tag?: string
	readonly technicalMessage?: string
}

export interface NormalizedAppError {
	readonly category: ErrorCategory
	readonly code?: string
	readonly status?: number
	readonly param?: string
	readonly docUrl?: string
	readonly recovery: ErrorRecovery
	readonly title: string
	readonly description: string
	readonly recognized: boolean
	readonly diagnostics: ErrorDiagnostics
}

export interface FormattedError {
	readonly title: string
	readonly description: string
	readonly category: ErrorCategory
	readonly code?: string
	readonly status?: number
	readonly param?: string
	readonly docUrl?: string
	readonly recovery: ErrorRecovery
	readonly recognized: boolean
	/** Compatibility signal for callers not yet using `recovery`. */
	readonly kind?: "network"
}

const hasTag = (value: unknown): value is { _tag: string; [key: string]: unknown } =>
	typeof value === "object" &&
	value !== null &&
	"_tag" in value &&
	typeof (value as { _tag: unknown })._tag === "string"

const rawStringField = (value: unknown, key: string): string | undefined => {
	if (typeof value === "object" && value !== null && key in value) {
		const field = (value as Record<string, unknown>)[key]
		if (typeof field === "string") return field
	}
	return undefined
}

const stringField = (value: unknown, key: string): string | undefined => {
	const field = rawStringField(value, key)
	return field === undefined ? undefined : cleanErrorMessage(field)
}

const stringArrayField = (value: unknown, key: string): ReadonlyArray<string> | undefined => {
	if (typeof value === "object" && value !== null && key in value) {
		const field = (value as Record<string, unknown>)[key]
		if (Array.isArray(field)) return field.filter((item): item is string => typeof item === "string")
	}
	return undefined
}

const unwrap = (error: unknown): unknown => {
	if (Cause.isCause(error)) {
		return Option.getOrElse(Cause.findErrorOption(error), () => error)
	}
	if (Exit.isExit(error)) {
		return Option.getOrElse(Exit.findErrorOption(error), () => error)
	}
	return error
}

export interface V2ErrorInfo {
	readonly type: string
	readonly code: string
	readonly message: string
	readonly param?: string
	readonly docUrl?: string
}

export const v2ErrorInfo = (input: unknown): V2ErrorInfo | null => {
	const error = unwrap(input)
	if (typeof error !== "object" || error === null || !("error" in error)) return null
	const body = (error as { error: unknown }).error
	const type = stringField(body, "type")
	const code = stringField(body, "code")
	const message = stringField(body, "message")
	if (type === undefined || code === undefined || message === undefined) return null
	const param = stringField(body, "param")
	const docUrl = stringField(body, "doc_url")
	return {
		type,
		code,
		message,
		...(param === undefined ? {} : { param }),
		...(docUrl === undefined ? {} : { docUrl }),
	}
}

// A preceding "at " is swallowed because the replacement supplies its own
// preposition: "Resets at 2026-08-10T00:00:00.000Z" becomes "Resets in 7h".
const ISO_INSTANT = /(?:\bat )?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/g

export const humanizeInstants = (message: string, nowMs: number = Date.now()): string =>
	message.replace(ISO_INSTANT, (match, iso: string) => {
		const epochMs = Date.parse(iso)
		return Number.isFinite(epochMs) ? formatRelativeFrom(epochMs, nowMs) : match
	})

const V2_TYPE_META: Record<
	string,
	{ readonly title: string; readonly category: ErrorCategory; readonly status: number }
> = {
	invalid_request_error: { title: "Invalid request", category: "validation", status: 400 },
	authentication_error: { title: "Sign in required", category: "authentication", status: 401 },
	permission_error: { title: "Permission required", category: "permission", status: 403 },
	not_found_error: { title: "Not found", category: "not-found", status: 404 },
	conflict_error: { title: "Could not save changes", category: "conflict", status: 409 },
	rate_limit_error: { title: "Too many requests", category: "rate-limit", status: 429 },
	api_error: { title: "Maple is temporarily unavailable", category: "server", status: 500 },
}

const V2_CODE_TITLES: Record<string, string> = {
	investigation_daily_quota: "Investigation limit reached",
	range_too_large: "Requested range is too large",
	dashboard_concurrent_update: "Dashboard changed elsewhere",
	service_unavailable: "Maple is temporarily unavailable",
	upstream_error: "Connected service is unavailable",
}

const recoveryFor = (category: ErrorCategory, param?: string): ErrorRecovery => {
	switch (category) {
		case "validation":
			return { kind: "fix-input", ...(param === undefined ? {} : { param }) }
		case "authentication":
			return { kind: "reauth" }
		case "conflict":
		case "rate-limit":
		case "upstream":
		case "server":
		case "timeout":
			return { kind: "retry", automatic: false }
		case "network":
			return { kind: "retry", automatic: true }
		default:
			return { kind: "none" }
	}
}

interface NormalizedFields {
	readonly category: ErrorCategory
	readonly title: string
	readonly description: string
	readonly code?: string
	readonly status?: number
	readonly param?: string
	readonly docUrl?: string
	readonly recovery?: ErrorRecovery
	readonly recognized?: boolean
	readonly tag?: string
	readonly technicalMessage?: string
}

const normalized = (value: unknown, fields: NormalizedFields): NormalizedAppError => ({
	category: fields.category,
	title: fields.title,
	description: humanizeInstants(fields.description),
	recovery: fields.recovery ?? recoveryFor(fields.category, fields.param),
	recognized: fields.recognized ?? true,
	...(fields.code === undefined ? {} : { code: fields.code }),
	...(fields.status === undefined ? {} : { status: fields.status }),
	...(fields.param === undefined ? {} : { param: fields.param }),
	...(fields.docUrl === undefined ? {} : { docUrl: fields.docUrl }),
	diagnostics: {
		value,
		...(fields.tag === undefined ? {} : { tag: fields.tag }),
		...(fields.technicalMessage === undefined ? {} : { technicalMessage: fields.technicalMessage }),
	},
})

const normalizeV2 = (value: unknown, v2: V2ErrorInfo): NormalizedAppError => {
	const meta = V2_TYPE_META[v2.type] ?? {
		title: "Something went wrong",
		category: "server" as const,
		status: 500,
	}
	const category =
		v2.type === "api_error" && (v2.code.includes("upstream") || v2.code.endsWith("_unavailable"))
			? "upstream"
			: meta.category
	return normalized(value, {
		category,
		title: V2_CODE_TITLES[v2.code] ?? meta.title,
		description: v2.message,
		code: v2.code,
		status: meta.status,
		...(v2.param === undefined ? {} : { param: v2.param }),
		...(v2.docUrl === undefined ? {} : { docUrl: v2.docUrl }),
	})
}

const warehouseCategory = (tag: WarehouseErrorLike["_tag"]): ErrorCategory => {
	switch (tag) {
		case "@maple/http/errors/WarehouseValidationError":
		case "@maple/http/errors/WarehouseConfigError":
			return "validation"
		case "@maple/http/errors/WarehouseQuotaExceededError":
			return "rate-limit"
		case "@maple/http/errors/WarehouseAuthError":
			return "authentication"
		case "@maple/http/errors/WarehouseUpstreamError":
		case "@maple/http/errors/WarehouseQueryError":
		case "@maple/http/errors/WarehouseClientError":
			return "upstream"
		default:
			return "server"
	}
}

const normalizeWarehouse = (
	value: { _tag: string; [key: string]: unknown },
	tag: WarehouseErrorLike["_tag"],
): NormalizedAppError => {
	const like: WarehouseErrorLike = {
		_tag: tag,
		...(typeof value.message === "string" ? { message: value.message } : {}),
		...(typeof value.setting === "string" ? { setting: value.setting } : {}),
		...(typeof value.upstreamStatus === "number" ? { upstreamStatus: value.upstreamStatus } : {}),
		...(typeof value.kind === "string" ? { kind: value.kind } : {}),
	}
	const withDetails = presentWarehouseError(like)
	const withoutDetails = presentWarehouseErrorPublic(like)
	// Validation copy is authored by Maple and directly helps the user. A generic
	// query error may also be reclassified from an embedded status into safe,
	// Maple-authored outage copy. Everything else drops driver/SQL/decoder text.
	const presentation =
		tag === "@maple/http/errors/WarehouseValidationError" ||
		withDetails.title !== warehouseErrorMeta[tag].title
			? withDetails
			: withoutDetails
	const category =
		withDetails.title === warehouseErrorMeta["@maple/http/errors/WarehouseUpstreamError"].title
			? "upstream"
			: warehouseCategory(tag)
	return normalized(value, {
		category,
		code: warehouseErrorMeta[tag].code,
		title: presentation.title,
		description: presentation.description,
		tag,
		technicalMessage: rawStringField(value, "message"),
	})
}

const isTimeoutCause = (cause: unknown): boolean =>
	(typeof DOMException !== "undefined" &&
		cause instanceof DOMException &&
		(cause.name === "TimeoutError" || cause.name === "AbortError")) ||
	(typeof cause === "object" &&
		cause !== null &&
		"name" in cause &&
		((cause as { name?: unknown }).name === "TimeoutError" ||
			(cause as { name?: unknown }).name === "AbortError"))

const normalizeHttpClientError = (value: HttpClientError.HttpClientError): NormalizedAppError => {
	const status = value.response?.status
	if (status === 401) {
		return normalized(value, {
			category: "authentication",
			status,
			title: "Sign in required",
			description: "Your session may have expired. Sign in again to continue.",
			technicalMessage: value.message,
		})
	}
	if (status === 403) {
		return normalized(value, {
			category: "permission",
			status,
			title: "Permission required",
			description: "You do not have permission to perform this action.",
			technicalMessage: value.message,
		})
	}
	if (status === 429) {
		return normalized(value, {
			category: "rate-limit",
			status,
			title: "Too many requests",
			description: "Wait a moment, then try again.",
			technicalMessage: value.message,
		})
	}
	if (status === 504) {
		return normalized(value, {
			category: "timeout",
			status,
			title: "Request timed out",
			description: "The request took too long. Narrow the time range or add filters, then try again.",
			technicalMessage: value.message,
		})
	}
	if (value.reason._tag === "TransportError") {
		if (isTimeoutCause(value.reason.cause)) {
			return normalized(value, {
				category: "timeout",
				title: "Request timed out",
				description: "The API did not respond in time. Try again when you're ready.",
				technicalMessage: value.message,
			})
		}
		return normalized(value, {
			category: "network",
			title: "Cannot reach Maple API",
			description: "Check your connection. Data will resume once the API is reachable.",
			technicalMessage: value.message,
		})
	}
	if (value.reason._tag === "InvalidUrlError") {
		return normalized(value, {
			category: "client",
			title: "This request could not be sent",
			description: "Reload Maple. If the problem continues, contact support.",
			recovery: { kind: "reload" },
			technicalMessage: value.message,
		})
	}
	if (status !== undefined && status >= 500) {
		return normalized(value, {
			category: "server",
			status,
			title: "Maple is temporarily unavailable",
			description: "The API could not complete the request. Try again in a moment.",
			technicalMessage: value.message,
		})
	}
	return normalized(value, {
		category: "client",
		...(status === undefined ? {} : { status }),
		title: "The request failed",
		description: "Maple could not complete this request.",
		technicalMessage: value.message,
	})
}

const normalizeTaggedError = (value: { _tag: string; [key: string]: unknown }): NormalizedAppError | null => {
	const tag = value._tag
	const technicalMessage = rawStringField(value, "message")
	const safeMessage = stringField(value, "message")
	if (tag === "@maple/http/errors/QueryEngineTimeoutError") {
		return normalized(value, {
			category: "timeout",
			title: "Query timed out",
			description: "The query took longer than 30 seconds. Narrow the time range or add filters.",
			tag,
			technicalMessage,
		})
	}
	if (tag === "@maple/http/errors/QueryEngineValidationError") {
		const message = safeMessage ?? "Invalid query parameters"
		const details = stringArrayField(value, "details") ?? []
		return normalized(value, {
			category: "validation",
			title: message,
			description: details.length > 0 ? details.join("; ") : message,
			tag,
			technicalMessage,
		})
	}
	if (tag === "@maple/http/errors/QueryEngineExecutionError") {
		return normalized(value, {
			category: "server",
			title: "Query failed",
			description: "Maple could not run this query. Try again or adjust the query if it keeps failing.",
			tag,
			technicalMessage: rawStringField(value, "causeMessage") ?? technicalMessage,
		})
	}
	if (tag.endsWith("/UnauthorizedError") || /AuthenticationError$/.test(tag)) {
		return normalized(value, {
			category: "authentication",
			title: "Sign in required",
			description: "Your session may have expired. Sign in again to continue.",
			tag,
			technicalMessage,
		})
	}
	if (/PermissionError$|ForbiddenError$/.test(tag)) {
		return normalized(value, {
			category: "permission",
			title: "Permission required",
			description: safeMessage ?? "You do not have permission to perform this action.",
			tag,
			technicalMessage,
		})
	}
	if (/ValidationError$|InvalidRequestError$|InvalidInputError$/.test(tag)) {
		return normalized(value, {
			category: "validation",
			title: "Check the entered values",
			description: safeMessage ?? "One or more values are invalid.",
			tag,
			technicalMessage,
		})
	}
	if (/NotFoundError$/.test(tag)) {
		return normalized(value, {
			category: "not-found",
			title: "Not found",
			description: safeMessage ?? "That item no longer exists or you cannot access it.",
			tag,
			technicalMessage,
		})
	}
	if (/ConflictError$|ConcurrentUpdateError$|InUseError$/.test(tag)) {
		return normalized(value, {
			category: "conflict",
			title: "Could not save changes",
			description:
				safeMessage ?? "The item changed while you were editing it. Review it and try again.",
			tag,
			technicalMessage,
		})
	}
	if (/RateLimitError$|QuotaExceededError$/.test(tag)) {
		return normalized(value, {
			category: "rate-limit",
			title: "Limit reached",
			description: safeMessage ?? "Wait a moment, then try again.",
			tag,
			technicalMessage,
		})
	}
	return null
}

const nestedCause = (value: unknown): unknown => {
	if (typeof value !== "object" || value === null || !("cause" in value)) return undefined
	return (value as { cause?: unknown }).cause
}

const normalizeInternal = (input: unknown, depth: number): NormalizedAppError => {
	const value = unwrap(input)
	const v2 = v2ErrorInfo(value)
	if (v2 !== null) return normalizeV2(value, v2)

	if (hasTag(value) && isWarehouseErrorTag(value._tag)) return normalizeWarehouse(value, value._tag)
	if (hasTag(value)) {
		const tagged = normalizeTaggedError(value)
		if (tagged !== null) return tagged
	}

	if (HttpClientError.isHttpClientError(value)) return normalizeHttpClientError(value)

	if (isChunkLoadError(value)) {
		return normalized(value, {
			category: "client",
			title: "Maple was updated",
			description: "Reload to use the latest version.",
			recovery: { kind: "reload" },
			technicalMessage: value instanceof Error ? value.message : undefined,
		})
	}

	const cause = nestedCause(value)
	if (depth < 4 && cause !== undefined && cause !== value) {
		const nested = normalizeInternal(cause, depth + 1)
		if (nested.recognized) {
			return { ...nested, diagnostics: { ...nested.diagnostics, value } }
		}
	}

	if (value instanceof Error) {
		if (/transport error|failed to fetch|load failed|networkerror/i.test(value.message)) {
			return normalized(value, {
				category: "network",
				title: "Cannot reach Maple API",
				description: "Check your connection. Data will resume once the API is reachable.",
				technicalMessage: value.message,
			})
		}
		if (value.name === "TimeoutError" || /timed? out|timeout/i.test(value.message)) {
			return normalized(value, {
				category: "timeout",
				title: "Request timed out",
				description: "The request did not finish in time. Try again when you're ready.",
				technicalMessage: value.message,
			})
		}
		return normalized(value, {
			category: "client",
			title: "Something went wrong",
			description: "An unexpected error occurred. Try again, or reload if the problem continues.",
			recovery: { kind: "reload" },
			recognized: false,
			technicalMessage: value.message,
		})
	}

	return normalized(value, {
		category: "client",
		title: "Something went wrong",
		description: "An unexpected error occurred. Try again, or reload if the problem continues.",
		recovery: { kind: "reload" },
		recognized: false,
		technicalMessage: rawStringField(value, "message") ?? (typeof value === "string" ? value : undefined),
	})
}

export const normalizeAppError = (input: unknown): NormalizedAppError => normalizeInternal(input, 0)

export const presentAppError = (error: NormalizedAppError): FormattedError => ({
	title: error.title,
	description: error.description,
	category: error.category,
	recovery: error.recovery,
	recognized: error.recognized,
	...(error.code === undefined ? {} : { code: error.code }),
	...(error.status === undefined ? {} : { status: error.status }),
	...(error.param === undefined ? {} : { param: error.param }),
	...(error.docUrl === undefined ? {} : { docUrl: error.docUrl }),
	...(error.recovery.kind === "retry" && error.recovery.automatic ? { kind: "network" as const } : {}),
})

export const formatBackendError = (input: unknown): FormattedError =>
	presentAppError(normalizeAppError(input))

import { Cause, Exit, Option, Schema } from "effect"
import { HttpClientError } from "effect/unstable/http"
import {
	V2ErrorRecovery as V2ErrorRecoverySchema,
	V2ErrorType as V2ErrorTypeSchema,
	type V2ErrorRecovery,
	type V2ErrorType,
} from "@maple/domain/http/v2"
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
	| "server"
	| "client"

/** The backend's recovery vocabulary is also the UI's recovery vocabulary. */
export type ErrorRecovery = V2ErrorRecovery

export interface ErrorDiagnostics {
	/** Raw telemetry-only value; never render. */
	readonly value: unknown
	readonly tag?: string
	readonly technicalMessage?: string
}

export interface NormalizedAppError {
	readonly category: ErrorCategory
	readonly tag?: string
	readonly code?: string
	readonly status?: number
	readonly param?: string
	readonly docUrl?: string
	readonly retryAfterSeconds?: number
	readonly retryAt?: string
	readonly recovery: ErrorRecovery
	/** Only transport failures opt into connectivity-based automatic retries. */
	readonly automaticRetry: boolean
	readonly title: string
	readonly description: string
	readonly recognized: boolean
	readonly diagnostics: ErrorDiagnostics
}

export interface FormattedError {
	readonly title: string
	readonly description: string
	readonly category: ErrorCategory
	readonly tag?: string
	readonly code?: string
	readonly status?: number
	readonly param?: string
	readonly docUrl?: string
	readonly retryAfterSeconds?: number
	readonly retryAt?: string
	readonly recovery: ErrorRecovery
	readonly automaticRetry: boolean
	readonly recognized: boolean
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null

const hasTag = (value: unknown): value is { readonly _tag: string } => {
	const record = asRecord(value)
	return record !== null && typeof record._tag === "string"
}

const rawStringField = (value: unknown, key: string): string | undefined => {
	const record = asRecord(value)
	return record !== null && typeof record[key] === "string" ? record[key] : undefined
}

const unwrap = (error: unknown): unknown => {
	if (Cause.isCause(error)) return Option.getOrElse(Cause.findErrorOption(error), () => error)
	if (Exit.isExit(error)) return Option.getOrElse(Exit.findErrorOption(error), () => error)
	return error
}

export interface V2ErrorInfo {
	readonly tag: string
	readonly type: V2ErrorType
	readonly code: string
	readonly message: string
	readonly title: string
	readonly retryable: boolean
	readonly recovery: V2ErrorRecovery
	readonly retryAfterSeconds?: number
	readonly retryAt?: string
	readonly param?: string
	readonly docUrl?: string
}

const isV2ErrorType = Schema.is(V2ErrorTypeSchema)
const isV2ErrorRecovery = Schema.is(V2ErrorRecoverySchema)

/**
 * Read the one public error shape shared by decoded v2 responses and live
 * `HttpTaggedError` instances. Incomplete lookalikes are deliberately rejected:
 * presentation and recovery belong to the error contract, not this UI helper.
 */
export const v2ErrorInfo = (input: unknown): V2ErrorInfo | null => {
	const envelope = asRecord(unwrap(input))
	const body = envelope === null ? null : asRecord(envelope.error)
	if (body === null) return null

	const { _tag: tag, type, code, title, message, retryable, recovery } = body
	if (
		typeof tag !== "string" ||
		!tag.startsWith("@maple/") ||
		!isV2ErrorType(type) ||
		typeof code !== "string" ||
		typeof title !== "string" ||
		typeof message !== "string" ||
		typeof retryable !== "boolean" ||
		!isV2ErrorRecovery(recovery)
	) {
		return null
	}

	const retryAfterSeconds = body.retry_after_seconds
	if (
		retryAfterSeconds !== undefined &&
		(typeof retryAfterSeconds !== "number" ||
			!Number.isInteger(retryAfterSeconds) ||
			retryAfterSeconds <= 0)
	) {
		return null
	}
	const retryAt = body.retry_at
	if (retryAt !== undefined && (typeof retryAt !== "string" || !Number.isFinite(Date.parse(retryAt)))) {
		return null
	}
	const param = body.param
	if (param !== undefined && typeof param !== "string") return null
	const docUrl = body.doc_url
	if (docUrl !== undefined && typeof docUrl !== "string") return null

	return {
		tag,
		type,
		code,
		title,
		message,
		retryable,
		recovery,
		...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
		...(retryAt === undefined ? {} : { retryAt }),
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

interface NormalizedFields {
	readonly category: ErrorCategory
	readonly title: string
	readonly description: string
	readonly recovery: ErrorRecovery
	readonly automaticRetry?: boolean
	readonly code?: string
	readonly status?: number
	readonly param?: string
	readonly docUrl?: string
	readonly retryAfterSeconds?: number
	readonly retryAt?: string
	readonly recognized?: boolean
	readonly tag?: string
	readonly technicalMessage?: string
}

const normalized = (value: unknown, fields: NormalizedFields): NormalizedAppError => ({
	category: fields.category,
	title: fields.title,
	description: humanizeInstants(fields.description),
	recovery: fields.recovery,
	automaticRetry: fields.automaticRetry ?? false,
	recognized: fields.recognized ?? true,
	...(fields.tag === undefined ? {} : { tag: fields.tag }),
	...(fields.code === undefined ? {} : { code: fields.code }),
	...(fields.status === undefined ? {} : { status: fields.status }),
	...(fields.param === undefined ? {} : { param: fields.param }),
	...(fields.docUrl === undefined ? {} : { docUrl: fields.docUrl }),
	...(fields.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: fields.retryAfterSeconds }),
	...(fields.retryAt === undefined ? {} : { retryAt: fields.retryAt }),
	diagnostics: {
		value,
		...(fields.tag === undefined ? {} : { tag: fields.tag }),
		...(fields.technicalMessage === undefined ? {} : { technicalMessage: fields.technicalMessage }),
	},
})

const categoryForV2Type = (type: V2ErrorType): ErrorCategory => {
	switch (type) {
		case "invalid_request_error":
			return "validation"
		case "authentication_error":
			return "authentication"
		case "permission_error":
			return "permission"
		case "not_found_error":
			return "not-found"
		case "conflict_error":
			return "conflict"
		case "rate_limit_error":
			return "rate-limit"
		case "api_error":
			return "server"
	}
}

const normalizeV2 = (value: unknown, error: V2ErrorInfo): NormalizedAppError =>
	normalized(value, {
		category: categoryForV2Type(error.type),
		title: error.title,
		description: error.message,
		recovery: error.recovery,
		tag: error.tag,
		code: error.code,
		...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
		...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
		...(error.param === undefined ? {} : { param: error.param }),
		...(error.docUrl === undefined ? {} : { docUrl: error.docUrl }),
	})

const isTimeoutException = (value: unknown): boolean =>
	typeof DOMException !== "undefined" && value instanceof DOMException && value.name === "TimeoutError"

const normalizeHttpClientError = (value: HttpClientError.HttpClientError): NormalizedAppError => {
	const status = value.response?.status
	switch (status) {
		case 401:
			return normalized(value, {
				category: "authentication",
				status,
				title: "Sign in required",
				description: "Your session may have expired. Sign in again to continue.",
				recovery: "reauthenticate",
				technicalMessage: value.message,
			})
		case 403:
			return normalized(value, {
				category: "permission",
				status,
				title: "Permission required",
				description: "You do not have permission to perform this action.",
				recovery: "request_access",
				technicalMessage: value.message,
			})
		case 429:
			return normalized(value, {
				category: "rate-limit",
				status,
				title: "Too many requests",
				description: "Wait a moment, then try again.",
				recovery: "retry",
				technicalMessage: value.message,
			})
		case 504:
			return normalized(value, {
				category: "timeout",
				status,
				title: "Request timed out",
				description:
					"The request took too long. Narrow the time range or add filters, then try again.",
				recovery: "retry",
				technicalMessage: value.message,
			})
	}

	if (value.reason._tag === "TransportError") {
		if (isTimeoutException(value.reason.cause)) {
			return normalized(value, {
				category: "timeout",
				title: "Request timed out",
				description: "The API did not respond in time. Try again when you're ready.",
				recovery: "retry",
				technicalMessage: value.message,
			})
		}
		return normalized(value, {
			category: "network",
			title: "Cannot reach Maple API",
			description: "Check your connection. Data will resume once the API is reachable.",
			recovery: "retry",
			automaticRetry: true,
			technicalMessage: value.message,
		})
	}

	if (value.reason._tag === "InvalidUrlError") {
		return normalized(value, {
			category: "client",
			title: "This request could not be sent",
			description: "Reload Maple. If the problem continues, contact support.",
			recovery: "refresh",
			technicalMessage: value.message,
		})
	}

	if (status !== undefined && status >= 500) {
		return normalized(value, {
			category: "server",
			status,
			title: "Maple is temporarily unavailable",
			description: "The API could not complete the request. Try again in a moment.",
			recovery: "retry",
			technicalMessage: value.message,
		})
	}

	return normalized(value, {
		category: "client",
		...(status === undefined ? {} : { status }),
		title: "The request failed",
		description: "Maple could not complete this request.",
		recovery: "none",
		technicalMessage: value.message,
	})
}

const nestedCause = (value: unknown): unknown => asRecord(value)?.cause

const unexpectedError = (value: unknown): NormalizedAppError => {
	const tag = hasTag(value) ? value._tag : undefined
	return normalized(value, {
		category: "client",
		title: "Something went wrong",
		description: "An unexpected error occurred. Try again, or reload if the problem continues.",
		recovery: "refresh",
		recognized: false,
		...(tag === undefined ? {} : { tag }),
		technicalMessage:
			value instanceof Error
				? value.message
				: (rawStringField(value, "message") ?? (typeof value === "string" ? value : undefined)),
	})
}

const normalizeInternal = (input: unknown, depth: number): NormalizedAppError => {
	const value = unwrap(input)
	const v2 = v2ErrorInfo(value)
	if (v2 !== null) return normalizeV2(value, v2)

	if (HttpClientError.isHttpClientError(value)) return normalizeHttpClientError(value)

	if (isChunkLoadError(value)) {
		return normalized(value, {
			category: "client",
			title: "Maple was updated",
			description: "Reload to use the latest version.",
			recovery: "refresh",
			technicalMessage: value instanceof Error ? value.message : undefined,
		})
	}

	const cause = nestedCause(value)
	if (depth < 4 && cause !== undefined && cause !== value) {
		const nested = normalizeInternal(cause, depth + 1)
		if (nested.recognized) return { ...nested, diagnostics: { ...nested.diagnostics, value } }
	}

	return unexpectedError(value)
}

export const normalizeAppError = (input: unknown): NormalizedAppError => normalizeInternal(input, 0)

export const presentAppError = (error: NormalizedAppError): FormattedError => ({
	title: error.title,
	description: error.description,
	category: error.category,
	recovery: error.recovery,
	automaticRetry: error.automaticRetry,
	recognized: error.recognized,
	...(error.tag === undefined ? {} : { tag: error.tag }),
	...(error.code === undefined ? {} : { code: error.code }),
	...(error.status === undefined ? {} : { status: error.status }),
	...(error.param === undefined ? {} : { param: error.param }),
	...(error.docUrl === undefined ? {} : { docUrl: error.docUrl }),
	...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
	...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
})

export const formatBackendError = (input: unknown): FormattedError =>
	presentAppError(normalizeAppError(input))

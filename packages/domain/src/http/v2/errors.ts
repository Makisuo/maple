import { Schema } from "effect"
import { HttpErrorRecovery } from "../error-policy"

/**
 * v2 error envelope (see docs/api-v2.md): every error response body is
 * `{ "error": { "_tag", "type", "code", "title", "message", ... } }` with a
 * closed set of `type`s, a stable semantic error tag, and a stable public code.
 *
 * These remain `Schema.Error`s rather than tagged Effect failures: `_tag` is
 * deliberately nested inside the public envelope and identifies the semantic
 * failure that reached the boundary. Domain adapters preserve their original
 * tag; errors born at the v2 boundary derive one from their stable code.
 */

export const V2ErrorType = Schema.Literals([
	"invalid_request_error",
	"authentication_error",
	"permission_error",
	"not_found_error",
	"conflict_error",
	"rate_limit_error",
	"api_error",
])
export type V2ErrorType = Schema.Schema.Type<typeof V2ErrorType>

export const V2ErrorRecovery = HttpErrorRecovery
export type V2ErrorRecovery = Schema.Schema.Type<typeof V2ErrorRecovery>

/** Presentation/recovery metadata shared by every v2 error constructor. */
export interface V2ErrorMetadata {
	/** Stable semantic identity. Domain adapters pass the original Effect `_tag`. */
	readonly tag?: string
	readonly title?: string
	readonly retryable?: boolean
	readonly recovery?: V2ErrorRecovery
	readonly retryAfterSeconds?: number
	readonly retryAt?: string
}

interface ErrorExample {
	readonly code: string
	readonly message: string
	readonly param?: string
}

const errorBody = <const T extends V2ErrorType>(type: T, example: ErrorExample) =>
	Schema.Struct({
		_tag: Schema.optionalKey(
			Schema.String.check(Schema.isPattern(/^@maple\//)).annotate({
				description:
					"Stable semantic error tag. Maple clients should branch on this; public integrations may continue branching on `code`.",
			}),
		),
		type: Schema.Literal(type).annotate({
			description:
				"Error category — a closed enum (`invalid_request_error`, `authentication_error`, `permission_error`, `not_found_error`, `conflict_error`, `rate_limit_error`, `api_error`). Branch on `code` for specifics.",
		}),
		code: Schema.String.annotate({
			description: "Stable, machine-readable error code. Codes are append-only; branch on this.",
			examples: [example.code],
		}),
		message: Schema.String.annotate({
			description:
				"Human-readable explanation of what went wrong. For humans, not for programmatic branching.",
			examples: [example.message],
		}),
		title: Schema.optionalKey(
			Schema.String.annotate({
				description: "Short, human-readable heading suitable for an error state or toast.",
			}),
		),
		retryable: Schema.optionalKey(
			Schema.Boolean.annotate({
				description:
					"Whether the same logical request can plausibly succeed later without correcting its input. Automatic mutation replay still requires idempotency protection.",
			}),
		),
		recovery: Schema.optionalKey(
			V2ErrorRecovery.annotate({
				description: "Recommended next action for a person or API client.",
			}),
		),
		retry_after_seconds: Schema.optionalKey(
			Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)).annotate({
				description: "Minimum delay before retrying, mirrored in the Retry-After header.",
			}),
		),
		retry_at: Schema.optionalKey(
			Schema.String.check(
				Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value)), {
					description: "Expected an ISO date-time string",
				}),
			).annotate({
				description:
					"Absolute ISO-8601 retry time when the backend knows a reset instant rather than a fixed delay.",
			}),
		),
		param: Schema.optionalKey(
			Schema.String.annotate({
				description: "The request parameter that caused the error, when applicable.",
				...(example.param !== undefined ? { examples: [example.param] } : {}),
			}),
		),
		doc_url: Schema.optionalKey(
			Schema.String.annotate({
				description: "Link to reference documentation for this error, when available.",
				examples: ["https://api.maple.dev/v2/docs#errors"],
			}),
		),
	})

const defaultTitle: Record<V2ErrorType, string> = {
	invalid_request_error: "Invalid request",
	authentication_error: "Sign in required",
	permission_error: "Permission required",
	not_found_error: "Not found",
	conflict_error: "Could not save changes",
	rate_limit_error: "Too many requests",
	api_error: "Maple could not complete the request",
}

const defaultRecovery: Record<
	V2ErrorType,
	{ readonly retryable: boolean; readonly recovery: V2ErrorRecovery }
> = {
	invalid_request_error: { retryable: false, recovery: "fix_request" },
	authentication_error: { retryable: false, recovery: "reauthenticate" },
	permission_error: { retryable: false, recovery: "request_access" },
	not_found_error: { retryable: false, recovery: "none" },
	conflict_error: { retryable: false, recovery: "refresh" },
	rate_limit_error: { retryable: true, recovery: "retry" },
	api_error: { retryable: false, recovery: "contact_support" },
}

const errorMetadata = (
	type: V2ErrorType,
	code: string,
	defaults: V2ErrorMetadata = {},
	overrides: V2ErrorMetadata = {},
) => {
	const metadata = { ...defaults, ...overrides }
	return {
		_tag: metadata.tag ?? `@maple/http/v2/${code}`,
		title: metadata.title ?? defaultTitle[type],
		retryable: metadata.retryable ?? defaultRecovery[type].retryable,
		recovery: metadata.recovery ?? defaultRecovery[type].recovery,
		...(metadata.retryAfterSeconds === undefined
			? {}
			: { retry_after_seconds: metadata.retryAfterSeconds }),
		...(metadata.retryAt === undefined ? {} : { retry_at: metadata.retryAt }),
	}
}

export class V2InvalidRequestError extends Schema.Error<V2InvalidRequestError>(
	"@maple/http/v2/InvalidRequestError",
)(
	Schema.Struct({
		error: errorBody("invalid_request_error", {
			code: "parameter_invalid",
			message: "Invalid request query: limit must be between 1 and 100.",
			param: "limit",
		}),
	}).annotate({ identifier: "InvalidRequestError" }),
	{
		httpApiStatus: 400,
		identifier: "InvalidRequestError",
		title: "Invalid request error",
		description:
			"The request was malformed — a parameter is missing, of the wrong type, or out of range. HTTP 400.",
	},
) {
	override get message(): string {
		return this.error.message
	}
}

export class V2AuthenticationError extends Schema.Error<V2AuthenticationError>(
	"@maple/http/v2/AuthenticationError",
)(
	Schema.Struct({
		error: errorBody("authentication_error", {
			code: "invalid_credentials",
			message: "Invalid or missing credentials.",
		}),
	}).annotate({ identifier: "AuthenticationError" }),
	{
		httpApiStatus: 401,
		identifier: "AuthenticationError",
		title: "Authentication error",
		description: "The Bearer token is missing, malformed, or invalid. HTTP 401.",
	},
) {
	override get message(): string {
		return this.error.message
	}
}

export class V2PermissionError extends Schema.Error<V2PermissionError>("@maple/http/v2/PermissionError")(
	Schema.Struct({
		error: errorBody("permission_error", {
			code: "insufficient_scope",
			message: 'This API key does not have the "api_keys:write" scope required for this request.',
		}),
	}).annotate({ identifier: "PermissionError" }),
	{
		httpApiStatus: 403,
		identifier: "PermissionError",
		title: "Permission error",
		description:
			"The credentials are valid but lack the required scope or org role for this operation. HTTP 403.",
	},
) {
	override get message(): string {
		return this.error.message
	}
}

export class V2NotFoundError extends Schema.Error<V2NotFoundError>("@maple/http/v2/NotFoundError")(
	Schema.Struct({
		error: errorBody("not_found_error", {
			code: "api_key_not_found",
			message: "No such api_key.",
			param: "id",
		}),
	}).annotate({ identifier: "NotFoundError" }),
	{
		httpApiStatus: 404,
		identifier: "NotFoundError",
		title: "Not found error",
		description: "No object exists for the given ID. HTTP 404.",
	},
) {
	override get message(): string {
		return this.error.message
	}
}

export class V2ConflictError extends Schema.Error<V2ConflictError>("@maple/http/v2/ConflictError")(
	Schema.Struct({
		error: errorBody("conflict_error", {
			code: "resource_conflict",
			message: "The object was modified concurrently; retry the request.",
		}),
	}).annotate({ identifier: "ConflictError" }),
	{
		httpApiStatus: 409,
		identifier: "ConflictError",
		title: "Conflict error",
		description: "The request conflicts with the current state of the object. HTTP 409.",
	},
) {
	override get message(): string {
		return this.error.message
	}
}

/**
 * The request asked for more data than one response may carry.
 *
 * Reuses the `invalid_request_error` type — the closed enum stays closed — but
 * keeps 413 so the distinction from an ordinary 400 survives: nothing about the
 * request is malformed, the window is simply too wide. It is a statement about
 * the size of the answer, so retrying it unchanged can only fail identically;
 * the message says what to narrow.
 */
export class V2PayloadTooLargeError extends Schema.Error<V2PayloadTooLargeError>(
	"@maple/http/v2/PayloadTooLargeError",
)(
	Schema.Struct({
		error: errorBody("invalid_request_error", {
			code: "range_too_large",
			message:
				"That part of the recording is too large to load in one request. Request a narrower chunk range.",
			param: "to_chunk_seq",
		}),
	}).annotate({ identifier: "PayloadTooLargeError" }),
	{
		httpApiStatus: 413,
		identifier: "PayloadTooLargeError",
		title: "Payload too large error",
		description:
			"The requested range would exceed the endpoint's response budget. Narrow the range and retry. HTTP 413.",
	},
) {
	override get message(): string {
		return this.error.message
	}
}

export class V2RateLimitError extends Schema.Error<V2RateLimitError>("@maple/http/v2/RateLimitError")(
	Schema.Struct({
		error: errorBody("rate_limit_error", {
			code: "rate_limited",
			message: "Too many requests; slow down and retry after the interval in the Retry-After header.",
		}),
	}).annotate({ identifier: "RateLimitError" }),
	{
		httpApiStatus: 429,
		identifier: "RateLimitError",
		title: "Rate limit error",
		description: "Too many requests in a given window. Back off and retry. HTTP 429.",
	},
) {
	override get message(): string {
		return this.error.message
	}
}

export class V2ApiError extends Schema.Error<V2ApiError>("@maple/http/v2/ApiError")(
	Schema.Struct({
		error: errorBody("api_error", {
			code: "internal_error",
			message: "An unexpected error occurred on our end.",
		}),
	}).annotate({ identifier: "ApiError" }),
	{
		httpApiStatus: 500,
		identifier: "ApiError",
		title: "API error",
		description:
			"A sanitized unexpected server-side error. Retryability is carried by the public envelope metadata. HTTP 500.",
	},
) {
	override get message(): string {
		return this.error.message
	}
}

/**
 * `api_error` flavor for a misbehaving upstream provider (502) — the target of
 * an outbound call (e.g. a scrape target's discovery endpoint) rejected our
 * credentials or failed at the transport level. Distinct from 503 so consumers
 * can tell "the provider is misbehaving" from "Maple's storage is unavailable".
 */
export class V2UpstreamError extends Schema.Error<V2UpstreamError>("@maple/http/v2/UpstreamError")(
	Schema.Struct({
		error: errorBody("api_error", {
			code: "upstream_error",
			message: "The upstream provider rejected the request.",
		}),
	}).annotate({ identifier: "UpstreamError" }),
	{
		httpApiStatus: 502,
		identifier: "UpstreamError",
		title: "Upstream error",
		description:
			"An upstream provider the operation depends on failed or rejected our credentials. Check the integration's connection before retrying. HTTP 502.",
	},
) {
	override get message(): string {
		return this.error.message
	}
}

/** `api_error` flavor for upstream/persistence unavailability (503). */
export class V2ServiceUnavailableError extends Schema.Error<V2ServiceUnavailableError>(
	"@maple/http/v2/ServiceUnavailableError",
)(
	Schema.Struct({
		error: errorBody("api_error", {
			code: "api_key_lookup_unavailable",
			message: "The service is temporarily unavailable; retry after a short delay.",
		}),
	}).annotate({ identifier: "ServiceUnavailableError" }),
	{
		httpApiStatus: 503,
		identifier: "ServiceUnavailableError",
		title: "Service unavailable error",
		description:
			"The operation is unavailable. Retryability and recovery are carried by the public envelope metadata. HTTP 503.",
	},
) {
	override get message(): string {
		return this.error.message
	}
}

// Constructors — keep handler adapters one-liners.

export const invalidRequest = (
	code: string,
	message: string,
	param?: string,
	metadata: V2ErrorMetadata = {},
) =>
	new V2InvalidRequestError({
		error: {
			type: "invalid_request_error",
			code,
			message,
			...errorMetadata("invalid_request_error", code, {}, metadata),
			...(param !== undefined ? { param } : {}),
		},
	})

export const authenticationError = (code: string, message: string, metadata: V2ErrorMetadata = {}) =>
	new V2AuthenticationError({
		error: {
			type: "authentication_error",
			code,
			message,
			...errorMetadata("authentication_error", code, {}, metadata),
		},
	})

export const permissionError = (code: string, message: string, metadata: V2ErrorMetadata = {}) =>
	new V2PermissionError({
		error: {
			type: "permission_error",
			code,
			message,
			...errorMetadata("permission_error", code, {}, metadata),
		},
	})

/** `resource_missing` matches Stripe's code for a bad object ID. */
export const notFound = (message: string, param?: string, metadata: V2ErrorMetadata = {}) =>
	new V2NotFoundError({
		error: {
			type: "not_found_error",
			code: "resource_missing",
			message,
			...errorMetadata("not_found_error", "resource_missing", {}, metadata),
			...(param !== undefined ? { param } : {}),
		},
	})

/** Resource-specific 404 code for stable public branching. */
export const resourceNotFound = (
	resource: string,
	message: string,
	param = "id",
	metadata: V2ErrorMetadata = {},
) => {
	const code = `${resource}_not_found`
	return new V2NotFoundError({
		error: {
			type: "not_found_error",
			code,
			message,
			param,
			...errorMetadata("not_found_error", code, {}, metadata),
		},
	})
}

export const conflict = (code: string, message: string, metadata: V2ErrorMetadata = {}) =>
	new V2ConflictError({
		error: {
			type: "conflict_error",
			code,
			message,
			...errorMetadata("conflict_error", code, {}, metadata),
		},
	})

/**
 * The message crosses the public boundary verbatim: unlike the warehouse
 * errors, this one carries no database diagnostics — only the range the caller
 * asked for and the caps it exceeded — and it is the one error here where
 * telling the user exactly what to do is the whole value.
 */
export const payloadTooLarge = (message: string, param?: string, metadata: V2ErrorMetadata = {}) =>
	new V2PayloadTooLargeError({
		error: {
			type: "invalid_request_error",
			code: "range_too_large",
			message,
			...errorMetadata("invalid_request_error", "range_too_large", {}, metadata),
			...(param !== undefined ? { param } : {}),
		},
	})

export const rateLimitError = (code: string, message: string, metadata: V2ErrorMetadata = {}) =>
	new V2RateLimitError({
		error: {
			type: "rate_limit_error",
			code,
			message,
			...errorMetadata("rate_limit_error", code, {}, metadata),
		},
	})

export const rateLimited = (metadata: V2ErrorMetadata = {}) => {
	const retryAfterSeconds = metadata.retryAfterSeconds ?? 60
	return rateLimitError("rate_limited", `Too many requests. Retry after ${retryAfterSeconds} seconds.`, {
		retryAfterSeconds,
		...metadata,
	})
}

/**
 * The daily-budget 429.
 *
 * Names the ceiling that was hit — runs and model passes are separate settings,
 * and collapsing both into "quota reached" made a raised run cap look ignored
 * when it was the pass cap that stopped the start. The ISO timestamp stays at
 * the end for API consumers; the dashboard rewrites it as a relative time.
 */
export const investigationQuotaReached = (
	input: {
		readonly dimension: "runs" | "passes"
		readonly limit: number
		readonly retryableAt: string
	},
	metadata: V2ErrorMetadata = {},
) =>
	new V2RateLimitError({
		error: {
			type: "rate_limit_error",
			code: "investigation_daily_quota",
			message:
				input.dimension === "runs"
					? `Daily limit of ${input.limit} investigations reached. Resets at ${input.retryableAt}.`
					: `Daily limit of ${input.limit} model passes reached. Resets at ${input.retryableAt}.`,
			...errorMetadata(
				"rate_limit_error",
				"investigation_daily_quota",
				{
					title: "Investigation limit reached",
					retryAt: input.retryableAt,
				},
				metadata,
			),
		},
	})

export const upstreamError = (code: string, message: string, metadata: V2ErrorMetadata = {}) =>
	new V2UpstreamError({
		error: {
			type: "api_error",
			code,
			message,
			...errorMetadata(
				"api_error",
				code,
				{ title: "Connected service unavailable", recovery: "reconnect" },
				metadata,
			),
		},
	})

export const apiError = (metadata: V2ErrorMetadata = {}) =>
	new V2ApiError({
		error: {
			type: "api_error",
			code: "internal_error",
			message: "An unexpected error occurred on our end.",
			...errorMetadata(
				"api_error",
				"internal_error",
				{ tag: "@maple/http/v2/UnexpectedApiError", title: "Something went wrong" },
				metadata,
			),
		},
	})

export const serviceError = (code: string, message: string, metadata: V2ErrorMetadata = {}) =>
	new V2ServiceUnavailableError({
		error: {
			type: "api_error",
			code,
			message,
			...errorMetadata(
				"api_error",
				code,
				{ title: "Service temporarily unavailable", retryable: true, recovery: "retry" },
				metadata,
			),
		},
	})

export const serviceUnavailable = (message: string, metadata: V2ErrorMetadata = {}) =>
	serviceError("service_unavailable", message, metadata)

/** Sanitized dependency failure with a stable operation-specific public code. */
export const dependencyUnavailable = (code: string, metadata: V2ErrorMetadata = {}) =>
	serviceError(
		code,
		"A service required for this operation is temporarily unavailable; retry with backoff.",
		metadata,
	)

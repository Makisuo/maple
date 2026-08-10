import { Schema } from "effect"

/**
 * v2 error envelope (see docs/api-v2.md): every error response body is
 * `{ "error": { "type", "code", "message", "param"?, "doc_url"? } }` with a
 * closed set of `type`s and stable machine-readable `code`s.
 *
 * These are `Schema.Error`s (not Tagged) so the wire body carries no
 * internal `_tag` — exactly the envelope, nothing else.
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

interface ErrorExample {
	readonly code: string
	readonly message: string
	readonly param?: string
}

const errorBody = <const T extends V2ErrorType>(type: T, example: ErrorExample) =>
	Schema.Struct({
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
		description: "An unexpected server-side error. Safe to retry with backoff. HTTP 500.",
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
			"A dependency (persistence or upstream) was temporarily unavailable. Retry with backoff. HTTP 503.",
	},
) {
	override get message(): string {
		return this.error.message
	}
}

// Constructors — keep handler adapters one-liners.

export const invalidRequest = (code: string, message: string, param?: string) =>
	new V2InvalidRequestError({
		error: { type: "invalid_request_error", code, message, ...(param !== undefined ? { param } : {}) },
	})

export const authenticationError = (code: string, message: string) =>
	new V2AuthenticationError({ error: { type: "authentication_error", code, message } })

export const permissionError = (code: string, message: string) =>
	new V2PermissionError({ error: { type: "permission_error", code, message } })

/** `resource_missing` matches Stripe's code for a bad object ID. */
export const notFound = (message: string, param?: string) =>
	new V2NotFoundError({
		error: {
			type: "not_found_error",
			code: "resource_missing",
			message,
			...(param !== undefined ? { param } : {}),
		},
	})

/** Resource-specific 404 code for stable public branching. */
export const resourceNotFound = (resource: string, message: string, param = "id") =>
	new V2NotFoundError({
		error: {
			type: "not_found_error",
			code: `${resource}_not_found`,
			message,
			param,
		},
	})

export const conflict = (code: string, message: string) =>
	new V2ConflictError({ error: { type: "conflict_error", code, message } })

/**
 * The message crosses the public boundary verbatim: unlike the warehouse
 * errors, this one carries no database diagnostics — only the range the caller
 * asked for and the caps it exceeded — and it is the one error here where
 * telling the user exactly what to do is the whole value.
 */
export const payloadTooLarge = (message: string, param?: string) =>
	new V2PayloadTooLargeError({
		error: {
			type: "invalid_request_error",
			code: "range_too_large",
			message,
			...(param !== undefined ? { param } : {}),
		},
	})

export const rateLimited = () =>
	new V2RateLimitError({
		error: {
			type: "rate_limit_error",
			code: "rate_limited",
			message: "Too many requests. Retry after 60 seconds.",
		},
	})

/**
 * The daily-budget 429.
 *
 * Names the ceiling that was hit — runs and model passes are separate settings,
 * and collapsing both into "quota reached" made a raised run cap look ignored
 * when it was the pass cap that stopped the start. The ISO timestamp stays at
 * the end for API consumers; the dashboard rewrites it as a relative time.
 */
export const investigationQuotaReached = (input: {
	readonly dimension: "runs" | "passes"
	readonly limit: number
	readonly retryableAt: string
}) =>
	new V2RateLimitError({
		error: {
			type: "rate_limit_error",
			code: "investigation_daily_quota",
			message:
				input.dimension === "runs"
					? `Daily limit of ${input.limit} investigations reached. Resets at ${input.retryableAt}.`
					: `Daily limit of ${input.limit} model passes reached. Resets at ${input.retryableAt}.`,
		},
	})

export const upstreamError = (code: string, message: string) =>
	new V2UpstreamError({ error: { type: "api_error", code, message } })

export const apiError = () =>
	new V2ApiError({
		error: {
			type: "api_error",
			code: "internal_error",
			message: "An unexpected error occurred on our end.",
		},
	})

export const serviceUnavailable = (message: string) =>
	new V2ServiceUnavailableError({ error: { type: "api_error", code: "service_unavailable", message } })

/** Sanitized dependency failure with a stable operation-specific public code. */
export const dependencyUnavailable = (code: string) =>
	new V2ServiceUnavailableError({
		error: {
			type: "api_error",
			code,
			message: "A service required for this operation is temporarily unavailable; retry with backoff.",
		},
	})

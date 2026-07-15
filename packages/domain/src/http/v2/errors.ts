import { Schema } from "effect"

/**
 * v2 error envelope (see docs/api-v2.md): every error response body is
 * `{ "error": { "type", "code", "message", "param"?, "doc_url"? } }` with a
 * closed set of `type`s and stable machine-readable `code`s.
 *
 * These are `Schema.ErrorClass`es (not Tagged) so the wire body carries no
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

const errorBody = <const T extends V2ErrorType>(type: T) =>
	Schema.Struct({
		type: Schema.Literal(type),
		code: Schema.String,
		message: Schema.String,
		param: Schema.optionalKey(Schema.String),
		doc_url: Schema.optionalKey(Schema.String),
	})

export class V2InvalidRequestError extends Schema.ErrorClass<V2InvalidRequestError>(
	"@maple/http/v2/InvalidRequestError",
)({ error: errorBody("invalid_request_error") }, { httpApiStatus: 400 }) {}

export class V2AuthenticationError extends Schema.ErrorClass<V2AuthenticationError>(
	"@maple/http/v2/AuthenticationError",
)({ error: errorBody("authentication_error") }, { httpApiStatus: 401 }) {}

export class V2PermissionError extends Schema.ErrorClass<V2PermissionError>(
	"@maple/http/v2/PermissionError",
)({ error: errorBody("permission_error") }, { httpApiStatus: 403 }) {}

export class V2NotFoundError extends Schema.ErrorClass<V2NotFoundError>("@maple/http/v2/NotFoundError")(
	{ error: errorBody("not_found_error") },
	{ httpApiStatus: 404 },
) {}

export class V2ConflictError extends Schema.ErrorClass<V2ConflictError>("@maple/http/v2/ConflictError")(
	{ error: errorBody("conflict_error") },
	{ httpApiStatus: 409 },
) {}

export class V2RateLimitError extends Schema.ErrorClass<V2RateLimitError>("@maple/http/v2/RateLimitError")(
	{ error: errorBody("rate_limit_error") },
	{ httpApiStatus: 429 },
) {}

export class V2ApiError extends Schema.ErrorClass<V2ApiError>("@maple/http/v2/ApiError")(
	{ error: errorBody("api_error") },
	{ httpApiStatus: 500 },
) {}

/** `api_error` flavor for upstream/persistence unavailability (503). */
export class V2ServiceUnavailableError extends Schema.ErrorClass<V2ServiceUnavailableError>(
	"@maple/http/v2/ServiceUnavailableError",
)({ error: errorBody("api_error") }, { httpApiStatus: 503 }) {}

// Constructors — keep handler adapters one-liners.

export const invalidRequest = (code: string, message: string, param?: string) =>
	new V2InvalidRequestError({ error: { type: "invalid_request_error", code, message, ...(param !== undefined ? { param } : {}) } })

export const authenticationError = (code: string, message: string) =>
	new V2AuthenticationError({ error: { type: "authentication_error", code, message } })

export const permissionError = (code: string, message: string) =>
	new V2PermissionError({ error: { type: "permission_error", code, message } })

/** `resource_missing` matches Stripe's code for a bad object ID. */
export const notFound = (message: string, param?: string) =>
	new V2NotFoundError({
		error: { type: "not_found_error", code: "resource_missing", message, ...(param !== undefined ? { param } : {}) },
	})

export const conflict = (code: string, message: string) =>
	new V2ConflictError({ error: { type: "conflict_error", code, message } })

export const apiError = (message: string) =>
	new V2ApiError({ error: { type: "api_error", code: "internal_error", message } })

export const serviceUnavailable = (message: string) =>
	new V2ServiceUnavailableError({ error: { type: "api_error", code: "service_unavailable", message } })

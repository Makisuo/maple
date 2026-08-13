import { Schema } from "effect"
import {
	HttpErrorRecovery,
	HttpTaggedError,
	PublicHttpErrorType,
	publicHttpErrorTypeForStatus,
	type HttpErrorRetry,
	type PublicHttpErrorTag,
	type PublicHttpErrorStatus,
} from "../error-policy"
import { publicError } from "./public-error"
import { v2WorkerUnavailableDefinition } from "./worker-unavailable"

/**
 * Every v2 failure uses the same public body. Endpoint schemas narrow `_tag`
 * and `type` to literals; the runtime value preserves that body unchanged.
 */
export const V2ErrorType = PublicHttpErrorType
export type V2ErrorType = Schema.Schema.Type<typeof V2ErrorType>

export const V2ErrorRecovery = HttpErrorRecovery
export type V2ErrorRecovery = Schema.Schema.Type<typeof V2ErrorRecovery>

export const errorTypeForStatus = publicHttpErrorTypeForStatus

interface V2ErrorDefinitionBase<
	Tag extends PublicHttpErrorTag,
	Status extends PublicHttpErrorStatus,
	Code extends string,
> {
	readonly tag: Tag
	readonly status: Status
	readonly code: Code
	readonly title: string
	readonly message: string
	readonly identifier: string
	readonly retryAfterSeconds?: number
}

export type V2ErrorDefinitionOptions<
	Tag extends PublicHttpErrorTag,
	Status extends PublicHttpErrorStatus,
	Code extends string,
> = V2ErrorDefinitionBase<Tag, Status, Code> &
	(
		| {
				readonly retry: "never"
				readonly recovery: Exclude<V2ErrorRecovery, "retry">
		  }
		| {
				readonly retry: Exclude<HttpErrorRetry, "never">
				readonly recovery: "retry"
		  }
	)

export interface V2ErrorMakeOptions {
	readonly param?: string
	readonly retryAfterSeconds?: number
	readonly retryAt?: string
}

/**
 * Define a boundary-born v2 error. Its value, exact schema, status, tag, and
 * recovery metadata come from this one definition.
 */
export const defineV2Error = <
	const Tag extends PublicHttpErrorTag,
	const Status extends PublicHttpErrorStatus,
	const Code extends string,
>(
	definition: V2ErrorDefinitionOptions<Tag, Status, Code>,
) => {
	const type = errorTypeForStatus(definition.status)
	const retryPolicy =
		definition.retry === "never"
			? { retry: "never" as const, recovery: definition.recovery }
			: { retry: definition.retry, recovery: "retry" as const }
	class BoundaryError extends HttpTaggedError<BoundaryError>()(
		definition.tag,
		{
			message: Schema.String,
			param: Schema.optionalKey(Schema.String),
			retryAfterSeconds: Schema.optionalKey(
				Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
			),
			retryAt: Schema.optionalKey(Schema.String),
		},
		{
			status: definition.status,
			code: definition.code,
			title: definition.title,
			...retryPolicy,
			exposure: "public_message",
			param: (error) => error.param,
			retryAfterSeconds: (error) => error.retryAfterSeconds,
			retryAt: (error) => error.retryAt,
		},
	) {}
	const schema = publicError(BoundaryError, {
		identifier: definition.identifier,
		title: definition.title,
	})

	const make = (message: string = definition.message, options: V2ErrorMakeOptions = {}) => {
		const retryAfterSeconds = options.retryAfterSeconds ?? definition.retryAfterSeconds
		return new BoundaryError({
			message,
			...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
			...(options.retryAt === undefined ? {} : { retryAt: options.retryAt }),
			...(options.param === undefined ? {} : { param: options.param }),
		})
	}

	return { ...definition, type, schema, make } as const
}

export const V2InvalidRequest = defineV2Error({
	tag: "@maple/http/v2/InvalidRequestError",
	status: 400,
	code: "parameter_invalid",
	title: "Invalid request",
	message: "The request did not match the endpoint schema.",
	retry: "never",
	recovery: "fix_request",
	identifier: "InvalidRequestError",
})

export const V2InvalidCredentials = defineV2Error({
	tag: "@maple/http/v2/InvalidCredentialsError",
	status: 401,
	code: "invalid_credentials",
	title: "Sign in required",
	message: "Invalid or missing credentials.",
	retry: "never",
	recovery: "reauthenticate",
	identifier: "InvalidCredentialsError",
})

export const V2InsufficientScope = defineV2Error({
	tag: "@maple/http/v2/InsufficientScopeError",
	status: 403,
	code: "insufficient_scope",
	title: "Permission required",
	message: "The API key does not have the scope required for this request.",
	retry: "never",
	recovery: "request_access",
	identifier: "InsufficientScopeError",
})

export const V2InsufficientPermissions = defineV2Error({
	tag: "@maple/http/v2/InsufficientPermissionsError",
	status: 403,
	code: "insufficient_permissions",
	title: "Permission required",
	message: "Only organization administrators can perform this operation.",
	retry: "never",
	recovery: "request_access",
	identifier: "InsufficientPermissionsError",
})

export const V2ParameterInvalid = defineV2Error({
	tag: "@maple/http/v2/ParameterInvalidError",
	status: 400,
	code: "parameter_invalid",
	title: "Invalid request",
	message: "A request parameter is invalid.",
	retry: "never",
	recovery: "fix_request",
	identifier: "ParameterInvalidError",
})

export const V2ParameterMissing = defineV2Error({
	tag: "@maple/http/v2/ParameterMissingError",
	status: 400,
	code: "parameter_missing",
	title: "Missing request parameter",
	message: "A required request parameter is missing.",
	retry: "never",
	recovery: "fix_request",
	identifier: "ParameterMissingError",
})

export const V2TimeRangeInvalid = defineV2Error({
	tag: "@maple/http/v2/TimeRangeInvalidError",
	status: 400,
	code: "invalid_time_range",
	title: "Invalid time range",
	message: "end_time must be after start_time.",
	retry: "never",
	recovery: "fix_request",
	identifier: "TimeRangeInvalidError",
})

export const V2CursorInvalid = defineV2Error({
	tag: "@maple/http/v2/CursorInvalidError",
	status: 400,
	code: "cursor_invalid",
	title: "Invalid pagination cursor",
	message: "Invalid pagination cursor.",
	retry: "never",
	recovery: "fix_request",
	identifier: "CursorInvalidError",
})

export const V2CursorSortMismatch = defineV2Error({
	tag: "@maple/http/v2/CursorSortMismatchError",
	status: 400,
	code: "cursor_sort_mismatch",
	title: "Cursor does not match sort",
	message: "Cursor does not match the selected sort.",
	retry: "never",
	recovery: "fix_request",
	identifier: "CursorSortMismatchError",
})

export const V2CallbackHostUnavailable = defineV2Error({
	tag: "@maple/http/v2/CallbackHostUnavailableError",
	status: 503,
	code: "callback_host_unavailable",
	title: "Integration setup unavailable",
	message: "Integration setup is not available from this host.",
	retry: "never",
	recovery: "contact_support",
	identifier: "CallbackHostUnavailableError",
})

export const V2RateLimited = defineV2Error({
	tag: "@maple/http/v2/RateLimitError",
	status: 429,
	code: "rate_limited",
	title: "Too many requests",
	message: "Too many requests. Retry after the interval in the Retry-After header.",
	retry: "after",
	recovery: "retry",
	identifier: "RateLimitError",
})

export const V2ResponseSchemaFailure = defineV2Error({
	tag: "@maple/http/v2/ResponseSchemaError",
	status: 500,
	code: "internal_error",
	title: "Something went wrong",
	message: "An unexpected error occurred on our end.",
	retry: "never",
	recovery: "contact_support",
	identifier: "ResponseSchemaError",
})

export const V2UnexpectedFailure = defineV2Error({
	tag: "@maple/http/v2/UnexpectedError",
	status: 500,
	code: "internal_error",
	title: "Something went wrong",
	message: "An unexpected error occurred on our end.",
	retry: "never",
	recovery: "contact_support",
	identifier: "UnexpectedError",
})

/** App bootstrap failed before the v2 HttpApi graph could handle the request. */
export const V2WorkerUnavailable = defineV2Error({
	...v2WorkerUnavailableDefinition,
})

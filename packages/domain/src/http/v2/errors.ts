import { Schema } from "effect"
import {
	HttpErrorRecovery,
	PublicHttpErrorType,
	makePublicHttpErrorBodySchema,
	publicHttpErrorTypeForStatus,
	type PublicHttpErrorBody,
	type PublicHttpErrorStatus,
} from "../error-policy"

/**
 * Every v2 failure uses the same public body. Endpoint schemas narrow `_tag`
 * and `type` to literals; the runtime value preserves that body unchanged.
 */
export const V2ErrorType = PublicHttpErrorType
export type V2ErrorType = Schema.Schema.Type<typeof V2ErrorType>

export const V2ErrorRecovery = HttpErrorRecovery
export type V2ErrorRecovery = Schema.Schema.Type<typeof V2ErrorRecovery>

export interface V2PublicError<Tag extends string, Status extends PublicHttpErrorStatus> {
	readonly error: PublicHttpErrorBody<Tag, Status>
}

export const errorTypeForStatus = publicHttpErrorTypeForStatus

export interface V2ErrorDefinitionOptions<
	Tag extends string,
	Status extends PublicHttpErrorStatus,
	Code extends string,
> {
	readonly tag: Tag
	readonly status: Status
	readonly code: Code
	readonly title: string
	readonly message: string
	readonly retryable: boolean
	readonly recovery: V2ErrorRecovery
	readonly identifier: string
}

export interface V2ErrorMakeOptions {
	readonly param?: string
	readonly retryAfterSeconds?: number
	readonly retryAt?: string
}

export interface V2ErrorSchemaOptions<Tag extends string, Status extends PublicHttpErrorStatus> {
	readonly tag: Tag
	readonly status: Status
	readonly identifier: string
	readonly title: string
	readonly description?: string
}

/** Build one exact OpenAPI branch for a single semantic error tag. */
export const makeV2ErrorSchema = <const Tag extends string, const Status extends PublicHttpErrorStatus>(
	options: V2ErrorSchemaOptions<Tag, Status>,
) => {
	const type = errorTypeForStatus(options.status)
	return Schema.Struct({
		error: makePublicHttpErrorBodySchema(
			Schema.Literal(options.tag).annotate({
				description: "Stable semantic error tag. Branch on this exact value.",
			}),
			Schema.Literal(type).annotate({
				description: "Broad error category shared by related semantic tags.",
			}),
		),
	}).annotate({
		httpApiStatus: options.status,
		identifier: options.identifier,
		title: options.title,
		description: options.description ?? `The ${options.tag} failure. HTTP ${options.status}.`,
	})
}

/**
 * Define a boundary-born v2 error. Its value, exact schema, status, tag, and
 * recovery metadata come from this one definition.
 */
export const defineV2Error = <
	const Tag extends string,
	const Status extends PublicHttpErrorStatus,
	const Code extends string,
>(
	definition: V2ErrorDefinitionOptions<Tag, Status, Code>,
) => {
	const type = errorTypeForStatus(definition.status)
	const schema = makeV2ErrorSchema({
		tag: definition.tag,
		status: definition.status,
		identifier: definition.identifier,
		title: definition.title,
	})
	const errorBodySchema = makePublicHttpErrorBodySchema(
		Schema.Literal(definition.tag),
		Schema.Literal(type),
	)
	class BoundaryError extends Schema.TaggedError<BoundaryError>(definition.identifier)(definition.tag, {
		error: errorBodySchema,
	}) {
		override get message(): string {
			return this.error.message
		}
	}

	const make = (message: string = definition.message, options: V2ErrorMakeOptions = {}) => {
		const error = {
			_tag: definition.tag,
			type,
			code: definition.code,
			title: definition.title,
			message,
			retryable: definition.retryable,
			recovery: definition.recovery,
			...(options.retryAfterSeconds === undefined
				? {}
				: { retry_after_seconds: options.retryAfterSeconds }),
			...(options.retryAt === undefined ? {} : { retry_at: options.retryAt }),
			...(options.param === undefined ? {} : { param: options.param }),
		} satisfies PublicHttpErrorBody<Tag, Status>
		return new BoundaryError({ error })
	}

	return { ...definition, type, schema, make } as const
}

export const V2InvalidRequest = defineV2Error({
	tag: "@maple/http/v2/InvalidRequestError",
	status: 400,
	code: "parameter_invalid",
	title: "Invalid request",
	message: "The request did not match the endpoint schema.",
	retryable: false,
	recovery: "fix_request",
	identifier: "InvalidRequestError",
})

export const V2InvalidCredentials = defineV2Error({
	tag: "@maple/http/v2/InvalidCredentialsError",
	status: 401,
	code: "invalid_credentials",
	title: "Sign in required",
	message: "Invalid or missing credentials.",
	retryable: false,
	recovery: "reauthenticate",
	identifier: "InvalidCredentialsError",
})

export const V2InsufficientScope = defineV2Error({
	tag: "@maple/http/v2/InsufficientScopeError",
	status: 403,
	code: "insufficient_scope",
	title: "Permission required",
	message: "The API key does not have the scope required for this request.",
	retryable: false,
	recovery: "request_access",
	identifier: "InsufficientScopeError",
})

export const V2InsufficientPermissions = defineV2Error({
	tag: "@maple/http/v2/InsufficientPermissionsError",
	status: 403,
	code: "insufficient_permissions",
	title: "Permission required",
	message: "Only organization administrators can perform this operation.",
	retryable: false,
	recovery: "request_access",
	identifier: "InsufficientPermissionsError",
})

export const V2ParameterInvalid = defineV2Error({
	tag: "@maple/http/v2/ParameterInvalidError",
	status: 400,
	code: "parameter_invalid",
	title: "Invalid request",
	message: "A request parameter is invalid.",
	retryable: false,
	recovery: "fix_request",
	identifier: "ParameterInvalidError",
})

export const V2ParameterMissing = defineV2Error({
	tag: "@maple/http/v2/ParameterMissingError",
	status: 400,
	code: "parameter_missing",
	title: "Missing request parameter",
	message: "A required request parameter is missing.",
	retryable: false,
	recovery: "fix_request",
	identifier: "ParameterMissingError",
})

export const V2TimeRangeInvalid = defineV2Error({
	tag: "@maple/http/v2/TimeRangeInvalidError",
	status: 400,
	code: "invalid_time_range",
	title: "Invalid time range",
	message: "end_time must be after start_time.",
	retryable: false,
	recovery: "fix_request",
	identifier: "TimeRangeInvalidError",
})

export const V2CursorInvalid = defineV2Error({
	tag: "@maple/http/v2/CursorInvalidError",
	status: 400,
	code: "cursor_invalid",
	title: "Invalid pagination cursor",
	message: "Invalid pagination cursor.",
	retryable: false,
	recovery: "fix_request",
	identifier: "CursorInvalidError",
})

export const V2CursorSortMismatch = defineV2Error({
	tag: "@maple/http/v2/CursorSortMismatchError",
	status: 400,
	code: "cursor_sort_mismatch",
	title: "Cursor does not match sort",
	message: "Cursor does not match the selected sort.",
	retryable: false,
	recovery: "fix_request",
	identifier: "CursorSortMismatchError",
})

export const V2CallbackHostUnavailable = defineV2Error({
	tag: "@maple/http/v2/CallbackHostUnavailableError",
	status: 503,
	code: "callback_host_unavailable",
	title: "Integration setup unavailable",
	message: "Integration setup is not available from this host.",
	retryable: false,
	recovery: "contact_support",
	identifier: "CallbackHostUnavailableError",
})

export const V2RateLimited = defineV2Error({
	tag: "@maple/http/v2/RateLimitError",
	status: 429,
	code: "rate_limited",
	title: "Too many requests",
	message: "Too many requests. Retry after the interval in the Retry-After header.",
	retryable: true,
	recovery: "retry",
	identifier: "RateLimitError",
})

export const V2ResponseSchemaFailure = defineV2Error({
	tag: "@maple/http/v2/ResponseSchemaError",
	status: 500,
	code: "internal_error",
	title: "Something went wrong",
	message: "An unexpected error occurred on our end.",
	retryable: false,
	recovery: "contact_support",
	identifier: "ResponseSchemaError",
})

export const V2UnexpectedFailure = defineV2Error({
	tag: "@maple/http/v2/UnexpectedError",
	status: 500,
	code: "internal_error",
	title: "Something went wrong",
	message: "An unexpected error occurred on our end.",
	retryable: false,
	recovery: "contact_support",
	identifier: "UnexpectedError",
})

/** App bootstrap failed before the v2 HttpApi graph could handle the request. */
export const V2WorkerUnavailable = defineV2Error({
	tag: "@maple/http/v2/WorkerUnavailableError",
	status: 504,
	code: "worker_unavailable",
	title: "Maple API is temporarily unavailable",
	message: "Maple API is temporarily unavailable. Retry in a few seconds.",
	retryable: true,
	recovery: "retry",
	identifier: "WorkerUnavailableError",
})

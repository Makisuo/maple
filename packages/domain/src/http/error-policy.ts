import { Schema } from "effect"

/** Recovery actions understood by both the HTTP boundary and Maple clients. */
export const HttpErrorRecovery = Schema.Literals([
	"none",
	"fix_request",
	"reauthenticate",
	"request_access",
	"reconnect",
	"refresh",
	"retry",
	"contact_support",
])
export type HttpErrorRecovery = Schema.Schema.Type<typeof HttpErrorRecovery>

/** Closed public category shared by HTTP errors and every Maple client. */
export const PublicHttpErrorType = Schema.Literals([
	"invalid_request_error",
	"authentication_error",
	"payment_error",
	"permission_error",
	"not_found_error",
	"conflict_error",
	"rate_limit_error",
	"api_error",
])
export type PublicHttpErrorType = Schema.Schema.Type<typeof PublicHttpErrorType>

export type HttpErrorRetry = "never" | "backoff" | "after"
export type PublicHttpErrorStatus =
	| 400
	| 401
	| 402
	| 403
	| 404
	| 409
	| 413
	| 422
	| 429
	| 500
	| 502
	| 503
	| 504
export type PublicHttpErrorTag = `@maple/http/${string}`

export type PublicHttpErrorTypeForStatus<Status extends PublicHttpErrorStatus> = Status extends
	| 400
	| 413
	| 422
	? "invalid_request_error"
	: Status extends 401
		? "authentication_error"
		: Status extends 402
			? "payment_error"
			: Status extends 403
				? "permission_error"
				: Status extends 404
					? "not_found_error"
					: Status extends 409
						? "conflict_error"
						: Status extends 429
							? "rate_limit_error"
							: "api_error"

/** The public representation every self-describing HTTP error exposes itself. */
export interface PublicHttpErrorBody<Tag extends string, Status extends PublicHttpErrorStatus> {
	readonly _tag: Tag
	readonly type: PublicHttpErrorTypeForStatus<Status>
	readonly code: string
	readonly title: string
	readonly message: string
	readonly retryable: boolean
	readonly recovery: HttpErrorRecovery
	readonly retry_after_seconds?: number
	readonly retry_at?: string
	readonly param?: string
}

const publicHttpErrorBodyFields = {
	code: Schema.String.annotate({
		description: "Stable public category for presentation; branch on `_tag` for the exact failure.",
	}),
	title: Schema.String.annotate({
		description: "Short, human-readable heading suitable for an error state or toast.",
	}),
	message: Schema.String.annotate({
		description: "Human-readable explanation for people, not programmatic branching.",
	}),
	retryable: Schema.Boolean.annotate({
		description: "Whether the same logical request can plausibly succeed later.",
	}),
	recovery: HttpErrorRecovery.annotate({
		description: "Recommended next action for an API client or person.",
	}),
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
		).annotate({ description: "Absolute ISO-8601 time at which a retry may succeed." }),
	),
	param: Schema.optionalKey(
		Schema.String.annotate({ description: "Request parameter associated with the failure." }),
	),
}

/**
 * Build the one public error body contract with either broad or literal tag/type schemas.
 * Runtime decoding and endpoint-specific OpenAPI branches share these fields so they cannot drift.
 */
export const makePublicHttpErrorBodySchema = <Tag extends string, Type extends PublicHttpErrorType>(
	tag: Schema.Codec<Tag, Tag, never, never>,
	type: Schema.Codec<Type, Type, never, never>,
) =>
	Schema.Struct({
		_tag: tag,
		type,
		...publicHttpErrorBodyFields,
	})

/**
 * Build an endpoint-specific body schema from the same policy that materializes
 * the runtime body. Static policy fields become literals in OpenAPI; dynamic
 * fields stay broad because their value depends on the error instance.
 */
export const makeExactPublicHttpErrorBodySchema = <
	Error extends PublicTaggedError,
	Tag extends string,
	Type extends PublicHttpErrorType,
	Status extends PublicHttpErrorStatus,
>(
	tag: Schema.Codec<Tag, Tag, never, never>,
	type: Schema.Codec<Type, Type, never, never>,
	policy: PublicHttpErrorPolicy<Error, Status>,
) =>
	Schema.Struct({
		_tag: tag,
		type,
		...publicHttpErrorBodyFields,
		code: typeof policy.code === "string" ? Schema.Literal(policy.code) : publicHttpErrorBodyFields.code,
		title:
			typeof policy.title === "string" ? Schema.Literal(policy.title) : publicHttpErrorBodyFields.title,
		message:
			policy.exposure === "redacted" && typeof policy.message === "string"
				? Schema.Literal(policy.message)
				: publicHttpErrorBodyFields.message,
		retryable: Schema.Literal(policy.retry !== "never"),
		recovery: Schema.Literal(policy.recovery),
	})

/** Runtime contract for a public error body when its exact tag/status are not known statically. */
export const PublicHttpErrorBodySchema = makePublicHttpErrorBodySchema(
	Schema.String.check(Schema.isPattern(/^@maple\//)),
	PublicHttpErrorType,
)
export type AnyPublicHttpErrorBody = Schema.Schema.Type<typeof PublicHttpErrorBodySchema>

type ErrorValue<Error, Value> = Value | ((error: Error) => Value)

interface PublicHttpErrorPolicyBase<Error, Status extends PublicHttpErrorStatus> {
	readonly status: Status
	readonly code: ErrorValue<Error, string>
	readonly title: ErrorValue<Error, string>
	readonly param?: ErrorValue<Error, string | undefined>
	readonly retryAfterSeconds?: ErrorValue<Error, number | undefined>
	readonly retryAt?: ErrorValue<Error, string | undefined>
}

type PublicHttpRetryPolicy =
	| {
			readonly retry: "never"
			readonly recovery: Exclude<HttpErrorRecovery, "retry">
	  }
	| {
			readonly retry: Exclude<HttpErrorRetry, "never">
			readonly recovery: "retry"
	  }

type PublicHttpMessagePolicy<Error> =
	| {
			readonly exposure: "public_message"
	  }
	| {
			readonly exposure: "redacted"
			readonly message: ErrorValue<Error, string>
	  }

/** Public HTTP presentation owned by the tagged error class itself. */
export type PublicHttpErrorPolicy<Error, Status extends PublicHttpErrorStatus> = PublicHttpErrorPolicyBase<
	Error,
	Status
> &
	PublicHttpRetryPolicy &
	PublicHttpMessagePolicy<Error>

/** Type-level and runtime link from an error to its class-owned HTTP definition. */
export const PublicHttpErrorPolicyTypeId: unique symbol = Symbol.for("@maple/http/PublicHttpErrorPolicy")

export interface PublicHttpErrorDefinition<Tag extends string, Status extends PublicHttpErrorStatus> {
	readonly tag: Tag
	readonly status: Status
}

export interface WithPublicHttpErrorPolicy<Tag extends string, Status extends PublicHttpErrorStatus> {
	readonly [PublicHttpErrorPolicyTypeId]: PublicHttpErrorDefinition<Tag, Status>
	/** Public HTTP body read directly by the endpoint error schema during encoding. */
	readonly error: PublicHttpErrorBody<Tag, Status>
}

export interface PublicTaggedError {
	readonly _tag: string
	readonly message: string
}

export type SelfDescribingHttpError = PublicTaggedError &
	WithPublicHttpErrorPolicy<string, PublicHttpErrorStatus>

export type PublicHttpErrorStatusOf<Error extends WithPublicHttpErrorPolicy<string, PublicHttpErrorStatus>> =
	Error[typeof PublicHttpErrorPolicyTypeId]["status"]

export interface PublicHttpErrorClassDefinition<
	Error extends PublicTaggedError,
	Tag extends string,
	Status extends PublicHttpErrorStatus,
> {
	readonly tag: Tag
	readonly policy: PublicHttpErrorPolicy<Error, Status>
}

export interface SelfDescribingHttpErrorClass<Error extends SelfDescribingHttpError> extends Function {
	readonly [PublicHttpErrorPolicyTypeId]: PublicHttpErrorClassDefinition<
		Error,
		Error["_tag"],
		PublicHttpErrorStatusOf<Error>
	>
}

/**
 * Define a Schema tagged error whose HTTP status and safe public presentation
 * live on the error class. The brand keeps the policy available to TypeScript;
 * the static symbol makes the same policy available to the v2 serializer.
 */
export const HttpTaggedError =
	<Self>() =>
	<
		const Tag extends PublicHttpErrorTag,
		const Fields extends Schema.Struct.Fields,
		const Policy extends PublicHttpErrorPolicy<
			Schema.Struct.Type<Fields> & PublicTaggedError,
			PublicHttpErrorStatus
		>,
	>(
		tag: Tag,
		fields: Fields,
		policy: Policy,
	) => {
		const ErrorClass = Schema.TaggedError<Self, WithPublicHttpErrorPolicy<Tag, Policy["status"]>>()(
			tag,
			fields,
			{ httpApiStatus: policy.status },
		)
		// SAFETY: the generated TaggedError class is extended only to add the self-describing HTTP error view.
		const SelfDescribingErrorClass = class extends (ErrorClass as unknown as new (
			...args: Array<unknown>
		) => SelfDescribingHttpError) {
			override readonly error: PublicHttpErrorBody<string, PublicHttpErrorStatus> =
				publicHttpErrorBody(this)
		} as unknown as typeof ErrorClass

		return Object.assign(SelfDescribingErrorClass, {
			[PublicHttpErrorPolicyTypeId]: { tag, policy },
		} as const)
	}

export const publicHttpErrorPolicy = <Error extends SelfDescribingHttpError>(
	error: Error,
): PublicHttpErrorPolicy<Error, PublicHttpErrorStatusOf<Error>> =>
	publicHttpErrorDefinitionFor<Error>(error.constructor).policy

/** Read the tag and public policy owned by an error class. */
export function publicHttpErrorDefinitionFor<Error extends SelfDescribingHttpError>(
	errorClass: Function,
): PublicHttpErrorClassDefinition<Error, Error["_tag"], PublicHttpErrorStatusOf<Error>>
export function publicHttpErrorDefinitionFor<Error extends PublicTaggedError>(
	errorClass: Function,
): PublicHttpErrorClassDefinition<Error, Error["_tag"], PublicHttpErrorStatus>
export function publicHttpErrorDefinitionFor<Error extends PublicTaggedError>(
	errorClass: Function,
): PublicHttpErrorClassDefinition<Error, Error["_tag"], PublicHttpErrorStatus> {
	const definition = (
		errorClass as {
			readonly [PublicHttpErrorPolicyTypeId]?: PublicHttpErrorClassDefinition<
				Error,
				Error["_tag"],
				PublicHttpErrorStatus
			>
		}
	)[PublicHttpErrorPolicyTypeId]
	if (definition === undefined) throw new Error(`No public HTTP policy registered for ${errorClass.name}`)
	return definition
}

/** Read the public policy owned by an error class, including for wire-shaped presenters. */
export const publicHttpErrorPolicyFor = <Error extends PublicTaggedError>(
	errorClass: Function,
): PublicHttpErrorPolicy<Error, PublicHttpErrorStatus> =>
	publicHttpErrorDefinitionFor<Error>(errorClass).policy

const resolve = <Error, Value>(value: Value | ((error: Error) => Value), error: Error): Value =>
	typeof value === "function" ? (value as (error: Error) => Value)(error) : value

export const publicHttpErrorTypeForStatus = <const Status extends PublicHttpErrorStatus>(
	status: Status,
): PublicHttpErrorTypeForStatus<Status> => {
	switch (status) {
		case 400:
		case 413:
			return "invalid_request_error" as PublicHttpErrorTypeForStatus<Status>
		case 401:
			return "authentication_error" as PublicHttpErrorTypeForStatus<Status>
		case 402:
			return "payment_error" as PublicHttpErrorTypeForStatus<Status>
		case 403:
			return "permission_error" as PublicHttpErrorTypeForStatus<Status>
		case 404:
			return "not_found_error" as PublicHttpErrorTypeForStatus<Status>
		case 409:
			return "conflict_error" as PublicHttpErrorTypeForStatus<Status>
		case 429:
			return "rate_limit_error" as PublicHttpErrorTypeForStatus<Status>
		default:
			return "api_error" as PublicHttpErrorTypeForStatus<Status>
	}
}

/**
 * Materialize the safe public body owned by a tagged error. `HttpTaggedError`
 * installs it on the instance, so handlers can fail with the original tagged
 * error and let the endpoint schema serialize it directly.
 */
export const publicHttpErrorBody = <Error extends SelfDescribingHttpError>(
	error: Error,
): PublicHttpErrorBody<Error["_tag"], PublicHttpErrorStatusOf<Error>> => {
	const policy = publicHttpErrorPolicy(error)
	const retryAfterSeconds =
		policy.retryAfterSeconds === undefined ? undefined : resolve(policy.retryAfterSeconds, error)
	const retryAt = policy.retryAt === undefined ? undefined : resolve(policy.retryAt, error)
	const param = policy.param === undefined ? undefined : resolve(policy.param, error)

	return {
		_tag: error._tag,
		type: publicHttpErrorTypeForStatus(policy.status),
		code: resolve(policy.code, error),
		title: resolve(policy.title, error),
		message: policy.exposure === "public_message" ? error.message : resolve(policy.message, error),
		retryable: policy.retry !== "never",
		recovery: policy.recovery,
		...(!(retryAfterSeconds === undefined) ? { retry_after_seconds: retryAfterSeconds } : undefined),
		...(!(retryAt === undefined) ? { retry_at: retryAt } : undefined),
		...(!(param === undefined) ? { param } : undefined),
	}
}

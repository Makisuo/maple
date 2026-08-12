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

export type HttpErrorRetry = "never" | "backoff" | "after"
export type PublicHttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503 | 504

type ErrorValue<Error, Value> = Value | ((error: Error) => Value)

interface PublicHttpErrorPolicyBase<Error, Status extends PublicHttpErrorStatus> {
	readonly status: Status
	readonly code: ErrorValue<Error, string>
	readonly title: ErrorValue<Error, string>
	readonly retry: HttpErrorRetry
	readonly recovery: HttpErrorRecovery
	readonly param?: ErrorValue<Error, string | undefined>
	readonly retryAfterSeconds?: ErrorValue<Error, number | undefined>
	readonly retryAt?: ErrorValue<Error, string | undefined>
}

/** Public HTTP presentation owned by the tagged error class itself. */
export type PublicHttpErrorPolicy<Error, Status extends PublicHttpErrorStatus> =
	| (PublicHttpErrorPolicyBase<Error, Status> & {
			readonly exposure: "public_message"
	  })
	| (PublicHttpErrorPolicyBase<Error, Status> & {
			readonly exposure: "redacted"
			readonly message: ErrorValue<Error, string>
	  })

/** Type-level and runtime link from an error to its class-owned HTTP definition. */
export const PublicHttpErrorPolicyTypeId: unique symbol = Symbol.for("@maple/http/PublicHttpErrorPolicy")

export interface PublicHttpErrorDefinition<Tag extends string, Status extends PublicHttpErrorStatus> {
	readonly tag: Tag
	readonly status: Status
}

export interface WithPublicHttpErrorPolicy<Tag extends string, Status extends PublicHttpErrorStatus> {
	readonly [PublicHttpErrorPolicyTypeId]: PublicHttpErrorDefinition<Tag, Status>
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
		const Tag extends string,
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
		return Object.assign(ErrorClass, {
			[PublicHttpErrorPolicyTypeId]: { tag, policy },
		} as const)
	}

export const publicHttpErrorPolicy = <Error extends SelfDescribingHttpError>(
	error: Error,
): PublicHttpErrorPolicy<Error, PublicHttpErrorStatus> =>
	publicHttpErrorDefinitionFor(error.constructor).policy

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

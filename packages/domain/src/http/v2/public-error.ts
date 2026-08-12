import {
	publicHttpErrorDefinitionFor,
	publicHttpErrorPolicy,
	type PublicHttpErrorStatusOf,
	type SelfDescribingHttpErrorClass,
	type SelfDescribingHttpError,
} from "../error-policy"
import { Schema } from "effect"
import {
	authenticationError,
	conflict,
	gatewayTimeoutError,
	invalidRequest,
	makeV2ErrorSchema,
	notFoundError,
	payloadTooLargeError,
	permissionError,
	rateLimitError,
	serverError,
	serviceError,
	upstreamError,
	type V2ErrorForStatus,
	type V2ErrorTypeForStatus,
	type V2PublicError,
} from "./errors"

export type V2ErrorFor<Error extends SelfDescribingHttpError> = Error extends SelfDescribingHttpError
	? V2ErrorForStatus<PublicHttpErrorStatusOf<Error>> &
			V2PublicError<Error["_tag"], V2ErrorTypeForStatus<PublicHttpErrorStatusOf<Error>>>
	: never

export type V2ErrorEnvelopeFor<Error extends SelfDescribingHttpError> = Error extends SelfDescribingHttpError
	? V2PublicError<Error["_tag"], V2ErrorTypeForStatus<PublicHttpErrorStatusOf<Error>>>
	: never

export type V2PublicErrorSchema<Error extends SelfDescribingHttpError> = Schema.Codec<
	V2ErrorEnvelopeFor<Error>
>
const publicErrorSchemaCache = new WeakMap<Function, Schema.Top>()

/**
 * Project a self-describing domain error into its exact public wire schema.
 * The literal domain `_tag`, HTTP status, and envelope category all come from
 * the same `HttpTaggedError` definition used by `toV2Error` at runtime.
 */
export const publicError = <Error extends SelfDescribingHttpError>(
	errorClass: SelfDescribingHttpErrorClass<Error> & Schema.Schema<Error>,
): V2PublicErrorSchema<Error> => {
	const cached = publicErrorSchemaCache.get(errorClass)
	if (cached !== undefined) return cached as V2PublicErrorSchema<Error>
	const schema = makePublicErrorSchema<Error>(errorClass)
	publicErrorSchemaCache.set(errorClass, schema)
	return schema as unknown as V2PublicErrorSchema<Error>
}

/** Preserve every member of a class tuple as a distinct public error schema. */
export const publicErrors = <const Errors extends ReadonlyArray<SelfDescribingHttpError>>(
	...errorClasses: {
		readonly [Index in keyof Errors]: SelfDescribingHttpErrorClass<Errors[Index]> &
			Schema.Schema<Errors[Index]>
	}
): { readonly [Index in keyof Errors]: V2PublicErrorSchema<Errors[Index]> } =>
	errorClasses.map((errorClass) => publicError(errorClass)) as {
		readonly [Index in keyof Errors]: V2PublicErrorSchema<Errors[Index]>
	}

const makePublicErrorSchema = <Error extends SelfDescribingHttpError>(errorClass: Function) => {
	const { tag, policy } = publicHttpErrorDefinitionFor<Error>(errorClass)
	return makeV2ErrorSchema({
		tag,
		status: policy.status,
		identifier: errorClass.name,
		title: typeof policy.title === "string" ? policy.title : errorClass.name,
		description: `The ${tag} failure. HTTP ${policy.status}.`,
		...(typeof policy.code === "string" ? { codeExample: policy.code } : {}),
	})
}

const resolve = <Error, Value>(value: Value | ((error: Error) => Value), error: Error): Value =>
	typeof value === "function" ? (value as (error: Error) => Value)(error) : value

/** Serialize any self-describing tagged error into the uniform v2 envelope. */
export const toV2Error = <Error extends SelfDescribingHttpError>(error: Error): V2ErrorFor<Error> => {
	const policy = publicHttpErrorPolicy(error)
	const code = resolve(policy.code, error)
	const message = policy.exposure === "public_message" ? error.message : resolve(policy.message, error)
	const param = policy.param === undefined ? undefined : resolve(policy.param, error)
	const retryAfterSeconds =
		policy.retryAfterSeconds === undefined ? undefined : resolve(policy.retryAfterSeconds, error)
	const retryAt = policy.retryAt === undefined ? undefined : resolve(policy.retryAt, error)
	const metadata = {
		tag: error._tag,
		title: resolve(policy.title, error),
		retryable: policy.retry !== "never",
		recovery: policy.recovery,
		...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
		...(retryAt === undefined ? {} : { retryAt }),
	}

	switch (policy.status) {
		case 400:
			return invalidRequest(code, message, param, metadata) as V2ErrorFor<Error>
		case 401:
			return authenticationError(code, message, metadata) as V2ErrorFor<Error>
		case 403:
			return permissionError(code, message, metadata) as V2ErrorFor<Error>
		case 404:
			return notFoundError(code, message, param, metadata) as V2ErrorFor<Error>
		case 409:
			return conflict(code, message, metadata) as V2ErrorFor<Error>
		case 413:
			return payloadTooLargeError(code, message, param, metadata) as V2ErrorFor<Error>
		case 429:
			return rateLimitError(code, message, metadata) as V2ErrorFor<Error>
		case 500:
			return serverError(code, message, metadata) as V2ErrorFor<Error>
		case 502:
			return upstreamError(code, message, metadata) as V2ErrorFor<Error>
		case 503:
			return serviceError(code, message, metadata) as V2ErrorFor<Error>
		case 504:
			return gatewayTimeoutError(code, message, metadata) as V2ErrorFor<Error>
	}
}

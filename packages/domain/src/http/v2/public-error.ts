import {
	publicHttpErrorDefinitionFor,
	type PublicHttpErrorStatusOf,
	type SelfDescribingHttpErrorClass,
	type SelfDescribingHttpError,
} from "../error-policy"
import { Schema } from "effect"
import { makeV2ErrorSchema, type V2PublicError } from "./errors"

export type V2ErrorEnvelopeFor<Error extends SelfDescribingHttpError> = Error extends SelfDescribingHttpError
	? V2PublicError<Error["_tag"], PublicHttpErrorStatusOf<Error>>
	: never

export type V2PublicErrorSchema<Error extends SelfDescribingHttpError> = Schema.Codec<
	V2ErrorEnvelopeFor<Error>
>
const publicErrorSchemaCache = new WeakMap<Function, Schema.Top>()

/**
 * Project a self-describing domain error into its exact public wire schema.
 * The literal domain `_tag`, HTTP status, and envelope category all come from
 * the same `HttpTaggedError` definition that exposes the runtime wire body.
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
	})
}

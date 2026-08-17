import {
	makeExactPublicHttpErrorBodySchema,
	publicHttpErrorDefinitionFor,
	publicHttpErrorTypeForStatus,
	type PublicHttpErrorBody,
	type PublicHttpErrorStatusOf,
	type SelfDescribingHttpErrorClass,
	type SelfDescribingHttpError,
} from "../error-policy"
import { Schema } from "effect"

export type V2ErrorEnvelopeFor<Error extends SelfDescribingHttpError> = Error extends SelfDescribingHttpError
	? { readonly error: PublicHttpErrorBody<Error["_tag"], PublicHttpErrorStatusOf<Error>> }
	: never

export type V2PublicErrorSchema<Error extends SelfDescribingHttpError> = Schema.Codec<
	V2ErrorEnvelopeFor<Error>
>
const publicErrorSchemaCache = new WeakMap<Function, Schema.Top>()

export interface PublicErrorSchemaOptions {
	readonly identifier?: string
	readonly title?: string
	readonly description?: string
}

/**
 * Project a self-describing domain error into its exact public wire schema.
 * The literal domain `_tag`, HTTP status, and envelope category all come from
 * the same `HttpTaggedError` definition that exposes the runtime wire body.
 */
export const publicError = <Error extends SelfDescribingHttpError>(
	errorClass: SelfDescribingHttpErrorClass<Error> & Schema.Schema<Error>,
	options?: PublicErrorSchemaOptions,
): V2PublicErrorSchema<Error> => {
	if (options === undefined) {
		const cached = publicErrorSchemaCache.get(errorClass)
		if (cached !== undefined) return cached as V2PublicErrorSchema<Error>
	}
	const schema = makePublicErrorSchema<Error>(errorClass, options)
	if (options === undefined) publicErrorSchemaCache.set(errorClass, schema)
	// SAFETY: makePublicErrorSchema derives this schema from the same error class generic returned here.
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

const makePublicErrorSchema = <Error extends SelfDescribingHttpError>(
	errorClass: Function,
	options?: PublicErrorSchemaOptions,
) => {
	const { tag, policy } = publicHttpErrorDefinitionFor<Error>(errorClass)
	const type = publicHttpErrorTypeForStatus(policy.status)
	return Schema.Struct({
		error: makeExactPublicHttpErrorBodySchema(
			Schema.Literal(tag).annotate({
				description: "Stable semantic error tag. Branch on this exact value.",
			}),
			Schema.Literal(type).annotate({
				description: "Broad error category shared by related semantic tags.",
			}),
			policy,
		),
	}).annotate({
		httpApiStatus: policy.status,
		identifier: options?.identifier ?? errorClass.name,
		title: options?.title ?? (typeof policy.title === "string" ? policy.title : errorClass.name),
		description: options?.description ?? `The ${tag} failure. HTTP ${policy.status}.`,
	})
}

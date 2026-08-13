import { Schema } from "effect"

export const MaplePublicErrorType = Schema.Literals([
	"invalid_request_error",
	"authentication_error",
	"permission_error",
	"not_found_error",
	"conflict_error",
	"rate_limit_error",
	"api_error",
])

export const MapleErrorRecovery = Schema.Literals([
	"none",
	"fix_request",
	"reauthenticate",
	"request_access",
	"reconnect",
	"refresh",
	"retry",
	"contact_support",
])

/** Published mirror of Maple's canonical v2 error body. Kept honest by the domain contract test. */
export const MaplePublicErrorBodySchema = Schema.Struct({
	_tag: Schema.String.check(Schema.isPattern(/^@maple\//)),
	type: MaplePublicErrorType,
	code: Schema.String,
	title: Schema.String,
	message: Schema.String,
	retryable: Schema.Boolean,
	recovery: MapleErrorRecovery,
	retry_after_seconds: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
	retry_at: Schema.optionalKey(
		Schema.String.check(
			Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value)), {
				description: "Expected an ISO date-time string",
			}),
		),
	),
	param: Schema.optionalKey(Schema.String),
	doc_url: Schema.optionalKey(Schema.String),
})
export type MaplePublicErrorBody = Schema.Schema.Type<typeof MaplePublicErrorBodySchema>

/** A declared v2 API failure whose Effect tag is the exact server tag. */
export interface MapleApiResponseError<Tag extends string = string> extends Error {
	readonly _tag: Tag
	readonly status: number
	readonly error: MaplePublicErrorBody & { readonly _tag: Tag }
}

type MapleApiResponseErrorConstructor = new (fields: {
	readonly status: number
	readonly error: MaplePublicErrorBody
}) => MapleApiResponseError

const responseErrorClasses = new Map<string, MapleApiResponseErrorConstructor>()

/** Build a real Schema.TaggedError class per public server tag, cached for reuse. */
export const makeMapleApiResponseError = (
	status: number,
	error: MaplePublicErrorBody,
): MapleApiResponseError => {
	let ErrorClass = responseErrorClasses.get(error._tag)
	if (ErrorClass === undefined) {
		class TaggedResponseError extends Schema.TaggedError<TaggedResponseError>()(error._tag, {
			status: Schema.Number,
			error: MaplePublicErrorBodySchema,
		}) {
			override get message(): string {
				return this.error.message
			}
		}
		ErrorClass = TaggedResponseError
		responseErrorClasses.set(error._tag, ErrorClass)
	}
	return new ErrorClass({ status, error })
}

/** A client-side transport, encoding, body-read, or protocol failure. */
export class MapleApiClientError extends Schema.TaggedError<MapleApiClientError>()(
	"@maple/alchemy/errors/ApiClientError",
	{
		status: Schema.Number,
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export type MapleError = MapleApiResponseError | MapleApiClientError

export const isMapleApiResponseError = (error: MapleError): error is MapleApiResponseError =>
	error._tag !== "@maple/alchemy/errors/ApiClientError"

import { Schema } from "effect"

export const MaplePublicErrorType = Schema.Literals([
	"invalid_request_error",
	"authentication_error",
	"payment_error",
	"permission_error",
	"not_found_error",
	"conflict_error",
	"rate_limit_error",
	"api_error",
])
export type MaplePublicErrorType = Schema.Schema.Type<typeof MaplePublicErrorType>

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

/** Public HTTP tags are disjoint from this package's client-side error tags. */
export const MapleHttpErrorTagSchema = Schema.TemplateLiteral(["@maple/http/", Schema.String])
export type MapleHttpErrorTag = Schema.Schema.Type<typeof MapleHttpErrorTagSchema>

/** Stable tags used for provider lifecycle decisions. */
export const MapleErrorTags = {
	apiKeyNotFound: "@maple/http/errors/ApiKeyNotFoundError",
	dashboardNotFound: "@maple/http/errors/DashboardNotFoundError",
	alertRuleNotFound: "@maple/http/errors/AlertRuleNotFoundError",
	alertDestinationNotFound: "@maple/http/errors/AlertDestinationNotFoundError",
} as const satisfies Record<string, MapleHttpErrorTag>

/** Published mirror of Maple's canonical v2 error body. Kept honest by contract tests. */
export const MaplePublicErrorBodySchema = Schema.Struct({
	_tag: MapleHttpErrorTagSchema,
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
})
export type MaplePublicErrorBody = Schema.Schema.Type<typeof MaplePublicErrorBodySchema>

const MapleApiResponseErrorBrand: unique symbol = Symbol("MapleApiResponseError")

/** A declared v2 API failure whose Effect tag is the exact server tag. */
export interface MapleApiResponseError<Tag extends MapleHttpErrorTag = MapleHttpErrorTag> extends Error {
	readonly _tag: Tag
	readonly status: number
	readonly error: MaplePublicErrorBody & { readonly _tag: Tag }
	readonly [MapleApiResponseErrorBrand]: true
}

/** Construct an exact tagged failure without caching classes from untrusted input. */
export const makeMapleApiResponseError = <const Tag extends MapleHttpErrorTag>(
	status: number,
	error: MaplePublicErrorBody & { readonly _tag: Tag },
): MapleApiResponseError<Tag> => {
	class TaggedResponseError extends Schema.TaggedError<TaggedResponseError>()(error._tag, {
		status: Schema.Number,
		error: MaplePublicErrorBodySchema,
	}) {
		readonly [MapleApiResponseErrorBrand] = true as const

		override get message(): string {
			return this.error.message
		}
	}
	// SAFETY: TaggedResponseError carries the branded body and tag supplied to this factory.
	return new TaggedResponseError({ status, error }) as unknown as MapleApiResponseError<Tag>
}

export class MapleApiRequestEncodingError extends Schema.TaggedError<MapleApiRequestEncodingError>()(
	"@maple/alchemy/errors/RequestEncodingError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

export class MapleApiTransportError extends Schema.TaggedError<MapleApiTransportError>()(
	"@maple/alchemy/errors/TransportError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

export class MapleApiResponseReadError extends Schema.TaggedError<MapleApiResponseReadError>()(
	"@maple/alchemy/errors/ResponseReadError",
	{ status: Schema.Number, message: Schema.String, cause: Schema.Defect() },
) {}

export class MapleApiResponseDecodeError extends Schema.TaggedError<MapleApiResponseDecodeError>()(
	"@maple/alchemy/errors/ResponseDecodeError",
	{ status: Schema.Number, message: Schema.String },
) {}

export class MapleApiProtocolError extends Schema.TaggedError<MapleApiProtocolError>()(
	"@maple/alchemy/errors/ProtocolError",
	{ status: Schema.Number, message: Schema.String },
) {}

export type MapleClientError =
	| MapleApiRequestEncodingError
	| MapleApiTransportError
	| MapleApiResponseReadError
	| MapleApiResponseDecodeError
	| MapleApiProtocolError

export type MapleError = MapleApiResponseError | MapleClientError

export const isMapleApiResponseError = (error: MapleError): error is MapleApiResponseError =>
	MapleApiResponseErrorBrand in error && error[MapleApiResponseErrorBrand] === true

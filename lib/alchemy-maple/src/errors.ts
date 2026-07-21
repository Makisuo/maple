import { Schema } from "effect"

/**
 * Typed failures surfaced by the Maple API client. The v2 error envelope is
 * `{ error: { type, code, message, param? } }`; the client maps well-known
 * statuses to dedicated tags so providers can `catchTag` (404 → adopt/recreate,
 * 409 → adopt-by-name) and leaves everything else on `MapleApiError`.
 */

const errorFields = {
	status: Schema.Number,
	message: Schema.String,
	/** The v2 envelope `error.type`, when the body carried one. */
	errorType: Schema.optionalKey(Schema.String),
	/** The v2 envelope `error.code`, when the body carried one. */
	code: Schema.optionalKey(Schema.String),
}

export class MapleApiError extends Schema.TaggedErrorClass<MapleApiError>()("Maple::ApiError", errorFields) {}

export class MapleNotFoundError extends Schema.TaggedErrorClass<MapleNotFoundError>()(
	"Maple::NotFoundError",
	errorFields,
) {}

export class MapleConflictError extends Schema.TaggedErrorClass<MapleConflictError>()(
	"Maple::ConflictError",
	errorFields,
) {}

export class MapleUnauthorizedError extends Schema.TaggedErrorClass<MapleUnauthorizedError>()(
	"Maple::UnauthorizedError",
	errorFields,
) {}

export type MapleError = MapleApiError | MapleNotFoundError | MapleConflictError | MapleUnauthorizedError

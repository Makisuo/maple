import { Schema } from "effect"

/**
 * Shared v2 wire-format primitives (see docs/api-v2.md).
 *
 * v2 responses use snake_case field names, ISO-8601 UTC timestamps, an
 * `object` type field on every resource, and the Stripe list envelope
 * `{ object: "list", data, has_more, next_cursor }` on every list endpoint.
 */

/** ISO-8601 UTC timestamp on the v2 wire (e.g. `2026-07-15T12:34:56.000Z`). */
export const Timestamp = Schema.String.annotate({
	title: "Timestamp",
	description: "ISO-8601 UTC timestamp",
})

/** Convert service-layer epoch-ms to the v2 wire timestamp. */
export const isoTimestamp = (epochMs: number): string => new Date(epochMs).toISOString()

export const isoTimestampOrNull = (epochMs: number | null | undefined): string | null =>
	epochMs == null ? null : isoTimestamp(epochMs)

export const LIST_LIMIT_DEFAULT = 20
export const LIST_LIMIT_MAX = 100

/** Standard pagination query params for every v2 list endpoint. */
export const ListQuery = Schema.Struct({
	limit: Schema.optional(
		Schema.NumberFromString.check(
			Schema.isInt(),
			Schema.isBetween({ minimum: 1, maximum: LIST_LIMIT_MAX }),
		),
	),
	cursor: Schema.optional(Schema.String),
})
export type ListQuery = Schema.Schema.Type<typeof ListQuery>

/** Stripe-style list envelope: `{ object: "list", data, has_more, next_cursor }`. */
export const ListOf = <S extends Schema.Top>(item: S) =>
	Schema.Struct({
		object: Schema.Literal("list"),
		data: Schema.Array(item),
		has_more: Schema.Boolean,
		next_cursor: Schema.NullOr(Schema.String),
	})

/**
 * Opaque offset cursor for lists whose backing service returns full arrays.
 * Endpoints backed by native keyset pagination use their own cursor payloads —
 * the wire contract (`cursor` in, `next_cursor` out) is identical either way.
 */
export const encodeOffsetCursor = (offset: number): string => `off_${offset.toString(36)}`

export const decodeOffsetCursor = (cursor: string): number | null => {
	if (!cursor.startsWith("off_")) return null
	const offset = Number.parseInt(cursor.slice(4), 36)
	return Number.isInteger(offset) && offset >= 0 ? offset : null
}

/** Paginate an already-materialized array into the list envelope. */
export const paginateArray = <T>(
	items: ReadonlyArray<T>,
	query: { readonly limit?: number | undefined; readonly cursor?: string | undefined },
): { data: ReadonlyArray<T>; has_more: boolean; next_cursor: string | null } => {
	const limit = query.limit ?? LIST_LIMIT_DEFAULT
	const offset = query.cursor === undefined ? 0 : (decodeOffsetCursor(query.cursor) ?? 0)
	const data = items.slice(offset, offset + limit)
	const hasMore = offset + limit < items.length
	return {
		data,
		has_more: hasMore,
		next_cursor: hasMore ? encodeOffsetCursor(offset + limit) : null,
	}
}

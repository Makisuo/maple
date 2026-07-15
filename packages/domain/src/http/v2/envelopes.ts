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
	description: "ISO-8601 UTC timestamp, e.g. `2026-07-15T12:34:56.000Z`.",
	examples: ["2026-07-15T12:34:56.000Z"],
	format: "date-time",
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
		).annotate({
			title: "Limit",
			description: `Maximum number of objects to return, between 1 and ${LIST_LIMIT_MAX}. Defaults to ${LIST_LIMIT_DEFAULT}.`,
			examples: [LIST_LIMIT_DEFAULT],
		}),
	),
	cursor: Schema.optional(
		Schema.String.annotate({
			title: "Cursor",
			description:
				"Opaque pagination cursor. Pass the `next_cursor` from a previous response to fetch the following page. Omit for the first page.",
			examples: ["off_1k"],
		}),
	),
}).annotate({
	identifier: "ListQuery",
	title: "List query",
	description: "Cursor-pagination query parameters shared by every v2 list endpoint.",
})
export type ListQuery = Schema.Schema.Type<typeof ListQuery>

/** Stripe-style list envelope: `{ object: "list", data, has_more, next_cursor }`. */
export const ListOf = <S extends Schema.Top>(item: S) =>
	Schema.Struct({
		object: Schema.Literal("list").annotate({
			description: 'Always `"list"` for a list response.',
			examples: ["list"],
		}),
		data: Schema.Array(item).annotate({
			description: "The page of objects, newest first.",
		}),
		has_more: Schema.Boolean.annotate({
			description: "Whether more objects exist after this page. When `true`, use `next_cursor` to fetch them.",
			examples: [true],
		}),
		next_cursor: Schema.NullOr(Schema.String).annotate({
			description: "Cursor for the next page, or `null` on the last page. Pass it back as the `cursor` query param.",
			examples: ["off_1k"],
		}),
	}).annotate({
		title: "List",
		description: "Cursor-paginated list envelope wrapping a page of objects.",
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

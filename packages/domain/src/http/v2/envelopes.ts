import { Effect, Schema } from "effect"
import { invalidRequest } from "./errors"

/**
 * Shared v2 wire-format primitives (see docs/api-v2.md).
 *
 * v2 responses use snake_case field names, ISO-8601 UTC timestamps, an
 * `object` type field on every resource, and the Stripe list envelope
 * `{ object: "list", data, has_more, next_cursor }` on every list endpoint.
 */

/** ISO-8601 UTC timestamp on the v2 wire (e.g. `2026-07-15T12:34:56.000Z`). */
const ISO_8601_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]00:00)$/

export const Timestamp = Schema.String.pipe(
	Schema.check(
		Schema.makeFilter((value) => ISO_8601_UTC_PATTERN.test(value) && Number.isFinite(Date.parse(value)), {
			description: "Expected an ISO-8601 UTC timestamp",
		}),
	),
	Schema.annotate({
		title: "Timestamp",
		description: "ISO-8601 UTC timestamp, e.g. `2026-07-15T12:34:56.000Z`.",
		examples: ["2026-07-15T12:34:56.000Z"],
		format: "date-time",
	}),
)
export type Timestamp = Schema.Schema.Type<typeof Timestamp>

/** Brand a service-layer ISO value for the strict v2 timestamp wire schema. */
export const timestamp = (value: string): Timestamp => Timestamp.make(value)

export const timestampOrNull = (value: string | null | undefined): Timestamp | null =>
	value == null ? null : timestamp(value)

/** Convert service-layer epoch-ms to the v2 wire timestamp. */
export const isoTimestamp = (epochMs: number): Timestamp => timestamp(new Date(epochMs).toISOString())

export const isoTimestampOrNull = (epochMs: number | null | undefined): Timestamp | null =>
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
			description: "The page of objects, in the ordering documented by the endpoint.",
		}),
		has_more: Schema.Boolean.annotate({
			description:
				"Whether more objects exist after this page. When `true`, use `next_cursor` to fetch them.",
			examples: [true],
		}),
		next_cursor: Schema.NullOr(Schema.String).annotate({
			description:
				"Cursor for the next page, or `null` on the last page. Pass it back as the `cursor` query param.",
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
	const match = /^off_([0-9a-z]+)$/.exec(cursor)
	if (match === null) return null
	const offset = Number.parseInt(match[1]!, 36)
	return Number.isSafeInteger(offset) && offset >= 0 ? offset : null
}

/** Decode an optional offset cursor, failing with the standard v2 400 envelope. */
export const decodeOffsetCursorEffect = (cursor: string | undefined) => {
	if (cursor === undefined) return Effect.succeed(0)
	const offset = decodeOffsetCursor(cursor)
	return offset === null
		? Effect.fail(invalidRequest("parameter_invalid", "Invalid pagination cursor.", "cursor"))
		: Effect.succeed(offset)
}

export interface OffsetPage {
	readonly limit: number
	readonly offset: number
}

/** Resolve the shared list query into a page request for the backing store. */
export const decodeOffsetPage = (query: {
	readonly limit?: number | undefined
	readonly cursor?: string | undefined
}) =>
	Effect.map(
		decodeOffsetCursorEffect(query.cursor),
		(offset): OffsetPage => ({
			limit: query.limit ?? LIST_LIMIT_DEFAULT,
			offset,
		}),
	)

/** Build a list page from a `limit + 1` lookahead result. */
export const pageFromLookahead = <T>(items: ReadonlyArray<T>, page: OffsetPage) => {
	const hasMore = items.length > page.limit
	return {
		data: hasMore ? items.slice(0, page.limit) : items,
		has_more: hasMore,
		next_cursor: hasMore ? encodeOffsetCursor(page.offset + page.limit) : null,
	}
}

/**
 * Run an offset-backed list query with one-row lookahead and build the uniform
 * v2 list envelope fields. Backing stores receive the only pagination policy
 * they should need: `limit + 1` plus the decoded offset.
 */
export const paginateOffsetQuery = <T, E, R>(
	query: { readonly limit?: number | undefined; readonly cursor?: string | undefined },
	fetch: (page: {
		readonly limit: number
		readonly offset: number
	}) => Effect.Effect<ReadonlyArray<T>, E, R>,
) =>
	Effect.gen(function* () {
		const page = yield* decodeOffsetPage(query)
		const items = yield* fetch({ limit: page.limit + 1, offset: page.offset })
		return pageFromLookahead(items, page)
	})

/** Paginate an already-materialized array into the list envelope. */
export const paginateArray = <T>(
	items: ReadonlyArray<T>,
	query: { readonly limit?: number | undefined; readonly cursor?: string | undefined },
) =>
	Effect.map(decodeOffsetPage(query), (page) => {
		const { limit, offset } = page
		const data = items.slice(offset, offset + limit)
		const hasMore = offset + limit < items.length
		return {
			data,
			has_more: hasMore,
			next_cursor: hasMore ? encodeOffsetCursor(offset + limit) : null,
		}
	})

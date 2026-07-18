import { Effect, Schema } from "effect"

export interface V2Page<T> {
	readonly data: ReadonlyArray<T>
	readonly has_more: boolean
	readonly next_cursor: string | null
}

export class V2PaginationCursorLoopError extends Schema.TaggedErrorClass<V2PaginationCursorLoopError>()(
	"@maple/web/services/V2PaginationCursorLoopError",
	{
		cursor: Schema.String,
	},
) {}

/** Collect every page from a v2 list without imposing a hidden client-side cap. */
export const collectV2Pages = <T, E, R>(
	fetchPage: (cursor: string | undefined) => Effect.Effect<V2Page<T>, E, R>,
) =>
	Effect.gen(function* () {
		const data: T[] = []
		const seenCursors = new Set<string>()
		let cursor: string | undefined

		while (true) {
			const response = yield* fetchPage(cursor)
			data.push(...response.data)

			if (!response.has_more || response.next_cursor === null) return data
			if (seenCursors.has(response.next_cursor)) {
				return yield* new V2PaginationCursorLoopError({ cursor: response.next_cursor })
			}

			seenCursors.add(response.next_cursor)
			cursor = response.next_cursor
		}
	})

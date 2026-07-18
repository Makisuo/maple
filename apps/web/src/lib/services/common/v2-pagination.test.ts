import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { collectV2Pages } from "./v2-pagination"

describe("collectV2Pages", () => {
	it("collects every page without an item cap", async () => {
		const itemCount = 2_005
		const pageSize = 100

		const result = await Effect.runPromise(
			collectV2Pages((cursor) => {
				const offset = cursor === undefined ? 0 : Number(cursor)
				const data = Array.from(
					{ length: Math.min(pageSize, itemCount - offset) },
					(_, index) => offset + index,
				)
				const nextOffset = offset + data.length
				return Effect.succeed({
					data,
					has_more: nextOffset < itemCount,
					next_cursor: nextOffset < itemCount ? String(nextOffset) : null,
				})
			}),
		)

		expect(result).toHaveLength(itemCount)
		expect(result[0]).toBe(0)
		expect(result.at(-1)).toBe(itemCount - 1)
	})

	it("fails with a specific tag when a cursor repeats", async () => {
		const error = await Effect.runPromise(
			Effect.flip(
				collectV2Pages(() => Effect.succeed({ data: [1], has_more: true, next_cursor: "off_1" })),
			),
		)

		expect(error._tag).toBe("@maple/web/services/V2PaginationCursorLoopError")
		expect(error.cursor).toBe("off_1")
	})
})

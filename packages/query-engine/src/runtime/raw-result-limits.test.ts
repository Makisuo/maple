import { describe, expect, it } from "vitest"
import {
	MAX_RAW_SQL_CELL_LENGTH,
	MAX_RAW_SQL_RESULT_BYTES,
	MAX_RAW_SQL_RESULT_ROWS,
} from "@maple/domain/http"
import { rawSqlResultLimitError } from "./raw-result-limits"

describe("rawSqlResultLimitError", () => {
	it("accepts bounded JSON rows", () => {
		expect(rawSqlResultLimitError([{ value: 1 }, { value: "ok" }])).toBeNull()
	})

	it("rejects excessive rows, cells, and encoded bytes", () => {
		expect(
			rawSqlResultLimitError(
				Array.from({ length: MAX_RAW_SQL_RESULT_ROWS + 1 }, (_, value) => ({ value })),
			),
		).toContain("rows")
		expect(rawSqlResultLimitError([{ value: "x".repeat(MAX_RAW_SQL_CELL_LENGTH + 1) }])).toContain(
			"cells",
		)
		expect(
			rawSqlResultLimitError(
				Array.from({ length: 100 }, (_, value) => ({
					value,
					payload: "x".repeat(Math.ceil(MAX_RAW_SQL_RESULT_BYTES / 100)),
				})),
			),
		).toContain("bytes")
	})
})

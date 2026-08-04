import { describe, expect, it } from "vitest"
import { pickValueField, toBreakdownRows } from "../breakdown-rows"

describe("pickValueField", () => {
	it("picks the first numeric column that isn't the label", () => {
		expect(pickValueField([{ name: "api", count: 12, other: 3 }])).toBe("count")
	})

	it("falls back to `value` for an empty or all-string result", () => {
		expect(pickValueField([])).toBe("value")
		expect(pickValueField([{ name: "api", label: "x" }])).toBe("value")
	})
})

describe("toBreakdownRows", () => {
	it("labels a blank group rather than dropping it", () => {
		const rows = toBreakdownRows([{ name: "  ", value: 4 }], "value")
		expect(rows).toEqual([{ name: "(no value)", unnamed: true, value: 4 }])
	})

	it("coerces string values and treats non-numbers as zero", () => {
		// 64-bit ints arrive as strings on BYO-ClickHouse.
		const rows = toBreakdownRows([{ name: "api", value: "87200000" }, { name: "web" }], "value")
		expect(rows.map((r) => r.value)).toEqual([87_200_000, 0])
	})

	it("aggregates timeseries-shaped input per series instead of per bucket (MAP-49)", () => {
		const source = [
			{ bucket: "2026-01-01T00:00:00Z", A: 10, B: 1 },
			{ bucket: "2026-01-01T01:00:00Z", A: 5, B: 2 },
		]
		expect(toBreakdownRows(source, "value")).toEqual([
			{ name: "A", unnamed: false, value: 15 },
			{ name: "B", unnamed: false, value: 3 },
		])
	})
})

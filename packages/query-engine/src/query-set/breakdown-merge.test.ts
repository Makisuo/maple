import { describe, expect, it } from "vitest"
import { type BreakdownQueryResult, mergeBreakdownResults, toDisplayName } from "./breakdown-merge"

const queryDraft = (id: string, name: string, legend: string) => ({ id, name, legend })

const result = (
	queryId: string,
	queryName: string,
	data: Array<{ name: string; value: number }>,
): BreakdownQueryResult => ({
	queryId,
	queryName,
	status: "success",
	error: null,
	data,
})

describe("toDisplayName", () => {
	it("prefers a non-blank legend over the name", () => {
		expect(toDisplayName({ name: "A", legend: "Errors" })).toBe("Errors")
		expect(toDisplayName({ name: "A", legend: "  " })).toBe("A")
		expect(toDisplayName({ name: "A" })).toBe("A")
	})
})

describe("mergeBreakdownResults", () => {
	it("uses query legends as merged column names, so heatmap axes read 'Errors'/'OK' instead of 'A'/'B'", () => {
		const rows = mergeBreakdownResults(
			[
				result("q-a", "A", [{ name: "demo-api", value: 12 }]),
				result("q-b", "B", [
					{ name: "demo-api", value: 480 },
					{ name: "demo-worker", value: 210 },
				]),
			],
			[queryDraft("q-a", "A", "Errors"), queryDraft("q-b", "B", "OK")],
		)

		expect(rows).toContainEqual({ name: "demo-api", Errors: 12, OK: 480 })
		expect(rows).toContainEqual({ name: "demo-worker", Errors: 0, OK: 210 })
	})

	it("falls back to the query name when no legend is set", () => {
		const rows = mergeBreakdownResults(
			[result("q-a", "A", [{ name: "x", value: 1 }]), result("q-b", "B", [{ name: "x", value: 2 }])],
			[queryDraft("q-a", "A", ""), queryDraft("q-b", "B", "")],
		)

		expect(rows).toEqual([{ name: "x", A: 1, B: 2 }])
	})

	/**
	 * A single query keeps the narrow `{name, value}` shape. Widening it to the
	 * multi-query column shape would change what every pie and bar chart receives,
	 * which is why this merge is not folded into the timeseries one.
	 */
	it("returns bare name/value rows for a single query, sorted descending", () => {
		const rows = mergeBreakdownResults(
			[
				result("q-a", "A", [
					{ name: "small", value: 1 },
					{ name: "big", value: 9 },
				]),
			],
			[queryDraft("q-a", "A", "Errors")],
		)

		expect(rows).toEqual([
			{ name: "big", value: 9 },
			{ name: "small", value: 1 },
		])
	})

	it("orders multi-query rows by the first query's values", () => {
		const rows = mergeBreakdownResults(
			[
				result("q-a", "A", [
					{ name: "low", value: 1 },
					{ name: "high", value: 100 },
				]),
				result("q-b", "B", [
					{ name: "low", value: 999 },
					{ name: "high", value: 2 },
				]),
			],
			[queryDraft("q-a", "A", ""), queryDraft("q-b", "B", "")],
		)

		expect(rows.map((row) => row.name)).toEqual(["high", "low"])
	})

	it("ignores failed and empty results", () => {
		const rows = mergeBreakdownResults(
			[
				{ queryId: "q-a", queryName: "A", status: "error", error: "boom", data: [] },
				result("q-b", "B", [{ name: "x", value: 2 }]),
			],
			[queryDraft("q-a", "A", ""), queryDraft("q-b", "B", "")],
		)

		// Only one successful result survives, so it takes the narrow shape.
		expect(rows).toEqual([{ name: "x", value: 2 }])
	})

	it("returns nothing when no query succeeded with data", () => {
		expect(
			mergeBreakdownResults(
				[{ queryId: "q-a", queryName: "A", status: "error", error: "boom", data: [] }],
				[queryDraft("q-a", "A", "")],
			),
		).toEqual([])
	})
})

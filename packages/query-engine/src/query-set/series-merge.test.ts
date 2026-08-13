import { describe, expect, it } from "vitest"
import type { QueryRunResult } from "../formula-results"
import {
	appendPercentChangeSeries,
	collectHiddenResultIds,
	combineRows,
	countSuccessfulQuerySeries,
	hasAnySeriesData,
	mergeQueryRunResults,
	shiftResultPoints,
	shiftRunResults,
	toDisplayNameById,
} from "./series-merge"

function makeQueryResult(overrides: Partial<QueryRunResult> = {}): QueryRunResult {
	return {
		queryId: "q-1",
		queryName: "A",
		source: "traces",
		status: "success",
		error: null,
		warnings: [],
		data: [],
		...overrides,
	}
}

describe("hasAnySeriesData / countSuccessfulQuerySeries", () => {
	it("treats an empty series map as no data", () => {
		expect(hasAnySeriesData([{ bucket: "b", series: {} }])).toBe(false)
		expect(hasAnySeriesData([{ bucket: "b", series: { total: 0 } }])).toBe(true)
	})

	it("counts only query results with real series data", () => {
		const count = countSuccessfulQuerySeries([
			makeQueryResult({ data: [{ bucket: "2026-01-01T00:00:00.000Z", series: {} }] }),
			makeQueryResult({
				queryId: "q-2",
				queryName: "B",
				data: [{ bucket: "2026-01-01T00:00:00.000Z", series: { total: 1 } }],
			}),
		])

		expect(count).toBe(1)
	})
})

describe("toDisplayNameById", () => {
	it("prefers a non-blank legend over the name", () => {
		const map = toDisplayNameById([
			{ id: "a", name: "Query A", legend: "Errors" },
			{ id: "b", name: "Query B", legend: "   " },
			{ id: "c", name: "Query C" },
		])

		expect(map.get("a")).toBe("Errors")
		expect(map.get("b")).toBe("Query B")
		expect(map.get("c")).toBe("Query C")
	})
})

describe("mergeQueryRunResults", () => {
	it("preserves grouped series instead of summing them per query", () => {
		const merged = mergeQueryRunResults(
			[
				makeQueryResult({
					queryId: "q-1",
					queryName: "A",
					data: [
						{ bucket: "2026-01-01T00:00:00.000Z", series: { checkout: 2, billing: 1 } },
						{ bucket: "2026-01-01T00:05:00.000Z", series: { checkout: 4 } },
					],
				}),
				makeQueryResult({
					queryId: "q-2",
					queryName: "B",
					data: [
						{ bucket: "2026-01-01T00:00:00.000Z", series: { checkout: 5 } },
						{ bucket: "2026-01-01T00:05:00.000Z", series: { checkout: 7 } },
					],
				}),
			],
			new Map([
				["q-1", "Errors"],
				["q-2", "Throughput"],
			]),
		)

		expect(merged.seriesNames).toEqual(["Errors: checkout", "Errors: billing", "Throughput: checkout"])

		expect(merged.rowsByBucket.get("2026-01-01T00:00:00.000Z")).toEqual({
			bucket: "2026-01-01T00:00:00.000Z",
			"Errors: checkout": 2,
			"Errors: billing": 1,
			"Throughput: checkout": 5,
		})
		// Zero-filled: `Errors: billing` has no row in the second bucket, and a gap
		// would read as missing data rather than as no events.
		expect(merged.rowsByBucket.get("2026-01-01T00:05:00.000Z")).toEqual({
			bucket: "2026-01-01T00:05:00.000Z",
			"Errors: checkout": 4,
			"Errors: billing": 0,
			"Throughput: checkout": 7,
		})
	})

	it("keeps non-grouped 'all' series as the display name", () => {
		const merged = mergeQueryRunResults(
			[
				makeQueryResult({
					queryId: "q-1",
					queryName: "A",
					data: [{ bucket: "2026-01-01T00:00:00.000Z", series: { all: 12 } }],
				}),
			],
			new Map([["q-1", "Requests"]]),
		)

		expect(merged.seriesNames).toEqual(["Requests"])
		expect(merged.rowsByBucket.get("2026-01-01T00:00:00.000Z")).toEqual({
			bucket: "2026-01-01T00:00:00.000Z",
			Requests: 12,
		})
	})

	it("recognises the ungrouped key case-insensitively", () => {
		const merged = mergeQueryRunResults(
			[
				makeQueryResult({
					queryId: "q-1",
					data: [{ bucket: "2026-01-01T00:00:00.000Z", series: { All: 3 } }],
				}),
			],
			new Map([["q-1", "Requests"]]),
		)

		expect(merged.seriesNames).toEqual(["Requests"])
	})

	it("keeps formula series labels without redundant namespacing", () => {
		const merged = mergeQueryRunResults(
			[
				makeQueryResult({
					queryId: "f-1",
					queryName: "F1",
					source: "formula",
					data: [{ bucket: "2026-01-01T00:00:00.000Z", series: { "Error ratio": 0.3 } }],
				}),
			],
			new Map([["f-1", "Error ratio"]]),
		)

		expect(merged.seriesNames).toEqual(["Error ratio"])
		expect(merged.rowsByBucket.get("2026-01-01T00:00:00.000Z")).toEqual({
			bucket: "2026-01-01T00:00:00.000Z",
			"Error ratio": 0.3,
		})
	})

	it("skips non-finite values rather than writing NaN into a row", () => {
		const merged = mergeQueryRunResults(
			[
				makeQueryResult({
					queryId: "q-1",
					data: [
						{
							bucket: "2026-01-01T00:00:00.000Z",
							series: { good: 1, bad: Number.NaN, worse: Number.POSITIVE_INFINITY },
						},
					],
				}),
			],
			new Map([["q-1", "A"]]),
		)

		expect(merged.seriesNames).toEqual(["good"])
	})

	/**
	 * The shared `usedSeriesNames` set is what keeps the previous-period window
	 * from claiming a name the current window already took. It also makes these
	 * two calls ORDER-DEPENDENT, which is the property this asserts: merge the
	 * current window first, or ` (prev)` series would take the unsuffixed names.
	 */
	it("does not let a second merge reuse the first merge's series names", () => {
		const usedSeriesNames = new Set<string>()
		const displayNameById = new Map([["q-1", "Requests"]])
		const result = makeQueryResult({
			queryId: "q-1",
			data: [{ bucket: "2026-01-01T00:00:00.000Z", series: { all: 1 } }],
		})

		const current = mergeQueryRunResults([result], displayNameById, { usedSeriesNames })
		const previous = mergeQueryRunResults([result], displayNameById, {
			seriesSuffix: " (prev)",
			usedSeriesNames,
		})

		expect(current.seriesNames).toEqual(["Requests"])
		expect(previous.seriesNames).toEqual(["Requests (prev)"])
	})

	it("disambiguates a genuine name collision with a numeric suffix", () => {
		const merged = mergeQueryRunResults(
			[
				makeQueryResult({
					queryId: "q-1",
					data: [{ bucket: "b", series: { all: 1 } }],
				}),
				makeQueryResult({
					queryId: "q-2",
					data: [{ bucket: "b", series: { all: 2 } }],
				}),
			],
			new Map([
				["q-1", "Requests"],
				["q-2", "Requests"],
			]),
		)

		expect(merged.seriesNames).toEqual(["Requests", "Requests (2)"])
	})
})

describe("combineRows", () => {
	it("merges current and previous sets and sorts by bucket", () => {
		const rows = combineRows([
			{
				rowsByBucket: new Map([
					["2026-01-01T01:00:00.000Z", { bucket: "2026-01-01T01:00:00.000Z", A: 2 }],
					["2026-01-01T00:00:00.000Z", { bucket: "2026-01-01T00:00:00.000Z", A: 1 }],
				]),
				seriesNames: ["A"],
			},
			{
				rowsByBucket: new Map([
					["2026-01-01T00:00:00.000Z", { bucket: "2026-01-01T00:00:00.000Z", "A (prev)": 5 }],
				]),
				seriesNames: ["A (prev)"],
			},
		])

		expect(rows.map((row) => row.bucket)).toEqual([
			"2026-01-01T00:00:00.000Z",
			"2026-01-01T01:00:00.000Z",
		])
		// The bucket the previous set had no row for is zero-filled, not absent.
		expect(rows[1]).toEqual({ bucket: "2026-01-01T01:00:00.000Z", A: 2, "A (prev)": 0 })
	})
})

describe("shiftResultPoints / shiftRunResults", () => {
	it("moves a previous-period bucket forward onto the current window", () => {
		const shifted = shiftResultPoints(
			[{ bucket: "2026-01-01T00:00:00.000Z", series: { all: 1 } }],
			3600_000,
		)
		expect(shifted[0].bucket).toBe("2026-01-01T01:00:00.000Z")
	})

	it("passes an unparseable bucket through rather than producing Invalid Date", () => {
		const shifted = shiftResultPoints([{ bucket: "not-a-date", series: {} }], 1000)
		expect(shifted[0].bucket).toBe("not-a-date")
	})

	it("shifts every result's points and keeps the rest of the result", () => {
		const shifted = shiftRunResults(
			[
				makeQueryResult({
					warnings: ["w"],
					data: [{ bucket: "2026-01-01T00:00:00.000Z", series: { all: 1 } }],
				}),
			],
			3600_000,
		)

		expect(shifted[0].warnings).toEqual(["w"])
		expect(shifted[0].data[0].bucket).toBe("2026-01-01T01:00:00.000Z")
	})
})

describe("appendPercentChangeSeries", () => {
	it("computes percent change per stable grouped series", () => {
		const rows: Array<Record<string, string | number>> = [
			{
				bucket: "2026-01-01T00:00:00.000Z",
				"Errors: checkout": 20,
				"Errors: checkout (prev)": 10,
			},
		]

		appendPercentChangeSeries(
			rows,
			new Map([["q-1::checkout", "Errors: checkout"]]),
			new Map([["q-1::checkout", "Errors: checkout (prev)"]]),
		)

		expect(rows[0]["Errors: checkout (%Δ)"]).toBe(100)
	})

	it("prev=0 & cur=0 is 0% (genuinely unchanged); prev=0 & cur>0 leaves a gap, not a fake 0%", () => {
		const rows: Array<Record<string, string | number>> = [
			{
				bucket: "2026-01-01T00:00:00.000Z",
				"Errors: checkout": 0,
				"Errors: checkout (prev)": 0,
			},
			{
				bucket: "2026-01-01T01:00:00.000Z",
				"Errors: checkout": 5,
				"Errors: checkout (prev)": 0,
			},
		]

		appendPercentChangeSeries(
			rows,
			new Map([["q-1::checkout", "Errors: checkout"]]),
			new Map([["q-1::checkout", "Errors: checkout (prev)"]]),
		)

		expect(rows[0]["Errors: checkout (%Δ)"]).toBe(0)
		expect(rows[1]).not.toHaveProperty("Errors: checkout (%Δ)")
	})

	it("skips a series with no previous-period twin", () => {
		const rows: Array<Record<string, string | number>> = [{ bucket: "b", A: 5 }]
		appendPercentChangeSeries(rows, new Map([["q-1::all", "A"]]), new Map())
		expect(rows[0]).toEqual({ bucket: "b", A: 5 })
	})
})

describe("collectHiddenResultIds", () => {
	// A ratio widget hides its numerator/denominator queries and plots only the formula. Merging
	// the hidden operands in anyway put raw counts on the same axis as a 0–1 ratio — and, under
	// the widget's own `percent` unit, drew them as "416849856400.0%".
	it("collects hidden query and formula ids so they are dropped before merging", () => {
		const hidden = collectHiddenResultIds({
			queries: [{ id: "num", hidden: true }, { id: "den", hidden: true }, { id: "plain" }],
			formulas: [{ id: "ratio" }, { id: "scratch", hidden: true }],
		})

		expect([...hidden].sort()).toEqual(["den", "num", "scratch"])
	})

	it("treats a widget with no formulas and nothing hidden as fully plotted", () => {
		expect(collectHiddenResultIds({ queries: [{ id: "a" }, { id: "b" }] }).size).toBe(0)
	})
})

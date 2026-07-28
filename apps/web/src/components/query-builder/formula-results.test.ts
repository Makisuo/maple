import { describe, expect, it } from "vitest"

import {
	buildFormulaResults,
	type FormulaDraft,
	type QueryRunResult,
} from "@/components/query-builder/formula-results"

function makeFormula(overrides: Partial<FormulaDraft> = {}): FormulaDraft {
	return {
		id: "formula-1",
		name: "F1",
		expression: "A / B",
		legend: "ratio",
		...overrides,
	}
}

function makeResult(overrides: Partial<QueryRunResult> = {}): QueryRunResult {
	return {
		queryId: "query-1",
		queryName: "A",
		source: "metrics",
		status: "success",
		error: null,
		warnings: [],
		data: [],
		...overrides,
	}
}

describe("buildFormulaResults", () => {
	it("skips division-by-zero buckets and keeps valid buckets", () => {
		const formula = makeFormula()
		const queryResults: QueryRunResult[] = [
			makeResult({
				queryName: "A",
				data: [
					{ bucket: "2026-02-10 11:56:00", series: { total: 10 } },
					{ bucket: "2026-02-10 11:57:00", series: { total: 8 } },
				],
			}),
			makeResult({
				queryId: "query-2",
				queryName: "B",
				data: [
					{ bucket: "2026-02-10 11:56:00", series: { total: 2 } },
					{ bucket: "2026-02-10 11:57:00", series: { total: 0 } },
				],
			}),
		]

		const [result] = buildFormulaResults([formula], queryResults)

		expect(result.status).toBe("success")
		expect(result.error).toBeNull()
		expect(result.data).toEqual([
			{
				bucket: "2026-02-10 11:56:00",
				series: { ratio: 5 },
			},
		])
		expect(result.warnings.some((warning) => warning.includes("division by zero"))).toBe(true)
		expect(result.warnings.some((warning) => warning.includes("2026-02-10 11:57:00"))).toBe(true)
	})

	it("does not synthesize zeros when an operand bucket is missing", () => {
		const formula = makeFormula()
		const queryResults: QueryRunResult[] = [
			makeResult({
				queryName: "A",
				data: [
					{ bucket: "2026-02-10 11:56:00", series: { total: 10 } },
					{ bucket: "2026-02-10 11:57:00", series: { total: 8 } },
				],
			}),
			makeResult({
				queryId: "query-2",
				queryName: "B",
				data: [{ bucket: "2026-02-10 11:56:00", series: { total: 2 } }],
			}),
		]

		const [result] = buildFormulaResults([formula], queryResults)

		expect(result.status).toBe("success")
		expect(result.data).toEqual([
			{
				bucket: "2026-02-10 11:56:00",
				series: { ratio: 5 },
			},
		])
		expect(
			result.warnings.some((warning) => warning.includes("missing values for formula operands")),
		).toBe(true)
		expect(result.warnings.some((warning) => warning.includes("division by zero"))).toBe(false)
	})

	// Operands are intersected, so a term that matches nothing silences the whole formula rather
	// than contributing zero. That rules out multi-term numerators over rare attribute values —
	// the reason `cloudflare.ts` cannot express its canonical four-status cache-hit numerator.
	// The message must name the empty operand; "no valid buckets" alone is undiagnosable.
	it("names the empty operand when a term matches nothing", () => {
		const formula = makeFormula({ expression: "(A + B) / C" })
		const queryResults: QueryRunResult[] = [
			makeResult({
				queryName: "A",
				data: [{ bucket: "2026-02-10 11:56:00", series: { total: 6 } }],
			}),
			makeResult({ queryId: "query-2", queryName: "B", data: [] }),
			makeResult({
				queryId: "query-3",
				queryName: "C",
				data: [{ bucket: "2026-02-10 11:56:00", series: { total: 12 } }],
			}),
		]

		const [result] = buildFormulaResults([formula], queryResults)

		expect(result.status).toBe("error")
		expect(result.error).toBe("Formula produced no valid buckets — no data for B")
	})

	it("treats empty-series buckets as missing operands instead of zero", () => {
		const formula = makeFormula()
		const queryResults: QueryRunResult[] = [
			makeResult({
				queryName: "A",
				data: [{ bucket: "2026-02-10 11:56:00", series: { total: 10 } }],
			}),
			makeResult({
				queryId: "query-2",
				queryName: "B",
				data: [{ bucket: "2026-02-10 11:56:00", series: {} }],
			}),
		]

		const [result] = buildFormulaResults([formula], queryResults)

		expect(result.status).toBe("error")
		expect(result.error).toBe("Formula produced no valid buckets — no data for B")
		expect(result.warnings.some((warning) => warning.includes("division by zero"))).toBe(false)
	})

	it("returns an error when every eligible bucket divides by zero", () => {
		const formula = makeFormula()
		const queryResults: QueryRunResult[] = [
			makeResult({
				queryName: "A",
				data: [{ bucket: "2026-02-10 11:57:00", series: { total: 8 } }],
			}),
			makeResult({
				queryId: "query-2",
				queryName: "B",
				data: [{ bucket: "2026-02-10 11:57:00", series: { total: 0 } }],
			}),
		]

		const [result] = buildFormulaResults([formula], queryResults)

		expect(result.status).toBe("error")
		expect(result.error).toBe("Formula produced no valid buckets due to division by zero")
		expect(result.data).toEqual([])
		expect(result.warnings.some((warning) => warning.includes("division by zero"))).toBe(true)
		expect(result.warnings.some((warning) => warning.includes("2026-02-10 11:57:00"))).toBe(true)
	})
})

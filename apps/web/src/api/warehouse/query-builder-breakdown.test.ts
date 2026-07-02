import { describe, expect, it } from "vitest"

import * as breakdownModule from "@/api/warehouse/query-builder-breakdown"
import { __testables, type QueryBuilderBreakdownInput } from "@/api/warehouse/query-builder-breakdown"

describe("query-builder breakdown units", () => {
	it("does not rescale error_rate values — the engine's 0–1 ratio is canonical", () => {
		// Regression guard: a ÷100 "normalize" survived from the Tinybird-pipe
		// era (which returned percent points) long after the CH engine switched
		// to emitting ratios, making error_rate breakdowns 100× too small.
		expect(breakdownModule.__testables).not.toHaveProperty("normalizeErrorRatePoints")
	})
})

describe("mergeBreakdownResults legend naming (MAP-49)", () => {
	const queryDraft = (id: string, name: string, legend: string) =>
		({
			id,
			name,
			legend,
			enabled: true,
		}) as unknown as QueryBuilderBreakdownInput["queries"][number]

	const result = (queryId: string, queryName: string, data: Array<{ name: string; value: number }>) => ({
		queryId,
		queryName,
		status: "success" as const,
		error: null,
		data,
	})

	it("uses query legends as merged column names, so heatmap axes read 'Errors'/'OK' instead of 'A'/'B'", () => {
		const rows = __testables.mergeBreakdownResults(
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
		const rows = __testables.mergeBreakdownResults(
			[result("q-a", "A", [{ name: "x", value: 1 }]), result("q-b", "B", [{ name: "x", value: 2 }])],
			[queryDraft("q-a", "A", ""), queryDraft("q-b", "B", "")],
		)

		expect(rows).toEqual([{ name: "x", A: 1, B: 2 }])
	})
})

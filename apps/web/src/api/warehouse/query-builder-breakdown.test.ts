import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"

import { QuerySetNoDataError } from "@maple/query-engine/query-set"
import * as breakdownModule from "@/api/warehouse/query-builder-breakdown"

// `mergeBreakdownResults` moved to `@maple/query-engine/query-set`, where the
// legend-naming and ordering cases now live (`breakdown-merge.test.ts`). What is
// still this module's own responsibility is not rescaling on the way out.
describe("query-builder breakdown units", () => {
	it("does not rescale error_rate values — the engine's 0–1 ratio is canonical", () => {
		// Regression guard: a ÷100 "normalize" survived from the Tinybird-pipe
		// era (which returned percent points) long after the CH engine switched
		// to emitting ratios, making error_rate breakdowns 100× too small.
		expect(breakdownModule.__testables).not.toHaveProperty("normalizeErrorRatePoints")
	})
})

/**
 * The timeseries adapter stopped failing on an empty window — an empty window is
 * a normal answer — but the breakdown adapter beside it was left raising
 * `WarehouseInvalidInputError`, which marked the span `Error` and billed an
 * exception event for a panel the user simply has no data for.
 */
describe("empty window", () => {
	it("answers with zero rows when every query ran and none matched", () => {
		const exit = Effect.runSyncExit(
			breakdownModule.__testables.onNoData(
				new QuerySetNoDataError({
					message: "No breakdown data found in selected time range",
					details: [],
				}),
			),
		)

		expect(exit).toStrictEqual(Exit.succeed({ rows: [], diagnostics: [] }))
	})

	it("still fails when a query itself failed", () => {
		const exit = Effect.runSyncExit(
			breakdownModule.__testables.onNoData(
				new QuerySetNoDataError({
					message: "Unknown column 'nope'",
					details: ["Unknown column 'nope'"],
				}),
			),
		)

		expect(Exit.isFailure(exit)).toBe(true)
	})
})

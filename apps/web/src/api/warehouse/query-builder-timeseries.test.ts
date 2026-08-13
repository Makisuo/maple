import { assert, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { QuerySpec } from "@maple/query-engine"
import { LAB_EMPTY_RANGE_STRATEGY, NO_EMPTY_RANGE_FALLBACK } from "@maple/query-engine/query-set"
import { __testables } from "@/api/warehouse/query-builder-timeseries"
import { WarehouseQueryError } from "@/api/warehouse/effect-utils"
import type { QueryRunResult } from "@/components/query-builder/formula-results"

// The pure shaping this module used to own — bucket sizing, execution windows,
// the series merge, percent change, hidden-id collection — now lives in
// `@maple/query-engine/query-set` and is tested there against no HTTP at all.
// What is left here is this module's own: mapping the wire strategy shape,
// driving the executor through the fallback ladder, and the no-data message.

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

describe("resolveStrategy (wire shape → package shape)", () => {
	it("maps the wire field names onto the strategy the package takes", () => {
		expect(
			__testables.resolveStrategy({
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 01:00:00",
				queries: [],
				strategy: {
					enableEmptyRangeFallback: true,
					fallbackWindowSeconds: [7200, 60],
					maxFallbackRangeSeconds: 86400,
				},
			}),
		).toEqual({ enabled: true, windowSeconds: [60, 7200], maxRangeSeconds: 86400 })
	})

	/**
	 * `use-widget-data` sends `enableEmptyRangeFallback: false` on every dashboard
	 * tile. If that stopped disabling the ladder, an empty tile would silently
	 * start charting data from outside its own time range.
	 */
	it("honours the dashboard tile's explicit opt-out", () => {
		expect(
			__testables.resolveStrategy({
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 01:00:00",
				queries: [],
				strategy: { enableEmptyRangeFallback: false },
			}).enabled,
		).toBe(false)
	})

	it("defaults to the lab ladder when the caller sends no strategy", () => {
		expect(
			__testables.resolveStrategy({
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 01:00:00",
				queries: [],
			}),
		).toEqual(LAB_EMPTY_RANGE_STRATEGY)
	})
})

describe("executeTimeseriesQueryWithFallbackUsing", () => {
	it.effect("continues fallback execution after an error and recomputes window buckets", () =>
		Effect.gen(function* () {
			const spec: QuerySpec = {
				kind: "timeseries",
				source: "traces",
				metric: "count",
			}

			const seenBucketSeconds: number[] = []
			const result = yield* __testables.executeTimeseriesQueryWithFallbackUsing(
				"2026-01-02 00:00:00",
				"2026-01-02 01:00:00",
				spec,
				{
					enabled: true,
					windowSeconds: [24 * 60 * 60, 7 * 24 * 60 * 60],
					maxRangeSeconds: 31 * 24 * 60 * 60,
				},
				true,
				(windowStart, _windowEnd, windowSpec) =>
					Effect.gen(function* () {
						if (windowSpec.kind !== "timeseries") {
							return []
						}

						seenBucketSeconds.push(windowSpec.bucketSeconds ?? -1)

						if (windowStart === "2026-01-02 00:00:00") {
							return []
						}

						if (windowStart === "2026-01-01 01:00:00") {
							return yield* new WarehouseQueryError({
								operation: "test",
								message: "Timeseries query too expensive",
							})
						}

						return [
							{
								bucket: "2026-01-01T00:00:00.000Z",
								series: { total: 5 },
							},
						]
					}),
			)

			assert.deepStrictEqual(seenBucketSeconds, [60, 900, 3600])
			assert.isTrue(result.fallbackUsed)
			assert.lengthOf(result.attempts, 3)
			assert.strictEqual(result.attempts[1]?.error, "Maple could not complete the warehouse query.")
			assert.deepStrictEqual(result.points, [
				{
					bucket: "2026-01-01T00:00:00.000Z",
					series: { total: 5 },
				},
			])
		}),
	)

	it.effect("fails outright when the PRIMARY window errors — that is not a widening case", () =>
		Effect.gen(function* () {
			const outcome = yield* Effect.result(
				__testables.executeTimeseriesQueryWithFallbackUsing(
					"2026-01-02 00:00:00",
					"2026-01-02 01:00:00",
					{ kind: "timeseries", source: "traces", metric: "count" },
					LAB_EMPTY_RANGE_STRATEGY,
					true,
					() =>
						Effect.gen(function* () {
							return yield* new WarehouseQueryError({ operation: "test", message: "boom" })
						}),
				),
			)

			assert.isTrue(outcome._tag === "Failure")
		}),
	)

	it.effect("runs exactly one window when the strategy is off", () =>
		Effect.gen(function* () {
			let calls = 0
			const result = yield* __testables.executeTimeseriesQueryWithFallbackUsing(
				"2026-01-02 00:00:00",
				"2026-01-02 01:00:00",
				{ kind: "timeseries", source: "traces", metric: "count" },
				NO_EMPTY_RANGE_FALLBACK,
				true,
				() =>
					Effect.sync(() => {
						calls += 1
						return []
					}),
			)

			assert.strictEqual(calls, 1)
			assert.isFalse(result.fallbackUsed)
		}),
	)
})

describe("noQueryDataMessage", () => {
	it("prefers query error message when no series data exists", () => {
		const message = __testables.noQueryDataMessage([
			makeQueryResult({
				status: "error",
				error: "Timeseries query too expensive",
			}),
			makeQueryResult({
				queryId: "q-2",
				queryName: "B",
				data: [],
			}),
		])

		expect(message).toContain("too expensive")
	})
})

describe("query-builder timeseries units", () => {
	it("does not rescale error_rate series — the engine's 0–1 ratio is canonical", () => {
		// Regression guard: a ÷100 "normalize" survived from the Tinybird-pipe
		// era (which returned percent points) long after the CH engine switched
		// to emitting ratios, making every error_rate chart 100× too small.
		expect(__testables).not.toHaveProperty("normalizeErrorRatePoints")
	})
})

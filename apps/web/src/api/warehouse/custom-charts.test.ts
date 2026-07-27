import { describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { strict as assert } from "node:assert"
import { beforeEach, expect, vi } from "vitest"

const executeQueryEngineMock = vi.fn()

vi.mock("@/api/warehouse/effect-utils", () => ({
	WarehouseDateTimeString: Schema.String,
	decodeInput: (_schema: unknown, data: unknown) => Effect.succeed(data),
	invalidWarehouseInput: () => Effect.fail(new Error("invalid")),
	executeQueryEngine: (...args: unknown[]) => executeQueryEngineMock(...args),
}))

import {
	fillServiceDetailPoints,
	getCustomChartServiceDetail,
	getServiceDetailThroughputRefinement,
	mergeExactThroughput,
} from "@/api/warehouse/custom-charts"
import type { ServiceDetailTimeSeriesPoint } from "@/api/warehouse/services"

const spanMetricsCallsOf = () =>
	executeQueryEngineMock.mock.calls.filter((call) => call[0] === "queryEngine.spanMetricsCalls")

describe("getCustomChartServiceDetail", () => {
	beforeEach(() => {
		executeQueryEngineMock.mockReset()
		executeQueryEngineMock.mockImplementation(() =>
			Effect.succeed({ result: { kind: "timeseries", data: [] } }),
		)
	})

	it.effect("renders from the traces allMetrics query only — no SpanMetrics on the critical path", () =>
		Effect.gen(function* () {
			yield* getCustomChartServiceDetail({
				data: {
					serviceName: "svc",
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				},
			})

			const operations = executeQueryEngineMock.mock.calls.map((call) => call[0])
			expect(operations).toContain("queryEngine.serviceDetail.allMetrics")
			// The slow exact-throughput query must NOT fire from the primary effect.
			assert.strictEqual(spanMetricsCallsOf().length, 0)
		}),
	)
})

describe("getServiceDetailThroughputRefinement", () => {
	beforeEach(() => {
		executeQueryEngineMock.mockReset()
		executeQueryEngineMock.mockImplementation(() =>
			Effect.succeed({ result: { kind: "timeseries", data: [] } }),
		)
	})

	it.effect(
		"queries the SpanMetrics `calls` counter as a per-bucket increase when sampling is active",
		() =>
			Effect.gen(function* () {
				yield* getServiceDetailThroughputRefinement({
					data: {
						serviceName: "sampled-svc",
						startTime: "2026-02-01 00:00:00",
						endTime: "2026-02-01 01:00:00",
						samplingActive: true,
					},
				})

				const calls = spanMetricsCallsOf()
				assert.strictEqual(calls.length, 1)
				const request = calls[0][1]
				assert.strictEqual(request.query.metric, "increase")
				// Both known spellings are matched in a single IN(...) — no listMetrics preflight.
				assert.deepStrictEqual(request.query.filters.metricNames, ["span.metrics.calls", "calls"])
			}),
	)

	it.effect("skips the slow query entirely when sampling is not active", () =>
		Effect.gen(function* () {
			yield* getServiceDetailThroughputRefinement({
				data: {
					serviceName: "unsampled-svc",
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
					samplingActive: false,
				},
			})

			assert.strictEqual(spanMetricsCallsOf().length, 0)
		}),
	)

	it.effect("skips the slow query when the view is scoped to an environment", () =>
		Effect.gen(function* () {
			yield* getServiceDetailThroughputRefinement({
				data: {
					serviceName: "env-scoped-svc",
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
					environments: ["production"],
					samplingActive: true,
				},
			})

			assert.strictEqual(spanMetricsCallsOf().length, 0)
		}),
	)
})

describe("mergeExactThroughput", () => {
	const point = (bucket: string, throughput: number, traced: number): ServiceDetailTimeSeriesPoint => ({
		bucket,
		throughput,
		tracedThroughput: traced,
		hasSampling: false,
		samplingWeight: 1,
		errorRate: 0,
		p50LatencyMs: 0,
		p95LatencyMs: 0,
		p99LatencyMs: 0,
		apdexScore: 0,
		totalCount: traced,
		partial: false,
	})

	it("overrides the estimate with the exact value and recomputes sampling weight/flag", () => {
		const points = [point("2026-02-01T00:00:00.000Z", 100, 100)]
		const merged = mergeExactThroughput(points, new Map([["2026-02-01T00:00:00.000Z", 1000]]))
		expect(merged[0].throughput).toBe(1000)
		expect(merged[0].samplingWeight).toBe(10)
		expect(merged[0].hasSampling).toBe(true)
		// Traced count is left untouched.
		expect(merged[0].tracedThroughput).toBe(100)
	})

	it("leaves buckets without an exact value (or with 0) untouched", () => {
		const points = [
			point("2026-02-01T00:00:00.000Z", 100, 100),
			point("2026-02-01T00:01:00.000Z", 50, 50),
		]
		const merged = mergeExactThroughput(points, new Map([["2026-02-01T00:01:00.000Z", 0]]))
		expect(merged[0].throughput).toBe(100)
		expect(merged[1].throughput).toBe(50)
	})

	it("returns the original points when there is no overlay", () => {
		const points = [point("2026-02-01T00:00:00.000Z", 100, 100)]
		expect(mergeExactThroughput(points, new Map())).toBe(points)
	})
})

describe("fillServiceDetailPoints", () => {
	it("builds a contiguous, evenly-spaced timeline and flags the in-progress tail", () => {
		const start = "2026-02-01 00:00:00"
		const end = "2026-02-01 01:00:00"
		const nowMs = Date.parse("2026-02-01T01:00:00Z")

		const result = fillServiceDetailPoints([], start, end, 120, nowMs)

		// Non-empty, evenly spaced 120s buckets (no empty/flat fallthrough).
		expect(result.length).toBeGreaterThan(1)
		const deltas = result.slice(1).map((p, i) => Date.parse(p.bucket) - Date.parse(result[i].bucket))
		expect([...new Set(deltas)]).toEqual([120_000])

		// The final bucket ends at ~now → still settling → flagged; an early bucket isn't.
		expect(result[result.length - 1].partial).toBe(true)
		expect(result[0].partial).toBe(false)
	})

	it("flags nothing partial for a historical window ending well before now", () => {
		const start = "2026-02-01 00:00:00"
		const end = "2026-02-01 01:00:00"
		const nowMs = Date.parse("2026-02-02T00:00:00Z") // a full day after the window

		const result = fillServiceDetailPoints([], start, end, 120, nowMs)

		expect(result.length).toBeGreaterThan(1)
		expect(result.every((p) => p.partial === false)).toBe(true)
	})
})

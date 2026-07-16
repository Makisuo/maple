import { describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { strict as assert } from "node:assert"
import { beforeEach, vi } from "vitest"

const executeQueryEngineMock = vi.fn()
const listMetricsMock = vi.fn()
const runWarehouseQueryMock = vi.fn()

vi.mock("@/api/warehouse/effect-utils", () => ({
	WarehouseDateTimeString: Schema.String,
	decodeInput: (_schema: unknown, data: unknown) => Effect.succeed(data),
	invalidWarehouseInput: () => Effect.fail(new Error("invalid")),
	extractFacets: () => [],
	executeQueryEngine: (...args: unknown[]) => executeQueryEngineMock(...args),
	runWarehouseQuery: (_operation: string, execute: () => unknown) =>
		runWarehouseQueryMock(_operation, execute),
}))

vi.mock("@/api/warehouse/metrics", () => ({
	listMetrics: (...args: unknown[]) => listMetricsMock(...args),
}))

import { getServiceOverview } from "@/api/warehouse/services"
import { setActiveOrgId } from "@/lib/services/common/auth-headers"

// One hour window → durationSeconds = 3600.
const START = "2026-02-01 00:00:00"
const END = "2026-02-01 01:00:00"

// Raw service-overview row: 100 traced/entry spans, no per-span sampling weight
// (estimatedSpanCount == spanCount), so sum(SampleRate) alone yields no estimate.
const overviewRow = {
	serviceName: "frontend",
	serviceNamespace: "web",
	environment: "production",
	commitSha: "abc1234",
	throughput: 100,
	errorCount: 0,
	estimatedErrorCount: 0,
	spanCount: 100,
	p50LatencyMs: 1,
	p95LatencyMs: 2,
	p99LatencyMs: 3,
	estimatedSpanCount: 100,
}

describe("getServiceOverview throughput resolution", () => {
	beforeEach(() => {
		executeQueryEngineMock.mockReset()
		listMetricsMock.mockReset()
		runWarehouseQueryMock.mockReset()
		runWarehouseQueryMock.mockReturnValue(Effect.succeed({ data: [overviewRow] }))
	})

	it.effect(
		"extrapolates list throughput from the env-scoped sum(SampleRate) estimate, ignoring the SpanMetrics `calls` counter",
		() =>
			Effect.gen(function* () {
				setActiveOrgId("overview-metrics-present")
				// The SpanMetrics `calls` counter is deliberately NOT consulted on the
				// overview (it's all-environment and would over-report per-env rows), so
				// even if the catalog advertises it and a query would return a value,
				// throughput must come from the env-scoped estimate below.
				listMetricsMock.mockReturnValue(
					Effect.succeed({ data: [{ metricName: "span.metrics.calls", metricType: "sum" }] }),
				)
				executeQueryEngineMock.mockImplementation(() =>
					Effect.succeed({
						result: {
							kind: "timeseries",
							data: [{ bucket: START, series: { frontend: 99999 } }],
						},
					}),
				)
				// 100 traced spans, but sum(SampleRate) estimates 1000 pre-sampling spans → 10x weight.
				runWarehouseQueryMock.mockReturnValue(
					Effect.succeed({ data: [{ ...overviewRow, estimatedSpanCount: 1000 }] }),
				)

				const { data } = yield* getServiceOverview({
					data: { startTime: START, endTime: END },
				})

				assert.strictEqual(data.length, 1)
				const svc = data[0]
				assert.strictEqual(svc.hasSampling, true)
				// throughput = estimated spans / durationSeconds = 1000 / 3600
				assert.ok(Math.abs(svc.throughput - 1000 / 3600) < 1e-9, `throughput=${svc.throughput}`)
				// traced = raw spans / durationSeconds = 100 / 3600
				assert.ok(
					Math.abs(svc.tracedThroughput - 100 / 3600) < 1e-9,
					`traced=${svc.tracedThroughput}`,
				)
				// weight = estimated / raw = 10x
				assert.ok(Math.abs(svc.samplingWeight - 10) < 1e-9, `weight=${svc.samplingWeight}`)

				// The SpanMetrics `calls` counter must not be queried for the overview.
				const spanMetricsCalls = executeQueryEngineMock.mock.calls.filter((call) =>
					String(call[0]).includes("spanMetricsCalls"),
				)
				assert.strictEqual(spanMetricsCalls.length, 0)
			}),
	)

	it.effect("falls back to the traced count when no SpanMetrics `calls` data exists", () =>
		Effect.gen(function* () {
			// Distinct org → availability resolves to null (no calls metric in catalog).
			setActiveOrgId("overview-no-metrics")
			listMetricsMock.mockReturnValue(Effect.succeed({ data: [] }))
			executeQueryEngineMock.mockImplementation(() =>
				Effect.succeed({ result: { kind: "timeseries", data: [] } }),
			)

			const { data } = yield* getServiceOverview({
				data: { startTime: START, endTime: END },
			})

			assert.strictEqual(data.length, 1)
			const svc = data[0]
			assert.strictEqual(svc.hasSampling, false)
			assert.ok(Math.abs(svc.throughput - 100 / 3600) < 1e-9, `throughput=${svc.throughput}`)
			assert.ok(Math.abs(svc.samplingWeight - 1) < 1e-9, `weight=${svc.samplingWeight}`)

			// SpanMetrics timeseries must be skipped entirely when the catalog has no
			// calls metric (no wasted query).
			const spanMetricsCalls = executeQueryEngineMock.mock.calls.filter(
				(call) => call[0] === "queryEngine.spanMetricsCalls",
			)
			assert.strictEqual(spanMetricsCalls.length, 0)
		}),
	)

	it.effect("weights errors with the same per-span sampling factors as throughput", () =>
		Effect.gen(function* () {
			// One retained error represents one request while one retained success
			// represents 100 requests. The raw retained-span rate would be 50%; the
			// sampling-corrected population rate is 1 / 101.
			runWarehouseQueryMock.mockReturnValue(
				Effect.succeed({
					data: [
						{
							...overviewRow,
							throughput: 2,
							spanCount: 2,
							errorCount: 1,
							estimatedErrorCount: 1,
							estimatedSpanCount: 101,
						},
					],
				}),
			)

			const { data } = yield* getServiceOverview({
				data: { startTime: START, endTime: END },
			})

			assert.strictEqual(data.length, 1)
			assert.ok(Math.abs(data[0].errorRate - 1 / 101) < 1e-12, `errorRate=${data[0].errorRate}`)
		}),
	)

	it.effect("preserves the raw error rate when spans are unsampled", () =>
		Effect.gen(function* () {
			runWarehouseQueryMock.mockReturnValue(
				Effect.succeed({
					data: [
						{
							...overviewRow,
							errorCount: 5,
							estimatedErrorCount: 5,
						},
					],
				}),
			)

			const { data } = yield* getServiceOverview({
				data: { startTime: START, endTime: END },
			})

			assert.strictEqual(data.length, 1)
			assert.strictEqual(data[0].errorRate, 0.05)
		}),
	)

	it.effect("falls back to the raw rate when a stale response omits weighted errors", () =>
		Effect.gen(function* () {
			const { estimatedErrorCount: _, ...staleRow } = overviewRow
			runWarehouseQueryMock.mockReturnValue(
				Effect.succeed({
					data: [
						{
							...staleRow,
							errorCount: 5,
							estimatedSpanCount: 1000,
						},
					],
				}),
			)

			const { data } = yield* getServiceOverview({
				data: { startTime: START, endTime: END },
			})

			assert.strictEqual(data.length, 1)
			assert.strictEqual(data[0].errorRate, 0.05)
		}),
	)

	it.effect("collapses namespace variants that route to the same service detail", () =>
		Effect.gen(function* () {
			runWarehouseQueryMock.mockReturnValue(
				Effect.succeed({
					data: [
						{
							...overviewRow,
							serviceName: "dash-api",
							serviceNamespace: "api",
							throughput: 19_413,
							spanCount: 19_413,
							errorCount: 0,
							estimatedErrorCount: 0,
							estimatedSpanCount: 194_118.15196827185,
						},
						{
							...overviewRow,
							serviceName: "dash-api",
							serviceNamespace: "",
							commitSha: "legacy-deploy",
							throughput: 17,
							spanCount: 17,
							errorCount: 17,
							estimatedErrorCount: 169.9896246566982,
							estimatedSpanCount: 169.9896246566982,
						},
					],
				}),
			)

			const { data } = yield* getServiceOverview({
				data: { startTime: START, endTime: END },
			})

			assert.strictEqual(data.length, 1)
			assert.strictEqual(data[0].serviceName, "dash-api")
			assert.strictEqual(data[0].serviceNamespace, "api")
			assert.ok(data[0].errorRate < 0.001, `errorRate=${data[0].errorRate}`)
			assert.ok(
				Math.abs(data[0].errorRate - 169.9896246566982 / (194_118.15196827185 + 169.9896246566982)) <
					1e-12,
			)
		}),
	)
})

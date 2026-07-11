import { assert, describe, it } from "@effect/vitest"
import type { MetricGaugeRow, MetricSumRow } from "../../lib/metric-rows"
import { metricRowsToOtlp } from "./otlp"

const baseGauge = (over: Partial<MetricGaugeRow>): MetricGaugeRow => ({
	timestamp: "2026-07-02 11:35:00.000",
	start_timestamp: "2026-07-02 11:35:00.000",
	metric_name: "cloudflare.http.edge.ttfb",
	metric_description: "Edge time to first byte",
	metric_unit: "ms",
	metric_attributes: { quantile: "0.95" },
	service_name: "cloudflare/example.com",
	resource_schema_url: "",
	resource_attributes: { "service.name": "cloudflare/example.com", maple_org_id: "org_cf", "cloud.provider": "cloudflare" },
	scope_schema_url: "",
	scope_name: "@maple/cloudflare-analytics",
	scope_version: "",
	scope_attributes: {},
	value: 180,
	flags: 0,
	exemplars_trace_id: [],
	exemplars_span_id: [],
	exemplars_timestamp: [],
	exemplars_value: [],
	exemplars_filtered_attributes: [],
	...over,
})

const baseSum = (over: Partial<MetricSumRow>): MetricSumRow => ({
	...baseGauge({
		metric_name: "cloudflare.http.requests",
		metric_description: "Edge HTTP requests (ABR-adjusted estimate)",
		metric_unit: "{requests}",
		metric_attributes: { "cache.status": "hit", "http.status_class": "2xx" },
		value: 100,
	}),
	aggregation_temporality: 1,
	is_monotonic: true,
	...over,
})

describe("metricRowsToOtlp", () => {
	it("emits an empty envelope for no rows", () => {
		assert.deepStrictEqual(metricRowsToOtlp([], []), { resourceMetrics: [] })
	})

	it("groups sum and gauge rows of one service under a single resource+scope", () => {
		const payload = metricRowsToOtlp([baseSum({})], [baseGauge({})])

		assert.strictEqual(payload.resourceMetrics.length, 1)
		const resource = payload.resourceMetrics[0]!
		// Resource attributes carry service.name so the collector derives ServiceName.
		assert.deepStrictEqual(resource.resource.attributes, [
			{ key: "service.name", value: { stringValue: "cloudflare/example.com" } },
			{ key: "maple_org_id", value: { stringValue: "org_cf" } },
			{ key: "cloud.provider", value: { stringValue: "cloudflare" } },
		])
		assert.strictEqual(resource.scopeMetrics.length, 1)
		const scope = resource.scopeMetrics[0]!
		assert.strictEqual(scope.scope.name, "@maple/cloudflare-analytics")
		assert.strictEqual(scope.metrics.length, 2)

		const sum = scope.metrics.find((m) => m.name === "cloudflare.http.requests")!
		assert.isDefined(sum.sum)
		assert.isUndefined(sum.gauge)
		// DELTA temporality (1) + monotonic carried straight from the row.
		assert.strictEqual(sum.sum!.aggregationTemporality, 1)
		assert.strictEqual(sum.sum!.isMonotonic, true)
		assert.strictEqual(sum.sum!.dataPoints[0]!.asDouble, 100)
		assert.deepStrictEqual(sum.sum!.dataPoints[0]!.attributes, [
			{ key: "cache.status", value: { stringValue: "hit" } },
			{ key: "http.status_class", value: { stringValue: "2xx" } },
		])

		const gauge = scope.metrics.find((m) => m.name === "cloudflare.http.edge.ttfb")!
		assert.isDefined(gauge.gauge)
		assert.isUndefined(gauge.sum)
		assert.strictEqual(gauge.gauge!.dataPoints[0]!.asDouble, 180)
	})

	it("converts the DateTime64 literal to a unix-nanosecond string", () => {
		const payload = metricRowsToOtlp([], [baseGauge({ timestamp: "2026-07-02 11:35:00.000", start_timestamp: "2026-07-02 11:30:00.000" })])
		const dp = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.gauge!.dataPoints[0]!
		assert.strictEqual(dp.timeUnixNano, `${Date.parse("2026-07-02T11:35:00.000Z")}000000`)
		assert.strictEqual(dp.startTimeUnixNano, `${Date.parse("2026-07-02T11:30:00.000Z")}000000`)
	})

	it("collapses datapoints of the same metric and separates distinct resources", () => {
		const payload = metricRowsToOtlp(
			[
				baseSum({ metric_attributes: { "cache.status": "hit" } }),
				baseSum({ metric_attributes: { "cache.status": "miss" }, value: 5 }),
				// A different service → its own resource.
				baseSum({
					service_name: "cloudflare-worker/my-worker",
					resource_attributes: { "service.name": "cloudflare-worker/my-worker", "cloud.provider": "cloudflare" },
					metric_name: "cloudflare.worker.requests",
					value: 42,
				}),
			],
			[],
		)

		assert.strictEqual(payload.resourceMetrics.length, 2)
		const zone = payload.resourceMetrics.find((r) =>
			r.resource.attributes.some((a) => a.value.stringValue === "cloudflare/example.com"),
		)!
		const requests = zone.scopeMetrics[0]!.metrics.find((m) => m.name === "cloudflare.http.requests")!
		// Two datapoints (hit + miss) merged under one metric.
		assert.strictEqual(requests.sum!.dataPoints.length, 2)
	})
})

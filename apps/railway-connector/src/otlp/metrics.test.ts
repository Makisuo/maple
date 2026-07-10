import { assert, describe, it } from "@effect/vitest"
import { buildMetricsExportRequest, decodeRailwayMetrics } from "./metrics"

const context = {
	serviceName: "api",
	serviceId: "svc-1",
	projectId: "proj-1",
	projectName: "maple-demo",
	environmentId: "env-1",
	environmentName: "production",
}

describe("decodeRailwayMetrics", () => {
	it("decodes series with epoch-second timestamps", () => {
		const series = decodeRailwayMetrics({
			metrics: [
				{
					measurement: "CPU_USAGE",
					values: [
						{ ts: 1_750_000_000, value: 0.42 },
						{ ts: 1_750_000_300, value: 0.55 },
					],
				},
			],
		})
		assert.strictEqual(series.length, 1)
		assert.strictEqual(series[0]!.measurement, "CPU_USAGE")
		assert.strictEqual(series[0]!.points[0]!.tsMs, 1_750_000_000_000)
	})

	it("tolerates ms timestamps, malformed points, and unknown shapes", () => {
		const series = decodeRailwayMetrics({
			metrics: [
				{
					measurement: "MEMORY_USAGE_GB",
					values: [
						{ ts: 1_750_000_000_000, value: 0.5 },
						{ ts: "bad", value: 1 },
						{ value: 2 },
						null,
					],
				},
				{ measurement: 42, values: [] },
				"garbage",
			],
		})
		assert.strictEqual(series.length, 1)
		assert.strictEqual(series[0]!.points.length, 1)
		assert.strictEqual(series[0]!.points[0]!.tsMs, 1_750_000_000_000)

		assert.deepStrictEqual(decodeRailwayMetrics(null), [])
		assert.deepStrictEqual(decodeRailwayMetrics({ metrics: "nope" }), [])
	})
})

describe("buildMetricsExportRequest", () => {
	it("converts measurements to gauges with unit scaling", () => {
		const result = buildMetricsExportRequest(
			[
				{ measurement: "CPU_USAGE", points: [{ tsMs: 1_750_000_000_000, value: 0.42 }] },
				{ measurement: "MEMORY_USAGE_GB", points: [{ tsMs: 1_750_000_000_000, value: 0.5 }] },
				{ measurement: "UNKNOWN_THING", points: [{ tsMs: 1_750_000_000_000, value: 1 }] },
			],
			context,
			null,
		)
		assert.isNotNull(result.request)
		assert.strictEqual(result.dataPointCount, 2)
		assert.strictEqual(result.maxSampleMs, 1_750_000_000_000)

		const metrics = result.request!.resourceMetrics[0]!.scopeMetrics[0]!.metrics
		const cpu = metrics.find((metric) => metric.name === "railway.cpu.usage")!
		assert.strictEqual(cpu.unit, "{cpu}")
		assert.strictEqual(cpu.gauge.dataPoints[0]!.asDouble, 0.42)
		assert.strictEqual(cpu.gauge.dataPoints[0]!.timeUnixNano, "1750000000000000000")

		// GB measurements land as bytes.
		const memory = metrics.find((metric) => metric.name === "railway.memory.usage")!
		assert.strictEqual(memory.unit, "By")
		assert.strictEqual(memory.gauge.dataPoints[0]!.asDouble, 500_000_000)

		const attrs = Object.fromEntries(
			result.request!.resourceMetrics[0]!.resource.attributes.map((attr) => [
				attr.key,
				attr.value.stringValue,
			]),
		)
		assert.strictEqual(attrs["service.name"], "api")
		assert.strictEqual(attrs["railway.service.id"], "svc-1")
		assert.strictEqual(attrs["cloud.provider"], "railway")
	})

	it("filters samples at or below the watermark and reports the new max", () => {
		const result = buildMetricsExportRequest(
			[
				{
					measurement: "CPU_USAGE",
					points: [
						{ tsMs: 1_000, value: 0.1 },
						{ tsMs: 2_000, value: 0.2 },
						{ tsMs: 3_000, value: 0.3 },
					],
				},
			],
			context,
			2_000,
		)
		assert.strictEqual(result.dataPointCount, 1)
		assert.strictEqual(result.maxSampleMs, 3_000)
		assert.strictEqual(
			result.request!.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.gauge.dataPoints[0]!.asDouble,
			0.3,
		)
	})

	it("returns a null request when everything is filtered", () => {
		const result = buildMetricsExportRequest(
			[{ measurement: "CPU_USAGE", points: [{ tsMs: 1_000, value: 0.1 }] }],
			context,
			5_000,
		)
		assert.isNull(result.request)
		assert.strictEqual(result.dataPointCount, 0)
	})
})

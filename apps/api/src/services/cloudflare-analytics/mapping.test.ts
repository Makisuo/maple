import { assert, describe, it } from "@effect/vitest"
import {
	mapHttpGroups,
	mapWorkersGroups,
	METRIC_HTTP_BYTES,
	METRIC_HTTP_EDGE_TTFB,
	METRIC_HTTP_ORIGIN_DURATION,
	METRIC_HTTP_REQUESTS,
	METRIC_HTTP_VISITS,
	METRIC_WORKER_CPU_TIME,
	METRIC_WORKER_DURATION,
	METRIC_WORKER_ERRORS,
	METRIC_WORKER_REQUESTS,
	SCOPE_NAME,
	statusClass,
} from "./mapping"
import {
	httpAnalyticsQuery,
	settingsQuery,
	toGraphqlTime,
	workersAnalyticsQuery,
} from "./queries"

const BUCKET = "2026-07-02T12:00:00Z"
const BUCKET_TS = "2026-07-02 12:00:00.000"

describe("statusClass", () => {
	it("collapses statuses into classes", () => {
		assert.strictEqual(statusClass(200), "2xx")
		assert.strictEqual(statusClass(304), "3xx")
		assert.strictEqual(statusClass(404), "4xx")
		assert.strictEqual(statusClass(503), "5xx")
		assert.strictEqual(statusClass(null), "unknown")
		assert.strictEqual(statusClass(undefined), "unknown")
		assert.strictEqual(statusClass(42), "unknown")
	})
})

describe("mapHttpGroups", () => {
	const input = {
		orgId: "org_test",
		zoneId: "zone-1",
		zoneName: "example.com",
		groups: [
			{
				count: 10,
				avg: { sampleInterval: 10 },
				sum: { edgeResponseBytes: 5000, visits: 8 },
				dimensions: { datetimeFiveMinutes: BUCKET, cacheStatus: "hit", edgeResponseStatus: 200 },
			},
		],
		latency: [
			{
				count: 10,
				quantiles: {
					edgeTimeToFirstByteMsP50: 42,
					edgeTimeToFirstByteMsP95: 180,
					edgeTimeToFirstByteMsP99: 400,
					originResponseDurationMsP50: 12,
					originResponseDurationMsP95: 90,
					originResponseDurationMsP99: 300,
				},
				dimensions: { datetimeFiveMinutes: BUCKET },
			},
		],
	}

	it("scales the ABR count by sampleInterval and emits delta sums", () => {
		const { sumRows } = mapHttpGroups(input)
		const requests = sumRows.find((row) => row.metric_name === METRIC_HTTP_REQUESTS)
		assert.isDefined(requests)
		assert.strictEqual(requests!.value, 100)
		assert.strictEqual(requests!.aggregation_temporality, 1)
		assert.strictEqual(requests!.is_monotonic, true)
		assert.strictEqual(requests!.timestamp, BUCKET_TS)
		assert.strictEqual(requests!.service_name, "cloudflare/example.com")
		assert.deepStrictEqual(requests!.metric_attributes, {
			"cache.status": "hit",
			"http.status_class": "2xx",
		})
		assert.strictEqual(requests!.resource_attributes.maple_org_id, "org_test")
		assert.strictEqual(requests!.resource_attributes["service.name"], "cloudflare/example.com")
		assert.strictEqual(requests!.resource_attributes["cloudflare.zone.id"], "zone-1")
		assert.strictEqual(requests!.scope_name, SCOPE_NAME)

		const bytes = sumRows.find((row) => row.metric_name === METRIC_HTTP_BYTES)
		assert.strictEqual(bytes!.value, 5000)
		assert.strictEqual(bytes!.metric_unit, "By")
		const visits = sumRows.find((row) => row.metric_name === METRIC_HTTP_VISITS)
		assert.strictEqual(visits!.value, 8)
	})

	it("emits quantile gauges keyed by the quantile attribute", () => {
		const { gaugeRows } = mapHttpGroups(input)
		const ttfb = gaugeRows.filter((row) => row.metric_name === METRIC_HTTP_EDGE_TTFB)
		assert.strictEqual(ttfb.length, 3)
		assert.deepStrictEqual(
			ttfb.map((row) => [row.metric_attributes.quantile, row.value]),
			[
				["0.5", 42],
				["0.95", 180],
				["0.99", 400],
			],
		)
		const origin = gaugeRows.filter((row) => row.metric_name === METRIC_HTTP_ORIGIN_DURATION)
		assert.strictEqual(origin.length, 3)
		assert.strictEqual(origin[0]!.metric_unit, "ms")
	})

	it("emits no gauges in degraded (no-quantiles) mode and skips zero counters", () => {
		const { sumRows, gaugeRows } = mapHttpGroups({
			...input,
			groups: [
				{
					count: 0,
					avg: { sampleInterval: 1 },
					sum: { edgeResponseBytes: 0, visits: 0 },
					dimensions: { datetimeFiveMinutes: BUCKET, cacheStatus: null, edgeResponseStatus: null },
				},
			],
			latency: [{ count: 0, quantiles: null, dimensions: { datetimeFiveMinutes: BUCKET } }],
		})
		assert.strictEqual(sumRows.length, 0)
		assert.strictEqual(gaugeRows.length, 0)
	})
})

describe("mapWorkersGroups", () => {
	const input = {
		orgId: "org_test",
		accountId: "acct-1",
		groups: [
			{
				sum: { requests: 42, errors: 2, subrequests: 5 },
				quantiles: { cpuTimeP50: 1500, cpuTimeP99: 9000, durationP50: 0.002, durationP99: 0.05 },
				dimensions: { datetimeFiveMinutes: BUCKET, scriptName: "my-worker", status: "success" },
			},
		],
	}

	it("maps counters under cloudflare-worker/{script} with worker.status", () => {
		const { sumRows } = mapWorkersGroups(input)
		const requests = sumRows.find((row) => row.metric_name === METRIC_WORKER_REQUESTS)
		assert.strictEqual(requests!.value, 42)
		assert.strictEqual(requests!.service_name, "cloudflare-worker/my-worker")
		assert.deepStrictEqual(requests!.metric_attributes, { "worker.status": "success" })
		assert.strictEqual(requests!.resource_attributes["cloudflare.account.id"], "acct-1")
		const errors = sumRows.find((row) => row.metric_name === METRIC_WORKER_ERRORS)
		assert.strictEqual(errors!.value, 2)
	})

	it("normalizes cpuTime µs→ms and duration s→ms", () => {
		const { gaugeRows } = mapWorkersGroups(input)
		const cpu = gaugeRows.filter((row) => row.metric_name === METRIC_WORKER_CPU_TIME)
		assert.deepStrictEqual(
			cpu.map((row) => [row.metric_attributes.quantile, row.value]),
			[
				["0.5", 1.5],
				["0.99", 9],
			],
		)
		const duration = gaugeRows.filter((row) => row.metric_name === METRIC_WORKER_DURATION)
		assert.deepStrictEqual(
			duration.map((row) => [row.metric_attributes.quantile, row.value]),
			[
				["0.5", 2],
				["0.99", 50],
			],
		)
	})
})

describe("query documents", () => {
	it("http query includes the eyeball filter and dimensional selections", () => {
		const doc = httpAnalyticsQuery({ withQuantiles: true })
		assert.include(doc, 'requestSource: "eyeball"')
		assert.include(doc, "datetime_geq: $start")
		assert.include(doc, "cacheStatus")
		assert.include(doc, "edgeResponseStatus")
		assert.include(doc, "edgeTimeToFirstByteMsP95")
		assert.include(doc, "originResponseDurationMsP99")
		assert.include(doc, "sampleInterval")
	})

	it("http query drops the quantile selection in degraded mode", () => {
		const doc = httpAnalyticsQuery({ withQuantiles: false })
		assert.notInclude(doc, "edgeTimeToFirstByteMs")
		assert.include(doc, "cacheStatus")
	})

	it("workers query toggles quantiles", () => {
		assert.include(workersAnalyticsQuery({ withQuantiles: true }), "cpuTimeP99")
		assert.notInclude(workersAnalyticsQuery({ withQuantiles: false }), "cpuTimeP99")
	})

	it("settings query includes zones only when requested", () => {
		assert.include(settingsQuery({ withZones: true }), "httpRequestsAdaptiveGroups")
		assert.notInclude(settingsQuery({ withZones: false }), "zoneTag_in")
		assert.include(settingsQuery({ withZones: false }), "workersInvocationsAdaptive")
	})

	it("formats GraphQL Time at second precision", () => {
		assert.strictEqual(toGraphqlTime(Date.parse("2026-07-02T12:00:00.400Z")), "2026-07-02T12:00:00Z")
	})
})

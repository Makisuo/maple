import { assert, describe, it } from "@effect/vitest"
import {
	mapHttpGroups,
	mapWorkersGroups,
	MAX_HTTP_HOSTS,
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
	mapDnsGroups,
	mapDurableObjectsGroups,
	mapFirewallGroups,
	mapQueueBacklogGroups,
	mapQueueConsumersGroups,
	MAX_DNS_QUERY_NAMES,
	METRIC_DNS_QUERIES,
	METRIC_DO_ERRORS,
	METRIC_DO_REQUESTS,
	METRIC_DO_WALL_TIME,
	METRIC_FIREWALL_EVENTS,
	METRIC_QUEUE_BACKLOG_BYTES,
	METRIC_QUEUE_BACKLOG_MESSAGES,
	METRIC_QUEUE_CONSUMER_CONCURRENCY,
} from "./mapping"
import {
	mapHttpDimensionGroups,
	mapHttpPathGroups,
	MAX_HTTP_PATHS,
	METRIC_HTTP_BYTES_BY_COUNTRY,
	METRIC_HTTP_BYTES_BY_PATH,
	METRIC_HTTP_ERRORS_BY_PATH,
	METRIC_HTTP_REQUESTS_BY_CLIENT,
	METRIC_HTTP_REQUESTS_BY_COUNTRY,
	METRIC_HTTP_REQUESTS_BY_PATH,
	normalizePath,
	normalizeProtocol,
} from "./mapping"
import {
	accountAnalyticsDocument,
	dnsSelection,
	durableObjectsSelection,
	firewallSelection,
	httpDimensionsSelection,
	httpPathsSelection,
	httpSelection,
	queueBacklogSelection,
	queueConsumersSelection,
	settingsQuery,
	toGraphqlTime,
	topTrafficFilterVariables,
	topTrafficQuery,
	workersSelection,
	zoneAnalyticsDocument,
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
			"server.address": "unknown",
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

	it('keeps the top-N hosts and folds the tail into "other"', () => {
		const hosts = Array.from({ length: 25 }, (_, i) => `h${i}.example.com`)
		const groups = hosts.map((host, i) => ({
			// h0 heaviest → h24 lightest, so exactly h20..h24 fold into "other".
			count: 100 - i,
			avg: { sampleInterval: 10 },
			sum: { edgeResponseBytes: 1, visits: 0 },
			dimensions: {
				datetimeFiveMinutes: BUCKET,
				cacheStatus: "hit",
				edgeResponseStatus: 200,
				clientRequestHTTPHost: host,
			},
		}))
		const { sumRows } = mapHttpGroups({ ...input, groups, latency: [] })
		const requestRows = sumRows.filter((row) => row.metric_name === METRIC_HTTP_REQUESTS)
		const emittedHosts = new Set(requestRows.map((row) => row.metric_attributes["server.address"]))
		assert.strictEqual(emittedHosts.size, MAX_HTTP_HOSTS + 1)
		assert.isTrue(emittedHosts.has("other"))
		assert.isTrue(emittedHosts.has("h0.example.com"))
		assert.isFalse(emittedHosts.has("h24.example.com"))
		// Folding relabels, never drops: total ABR-adjusted requests are preserved.
		const total = requestRows.reduce((sum, row) => sum + row.value, 0)
		assert.strictEqual(
			total,
			groups.reduce((sum, g) => sum + g.count * 10, 0),
		)
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

describe("normalizePath", () => {
	it("strips query strings, guards empties, and truncates pathological lengths", () => {
		assert.strictEqual(normalizePath("/api/users"), "/api/users")
		assert.strictEqual(normalizePath("/search?q=hi&token=secret"), "/search")
		assert.strictEqual(normalizePath(null), "unknown")
		assert.strictEqual(normalizePath(""), "unknown")
		// A path that is nothing but a query string has no path to keep.
		assert.strictEqual(normalizePath("?a=1"), "unknown")
		const long = `/${"x".repeat(500)}`
		assert.strictEqual(normalizePath(long).length, 201)
		assert.isTrue(normalizePath(long).endsWith("…"))
	})
})

describe("normalizeProtocol", () => {
	it("reduces Cloudflare's protocol label to the semconv version", () => {
		assert.strictEqual(normalizeProtocol("HTTP/1.1"), "1.1")
		assert.strictEqual(normalizeProtocol("HTTP/2"), "2")
		assert.strictEqual(normalizeProtocol("HTTP/3"), "3")
		assert.strictEqual(normalizeProtocol(null), "unknown")
		// Anything that isn't the documented shape passes through rather than being mangled.
		assert.strictEqual(normalizeProtocol("SPDY"), "SPDY")
	})
})

describe("mapHttpPathGroups", () => {
	const base = { orgId: "org_test", zoneId: "zone-1", zoneName: "example.com" }
	const group = (path: string, count: number, bytes = 0) => ({
		count,
		avg: { sampleInterval: 10 },
		sum: { edgeResponseBytes: bytes },
		dimensions: { datetimeFiveMinutes: BUCKET, clientRequestPath: path },
	})

	it("emits requests, bytes and errors under one url.path attribute", () => {
		const { sumRows, gaugeRows } = mapHttpPathGroups({
			...base,
			groups: [group("/api/users", 10, 5000)],
			errors: [group("/api/users", 2)],
		})
		assert.strictEqual(gaugeRows.length, 0)
		const byMetric = new Map(sumRows.map((row) => [row.metric_name, row]))
		assert.strictEqual(byMetric.get(METRIC_HTTP_REQUESTS_BY_PATH)?.value, 100)
		assert.strictEqual(byMetric.get(METRIC_HTTP_BYTES_BY_PATH)?.value, 5000)
		assert.strictEqual(byMetric.get(METRIC_HTTP_ERRORS_BY_PATH)?.value, 20)
		for (const row of sumRows) {
			assert.strictEqual(row.metric_attributes["url.path"], "/api/users")
			assert.strictEqual(row.service_name, "cloudflare/example.com")
			assert.strictEqual(row.scope_name, SCOPE_NAME)
		}
	})

	it('keeps the top-N paths and folds the tail into "other"', () => {
		const groups = Array.from({ length: MAX_HTTP_PATHS + 5 }, (_, i) => group(`/p${i}`, 100 - i))
		const { sumRows } = mapHttpPathGroups({ ...base, groups, errors: [] })
		const requestRows = sumRows.filter((row) => row.metric_name === METRIC_HTTP_REQUESTS_BY_PATH)
		const paths = new Set(requestRows.map((row) => row.metric_attributes["url.path"]))
		assert.strictEqual(paths.size, MAX_HTTP_PATHS + 1)
		assert.isTrue(paths.has("other"))
		assert.isTrue(paths.has("/p0"))
		assert.isFalse(paths.has(`/p${MAX_HTTP_PATHS + 4}`))
		// Folding relabels, never drops.
		assert.strictEqual(
			requestRows.reduce((sum, row) => sum + row.value, 0),
			groups.reduce((sum, g) => sum + g.count * 10, 0),
		)
	})

	it("ranks across both selections so an error-only path folds to the same key", () => {
		// /rare has no traffic row at all, but enough error weight to outrank the filler paths.
		const filler = Array.from({ length: MAX_HTTP_PATHS /* heaviest first */ }, (_, i) =>
			group(`/p${i}`, 100 - i),
		)
		const { sumRows } = mapHttpPathGroups({
			...base,
			groups: filler,
			errors: [group("/rare", 1000)],
		})
		const errorRow = sumRows.find((row) => row.metric_name === METRIC_HTTP_ERRORS_BY_PATH)
		assert.strictEqual(errorRow?.metric_attributes["url.path"], "/rare")
		// Ranking by combined weight pushes the lightest traffic path out instead.
		const paths = new Set(
			sumRows
				.filter((row) => row.metric_name === METRIC_HTTP_REQUESTS_BY_PATH)
				.map((row) => row.metric_attributes["url.path"]),
		)
		assert.isTrue(paths.has("other"))
	})

	it("skips zero-valued counters", () => {
		const { sumRows } = mapHttpPathGroups({
			...base,
			groups: [group("/empty", 0, 0)],
			errors: [],
		})
		assert.strictEqual(sumRows.length, 0)
	})
})

describe("mapHttpDimensionGroups", () => {
	const base = { orgId: "org_test", zoneId: "zone-1", zoneName: "example.com" }

	it("maps country groups to ISO-code attributes on requests and bytes", () => {
		const { sumRows } = mapHttpDimensionGroups({
			...base,
			countries: [
				{
					count: 4,
					avg: { sampleInterval: 10 },
					sum: { edgeResponseBytes: 900 },
					dimensions: { datetimeFiveMinutes: BUCKET, clientCountryName: "DE" },
				},
			],
			clients: [],
		})
		const requests = sumRows.find((row) => row.metric_name === METRIC_HTTP_REQUESTS_BY_COUNTRY)
		const bytes = sumRows.find((row) => row.metric_name === METRIC_HTTP_BYTES_BY_COUNTRY)
		assert.strictEqual(requests?.value, 40)
		assert.strictEqual(requests?.metric_attributes["geo.country_iso_code"], "DE")
		assert.strictEqual(bytes?.value, 900)
	})

	it("carries method, protocol and device on one cross-filterable series", () => {
		const { sumRows } = mapHttpDimensionGroups({
			...base,
			countries: [],
			clients: [
				{
					count: 3,
					avg: { sampleInterval: 1 },
					dimensions: {
						datetimeFiveMinutes: BUCKET,
						clientRequestHTTPMethodName: "POST",
						clientRequestHTTPProtocol: "HTTP/2",
						clientDeviceType: "mobile",
					},
				},
			],
		})
		assert.strictEqual(sumRows.length, 1)
		const row = sumRows[0]!
		assert.strictEqual(row.metric_name, METRIC_HTTP_REQUESTS_BY_CLIENT)
		assert.strictEqual(row.timestamp, BUCKET_TS)
		assert.deepStrictEqual(row.metric_attributes, {
			"http.request.method": "POST",
			"network.protocol.version": "2",
			"cloudflare.device.type": "mobile",
		})
	})

	it("labels missing dimensions rather than dropping the group", () => {
		const { sumRows } = mapHttpDimensionGroups({
			...base,
			countries: [],
			clients: [
				{
					count: 1,
					avg: { sampleInterval: 1 },
					dimensions: {
						datetimeFiveMinutes: BUCKET,
						clientRequestHTTPMethodName: null,
						clientRequestHTTPProtocol: null,
						clientDeviceType: null,
					},
				},
			],
		})
		assert.deepStrictEqual(sumRows[0]?.metric_attributes, {
			"http.request.method": "unknown",
			"network.protocol.version": "unknown",
			"cloudflare.device.type": "unknown",
		})
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

	it("drops groups for scripts missing from the live-script set", () => {
		const stale = {
			sum: { requests: 7, errors: 0, subrequests: 0 },
			quantiles: null,
			dimensions: {
				datetimeFiveMinutes: BUCKET,
				scriptName: "maple-alerting-pr-42",
				status: "success",
			},
		}
		const { sumRows } = mapWorkersGroups({
			...input,
			groups: [...input.groups, stale],
			liveScripts: new Set(["my-worker"]),
		})
		assert.isTrue(sumRows.length > 0)
		assert.isTrue(sumRows.every((row) => row.service_name === "cloudflare-worker/my-worker"))
	})

	it("emits everything when the live-script set is unavailable", () => {
		const { sumRows } = mapWorkersGroups({ ...input, liveScripts: null })
		assert.isTrue(sumRows.some((row) => row.service_name === "cloudflare-worker/my-worker"))
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

describe("mapFirewallGroups", () => {
	it("emits ABR-scaled event counts with action/source/rule/host attributes", () => {
		const { sumRows, gaugeRows } = mapFirewallGroups({
			orgId: "org_test",
			zoneId: "zone-1",
			zoneName: "example.com",
			groups: [
				{
					count: 5,
					avg: { sampleInterval: 4 },
					dimensions: {
						datetimeFiveMinutes: BUCKET,
						action: "block",
						source: "waf",
						ruleId: "rule-1",
						clientRequestHTTPHost: "api.example.com",
					},
				},
			],
		})
		assert.strictEqual(gaugeRows.length, 0)
		assert.strictEqual(sumRows.length, 1)
		const row = sumRows[0]!
		assert.strictEqual(row.metric_name, METRIC_FIREWALL_EVENTS)
		assert.strictEqual(row.value, 20)
		assert.strictEqual(row.service_name, "cloudflare/example.com")
		assert.deepStrictEqual(row.metric_attributes, {
			"firewall.action": "block",
			"firewall.source": "waf",
			"firewall.rule_id": "rule-1",
			"server.address": "api.example.com",
		})
	})
})

describe("mapDnsGroups", () => {
	it('folds query names past the top N into "other" and keeps response codes', () => {
		const groups = Array.from({ length: MAX_DNS_QUERY_NAMES + 5 }, (_, i) => ({
			count: 100 - i,
			avg: { sampleInterval: 1 },
			dimensions: {
				datetimeFiveMinutes: BUCKET,
				queryName: `q${i}.example.com`,
				responseCode: "NOERROR",
			},
		}))
		const { sumRows } = mapDnsGroups({
			orgId: "org_test",
			zoneId: "zone-1",
			zoneName: "example.com",
			groups,
		})
		const names = new Set(sumRows.map((row) => row.metric_attributes["dns.query_name"]))
		assert.strictEqual(names.size, MAX_DNS_QUERY_NAMES + 1)
		assert.isTrue(names.has("other"))
		assert.isTrue(sumRows.every((row) => row.metric_name === METRIC_DNS_QUERIES))
		assert.isTrue(sumRows.every((row) => row.metric_attributes["dns.response_code"] === "NOERROR"))
	})
})

describe("queue + durable object mappers", () => {
	it("maps backlog and concurrency to gauges under cloudflare-queue/{id}, keeping zeros", () => {
		const backlog = mapQueueBacklogGroups({
			orgId: "org_test",
			accountId: "acct-1",
			groups: [
				{
					avg: { messages: 0, bytes: 1024, sampleInterval: 1 },
					dimensions: { datetimeFiveMinutes: BUCKET, queueId: "queue-abc" },
				},
			],
		})
		assert.strictEqual(backlog.sumRows.length, 0)
		const messages = backlog.gaugeRows.find((row) => row.metric_name === METRIC_QUEUE_BACKLOG_MESSAGES)
		// A drained queue (backlog 0) is a meaningful reading — gauges must not skip zeros.
		assert.strictEqual(messages!.value, 0)
		assert.strictEqual(messages!.service_name, "cloudflare-queue/queue-abc")
		assert.strictEqual(messages!.resource_attributes["cloudflare.queue.id"], "queue-abc")
		const bytes = backlog.gaugeRows.find((row) => row.metric_name === METRIC_QUEUE_BACKLOG_BYTES)
		assert.strictEqual(bytes!.value, 1024)

		const consumers = mapQueueConsumersGroups({
			orgId: "org_test",
			accountId: "acct-1",
			groups: [
				{
					avg: { concurrency: 3, sampleInterval: 1 },
					dimensions: { datetimeFiveMinutes: BUCKET, queueId: "queue-abc" },
				},
			],
		})
		assert.strictEqual(consumers.gaugeRows[0]!.metric_name, METRIC_QUEUE_CONSUMER_CONCURRENCY)
		assert.strictEqual(consumers.gaugeRows[0]!.value, 3)
	})

	it("maps durable objects onto the implementing worker's service and normalizes wallTime µs→ms", () => {
		const { sumRows, gaugeRows } = mapDurableObjectsGroups({
			orgId: "org_test",
			accountId: "acct-1",
			groups: [
				{
					sum: { requests: 10, errors: 1 },
					quantiles: { wallTimeP50: 2000, wallTimeP99: 50_000 },
					dimensions: { datetimeFiveMinutes: BUCKET, scriptName: "my-worker" },
				},
				{
					sum: { requests: 7, errors: 0 },
					quantiles: null,
					dimensions: { datetimeFiveMinutes: BUCKET, scriptName: "deleted-worker" },
				},
			],
			liveScripts: new Set(["my-worker"]),
		})
		assert.isTrue(sumRows.every((row) => row.service_name === "cloudflare-worker/my-worker"))
		assert.strictEqual(sumRows.find((row) => row.metric_name === METRIC_DO_REQUESTS)!.value, 10)
		assert.strictEqual(sumRows.find((row) => row.metric_name === METRIC_DO_ERRORS)!.value, 1)
		const wallTimes = gaugeRows.filter((row) => row.metric_name === METRIC_DO_WALL_TIME)
		assert.deepStrictEqual(
			wallTimes.map((row) => [row.metric_attributes.quantile, row.value]),
			[
				["0.5", 2],
				["0.99", 50],
			],
		)
	})
})

describe("query documents", () => {
	it("http query includes the eyeball filter and dimensional selections", () => {
		const doc = zoneAnalyticsDocument([httpSelection({ withQuantiles: true })])
		assert.include(doc, 'requestSource: "eyeball"')
		assert.include(doc, "datetime_geq: $start")
		assert.include(doc, "cacheStatus")
		assert.include(doc, "edgeResponseStatus")
		assert.include(doc, "clientRequestHTTPHost")
		assert.include(doc, "orderBy: [count_DESC]")
		assert.include(doc, "edgeTimeToFirstByteMsP95")
		assert.include(doc, "originResponseDurationMsP99")
		assert.include(doc, "sampleInterval")
	})

	it("http latency selection stays dimension-light (no host dimension)", () => {
		const doc = httpSelection({ withQuantiles: true })
		const latency = doc.slice(doc.indexOf("latency:"))
		assert.notInclude(latency, "clientRequestHTTPHost")
	})

	it("path selection asks for clientRequestPath under both aliases", () => {
		const doc = httpPathsSelection({ withQuantiles: true })
		assert.include(doc, "paths: httpRequestsAdaptiveGroups")
		assert.include(doc, "pathErrors: httpRequestsAdaptiveGroups")
		assert.include(doc, "clientRequestPath")
		assert.include(doc, "edgeResponseStatus_geq: 500")
		assert.include(doc, "orderBy: [count_DESC]")
		assert.include(doc, 'requestSource: "eyeball"')
		// Paths must NOT ride the main cube's dimensions — that is what would blow GROUP_LIMIT.
		assert.notInclude(doc, "cacheStatus")
		assert.notInclude(doc, "clientRequestHTTPHost")
	})

	it("dimension selection keeps country separate from the bounded client dimensions", () => {
		const doc = httpDimensionsSelection({ withQuantiles: true })
		const country = doc.slice(doc.indexOf("countryAgg:"), doc.indexOf("clientAgg:"))
		const client = doc.slice(doc.indexOf("clientAgg:"))
		assert.include(country, "clientCountryName")
		assert.notInclude(country, "clientDeviceType")
		assert.include(client, "clientRequestHTTPMethodName")
		assert.include(client, "clientRequestHTTPProtocol")
		assert.include(client, "clientDeviceType")
		assert.notInclude(client, "clientCountryName")
	})

	it("batches the new zone datasets into one document with the HTTP cube", () => {
		const doc = zoneAnalyticsDocument([
			httpSelection({ withQuantiles: true }),
			httpPathsSelection({ withQuantiles: true }),
			httpDimensionsSelection({ withQuantiles: true }),
		])
		// One document, four extra aliases — no extra GraphQL call in steady state.
		for (const alias of ["groups:", "latency:", "paths:", "pathErrors:", "countryAgg:", "clientAgg:"]) {
			assert.include(doc, alias)
		}
		assert.strictEqual(doc.match(/zones\(filter:/g)?.length, 1)
	})

	it("http query drops the quantile selection in degraded mode", () => {
		const doc = httpSelection({ withQuantiles: false })
		assert.notInclude(doc, "edgeTimeToFirstByteMs")
		assert.include(doc, "cacheStatus")
	})

	it("workers query toggles quantiles", () => {
		assert.include(workersSelection({ withQuantiles: true }), "cpuTimeP99")
		assert.notInclude(workersSelection({ withQuantiles: false }), "cpuTimeP99")
	})

	it("batched documents nest selections under the shared zone/account nodes", () => {
		const zoneDoc = zoneAnalyticsDocument(["      alias1: x { count }", "      alias2: y { count }"])
		assert.include(zoneDoc, "zones(filter: { zoneTag_in: $zoneTags })")
		assert.include(zoneDoc, "zoneTag")
		assert.isBelow(zoneDoc.indexOf("alias1:"), zoneDoc.indexOf("alias2:"))
		const accountDoc = accountAnalyticsDocument([workersSelection({ withQuantiles: false })])
		assert.include(accountDoc, "accounts(filter: { accountTag: $accountTag })")
		assert.include(accountDoc, "invocations: workersInvocationsAdaptive")
	})

	it("top-traffic query renders only the filters present, values as variables", () => {
		const bare = topTrafficQuery({ dimension: "path", limit: 15 })
		assert.notInclude(bare, "clientRequestPath_like")
		assert.notInclude(bare, "$pathLike")

		const filtered = topTrafficQuery({
			dimension: "path",
			limit: 15,
			filter: { contains: "/api", countries: ["DE"] },
		})
		assert.include(filtered, "$pathLike: string")
		assert.include(filtered, "$countries: [string!]")
		assert.include(filtered, "clientRequestPath_like: $pathLike")
		assert.include(filtered, "clientCountryName_in: $countries")
		// Filters apply to BOTH the total and the 5xx selection, or the error rate would be wrong.
		assert.strictEqual(filtered.match(/clientRequestPath_like/g)?.length, 2)
		// Absent keys are omitted entirely — Cloudflare rejects explicit nulls inconsistently.
		assert.notInclude(filtered, "cacheStatus_in")
	})

	it("top-traffic filter values never reach the document text", () => {
		const filter = { contains: '" } evil {', hosts: ["a'; --"] }
		const doc = topTrafficQuery({ dimension: "path", limit: 15, filter })
		assert.notInclude(doc, "evil")
		assert.notInclude(doc, "a'; --")
		// They travel as variables instead, with the wildcards we add.
		assert.deepStrictEqual(topTrafficFilterVariables(filter), {
			pathLike: '%" } evil {%',
			hosts: ["a'; --"],
		})
	})

	it("top-traffic filter variables skip empty arrays and blank strings", () => {
		assert.deepStrictEqual(
			topTrafficFilterVariables({ contains: "", hosts: [], countries: undefined }),
			{},
		)
	})

	it("settings query includes zones only when requested", () => {
		assert.include(settingsQuery({ withZones: true }), "httpRequestsAdaptiveGroups")
		assert.notInclude(settingsQuery({ withZones: false }), "zoneTag_in")
		assert.include(settingsQuery({ withZones: false }), "workersInvocationsAdaptive")
	})

	it("settings query probes every registered dataset", () => {
		const doc = settingsQuery({ withZones: true })
		for (const node of [
			"firewallEventsAdaptiveGroups",
			"dnsAnalyticsAdaptiveGroups",
			"queueBacklogAdaptiveGroups",
			"queueConsumerMetricsAdaptiveGroups",
			"durableObjectsInvocationsAdaptiveGroups",
		]) {
			assert.include(doc, node)
		}
	})

	it("new dataset selections carry their aliases and dimensions", () => {
		const fw = firewallSelection({ withQuantiles: true })
		assert.include(fw, "firewall: firewallEventsAdaptiveGroups")
		for (const dim of ["action", "source", "ruleId", "clientRequestHTTPHost"]) assert.include(fw, dim)
		const dns = dnsSelection({ withQuantiles: true })
		assert.include(dns, "dns: dnsAnalyticsAdaptiveGroups")
		assert.include(dns, "queryName")
		assert.include(dns, "responseCode")
		assert.include(
			queueBacklogSelection({ withQuantiles: true }),
			"queueBacklog: queueBacklogAdaptiveGroups",
		)
		assert.include(
			queueConsumersSelection({ withQuantiles: true }),
			"queueConsumers: queueConsumerMetricsAdaptiveGroups",
		)
		const doQ = durableObjectsSelection({ withQuantiles: true })
		assert.include(doQ, "durableObjects: durableObjectsInvocationsAdaptiveGroups")
		assert.include(doQ, "wallTimeP99")
		assert.notInclude(durableObjectsSelection({ withQuantiles: false }), "wallTimeP99")
	})

	it("formats GraphQL Time at second precision", () => {
		assert.strictEqual(toGraphqlTime(Date.parse("2026-07-02T12:00:00.400Z")), "2026-07-02T12:00:00Z")
	})
})

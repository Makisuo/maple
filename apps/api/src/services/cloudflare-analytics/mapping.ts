/**
 * Pure mapping from decoded Cloudflare GraphQL analytics groups to Tinybird metric rows
 * (`metrics_sum` / `metrics_gauge`, collector-exporter shape — the same row layout
 * `apps/api/src/services/demo/fixtures.ts` writes).
 *
 * Conventions:
 * - ServiceName `cloudflare/{zoneName}` for edge HTTP metrics (matches the Logpush ingest path)
 *   and `cloudflare-worker/{scriptName}` for Workers metrics.
 * - Counters are DELTA sums (`aggregation_temporality: 1`): each 5-minute bucket is an
 *   independent increment, which is exactly what the GraphQL API returns. Chart with sum/rate.
 * - Pre-computed percentiles are gauges with a `quantile` attribute ("0.5" | "0.95" | "0.99")
 *   so one query grouped by `attr.quantile` renders all lines.
 * - ABR sampling: true request count = `count × avg.sampleInterval`; `sum.*` fields are already
 *   sampling-adjusted by Cloudflare, so they pass through untouched.
 */
import { fmtMetricTs, type MetricGaugeRow, type MetricSumRow } from "../../lib/metric-rows"
import type {
	DnsGroupShape,
	DurableObjectsGroupShape,
	FirewallGroupShape,
	HttpGroupShape,
	HttpLatencyGroupShape,
	QueueBacklogGroupShape,
	QueueConsumersGroupShape,
	WorkersGroupShape,
} from "./queries"

type Attrs = Record<string, string>

export const SCOPE_NAME = "@maple/cloudflare-analytics"

export const METRIC_HTTP_REQUESTS = "cloudflare.http.requests"
export const METRIC_HTTP_BYTES = "cloudflare.http.bytes"
export const METRIC_HTTP_VISITS = "cloudflare.http.visits"
export const METRIC_HTTP_EDGE_TTFB = "cloudflare.http.edge.ttfb"
export const METRIC_HTTP_ORIGIN_DURATION = "cloudflare.http.origin.duration"
export const METRIC_WORKER_REQUESTS = "cloudflare.worker.requests"
export const METRIC_WORKER_ERRORS = "cloudflare.worker.errors"
export const METRIC_WORKER_CPU_TIME = "cloudflare.worker.cpu_time"
export const METRIC_WORKER_DURATION = "cloudflare.worker.duration"
export const METRIC_FIREWALL_EVENTS = "cloudflare.firewall.events"
export const METRIC_DNS_QUERIES = "cloudflare.dns.queries"
export const METRIC_QUEUE_BACKLOG_MESSAGES = "cloudflare.queue.backlog.messages"
export const METRIC_QUEUE_BACKLOG_BYTES = "cloudflare.queue.backlog.bytes"
export const METRIC_QUEUE_CONSUMER_CONCURRENCY = "cloudflare.queue.consumer.concurrency"
export const METRIC_DO_REQUESTS = "cloudflare.durable_object.requests"
export const METRIC_DO_ERRORS = "cloudflare.durable_object.errors"
export const METRIC_DO_WALL_TIME = "cloudflare.durable_object.wall_time"

export type { MetricGaugeRow, MetricSumRow }

export interface CloudflareMetricRows {
	sumRows: MetricSumRow[]
	gaugeRows: MetricGaugeRow[]
}

/** GraphQL buckets arrive as RFC 3339 datetimes ("2026-07-03T10:05:00Z"). */
const bucketToTs = (bucket: string): string => fmtMetricTs(Date.parse(bucket))

const DELTA_TEMPORALITY = 1

const baseRow = (options: {
	readonly bucket: string
	readonly metricName: string
	readonly description: string
	readonly unit: string
	readonly attributes: Attrs
	readonly serviceName: string
	readonly resourceAttributes: Attrs
	readonly value: number
}): MetricGaugeRow => {
	const ts = bucketToTs(options.bucket)
	return {
		timestamp: ts,
		start_timestamp: ts,
		metric_name: options.metricName,
		metric_description: options.description,
		metric_unit: options.unit,
		metric_attributes: options.attributes,
		service_name: options.serviceName,
		resource_schema_url: "",
		resource_attributes: options.resourceAttributes,
		scope_schema_url: "",
		scope_name: SCOPE_NAME,
		scope_version: "",
		scope_attributes: {},
		value: options.value,
		flags: 0,
		exemplars_trace_id: [],
		exemplars_span_id: [],
		exemplars_timestamp: [],
		exemplars_value: [],
		exemplars_filtered_attributes: [],
	}
}

const sumRow = (options: Parameters<typeof baseRow>[0]): MetricSumRow => ({
	...baseRow(options),
	aggregation_temporality: DELTA_TEMPORALITY,
	is_monotonic: true,
})

/** Collapse a raw edge status (e.g. 503) into its class ("5xx"); out-of-range → "unknown". */
export const statusClass = (status: number | null | undefined): string => {
	if (status == null || status < 100 || status > 599) return "unknown"
	return `${Math.floor(status / 100)}xx`
}

/** ABR sampling: true event count = `count × avg.sampleInterval` (guarding a missing/zero interval). */
export const abrCount = (count: number, sampleInterval: number | null | undefined): number =>
	Math.round(count * (sampleInterval != null && sampleInterval > 0 ? sampleInterval : 1))

/**
 * Attribute-cardinality cap for unbounded GraphQL dimensions (hostnames, WAF rule ids, DNS query
 * names): keep the N heaviest values per zone/window, fold the tail into {@link OTHER_BUCKET}.
 */
export const MAX_HTTP_HOSTS = 20
export const MAX_FIREWALL_RULES = 20
export const MAX_DNS_QUERY_NAMES = 20
export const OTHER_BUCKET = "other"

/** Top-N keys by weight; ties break lexicographically so folding is deterministic across runs. */
export const topNKeys = (weights: ReadonlyMap<string, number>, n: number): ReadonlySet<string> =>
	new Set(
		[...weights.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, n)
			.map(([key]) => key),
	)

const httpResourceAttrs = (orgId: string, zoneId: string, zoneName: string): Attrs => ({
	maple_org_id: orgId,
	"service.name": `cloudflare/${zoneName}`,
	"cloud.provider": "cloudflare",
	"cloudflare.zone.id": zoneId,
})

export interface MapHttpGroupsInput {
	readonly orgId: string
	readonly zoneId: string
	readonly zoneName: string
	readonly groups: ReadonlyArray<HttpGroupShape>
	readonly latency: ReadonlyArray<HttpLatencyGroupShape>
}

export const mapHttpGroups = (input: MapHttpGroupsInput): CloudflareMetricRows => {
	const serviceName = `cloudflare/${input.zoneName}`
	const resourceAttributes = httpResourceAttrs(input.orgId, input.zoneId, input.zoneName)
	const sumRows: MetricSumRow[] = []
	const gaugeRows: MetricGaugeRow[] = []

	// Hostnames are user-controlled and effectively unbounded — rank them by ABR-adjusted request
	// weight across the whole window and fold everything past the top N into "other" so metric
	// attribute cardinality stays bounded no matter what GraphQL returns.
	const hostWeights = new Map<string, number>()
	for (const group of input.groups) {
		const host = group.dimensions.clientRequestHTTPHost ?? "unknown"
		hostWeights.set(
			host,
			(hostWeights.get(host) ?? 0) + abrCount(group.count, group.avg?.sampleInterval),
		)
	}
	const topHosts = topNKeys(hostWeights, MAX_HTTP_HOSTS)

	for (const group of input.groups) {
		const bucket = group.dimensions.datetimeFiveMinutes
		const host = group.dimensions.clientRequestHTTPHost ?? "unknown"
		const attributes: Attrs = {
			"cache.status": group.dimensions.cacheStatus ?? "unknown",
			"http.status_class": statusClass(group.dimensions.edgeResponseStatus),
			"http.host": topHosts.has(host) ? host : OTHER_BUCKET,
		}
		const counters: ReadonlyArray<readonly [string, string, string, number]> = [
			[
				METRIC_HTTP_REQUESTS,
				"Edge HTTP requests (ABR-adjusted estimate)",
				"{requests}",
				abrCount(group.count, group.avg?.sampleInterval),
			],
			[METRIC_HTTP_BYTES, "Edge response bytes served", "By", group.sum?.edgeResponseBytes ?? 0],
			[METRIC_HTTP_VISITS, "Edge visits (initial page loads)", "{visits}", group.sum?.visits ?? 0],
		]
		for (const [metricName, description, unit, value] of counters) {
			if (value <= 0) continue
			sumRows.push(
				sumRow({ bucket, metricName, description, unit, attributes, serviceName, resourceAttributes, value }),
			)
		}
	}

	for (const group of input.latency) {
		const bucket = group.dimensions.datetimeFiveMinutes
		const quantiles = group.quantiles
		if (!quantiles) continue
		const ttfb: ReadonlyArray<readonly [string, number | null | undefined]> = [
			["0.5", quantiles.edgeTimeToFirstByteMsP50],
			["0.95", quantiles.edgeTimeToFirstByteMsP95],
			["0.99", quantiles.edgeTimeToFirstByteMsP99],
		]
		for (const [quantile, value] of ttfb) {
			if (value == null) continue
			gaugeRows.push(
				baseRow({
					bucket,
					metricName: METRIC_HTTP_EDGE_TTFB,
					description: "Edge time to first byte",
					unit: "ms",
					attributes: { quantile },
					serviceName,
					resourceAttributes,
					value,
				}),
			)
		}
		const origin: ReadonlyArray<readonly [string, number | null | undefined]> = [
			["0.5", quantiles.originResponseDurationMsP50],
			["0.95", quantiles.originResponseDurationMsP95],
			["0.99", quantiles.originResponseDurationMsP99],
		]
		for (const [quantile, value] of origin) {
			if (value == null) continue
			gaugeRows.push(
				baseRow({
					bucket,
					metricName: METRIC_HTTP_ORIGIN_DURATION,
					description: "Origin response duration (uncached requests)",
					unit: "ms",
					attributes: { quantile },
					serviceName,
					resourceAttributes,
					value,
				}),
			)
		}
	}

	return { sumRows, gaugeRows }
}

/** Weight-rank an unbounded dimension across a window and fold the tail into {@link OTHER_BUCKET}. */
const foldTail = (
	weights: ReadonlyMap<string, number>,
	n: number,
): ((key: string) => string) => {
	const top = topNKeys(weights, n)
	return (key) => (top.has(key) ? key : OTHER_BUCKET)
}

export interface MapFirewallGroupsInput {
	readonly orgId: string
	readonly zoneId: string
	readonly zoneName: string
	readonly groups: ReadonlyArray<FirewallGroupShape>
}

export const mapFirewallGroups = (input: MapFirewallGroupsInput): CloudflareMetricRows => {
	const serviceName = `cloudflare/${input.zoneName}`
	const resourceAttributes = httpResourceAttrs(input.orgId, input.zoneId, input.zoneName)
	const sumRows: MetricSumRow[] = []

	// Rule ids and hostnames are unbounded — cap both to their per-window top N by event weight.
	const ruleWeights = new Map<string, number>()
	const hostWeights = new Map<string, number>()
	for (const group of input.groups) {
		const weight = abrCount(group.count, group.avg?.sampleInterval)
		const rule = group.dimensions.ruleId ?? "unknown"
		const host = group.dimensions.clientRequestHTTPHost ?? "unknown"
		ruleWeights.set(rule, (ruleWeights.get(rule) ?? 0) + weight)
		hostWeights.set(host, (hostWeights.get(host) ?? 0) + weight)
	}
	const foldRule = foldTail(ruleWeights, MAX_FIREWALL_RULES)
	const foldHost = foldTail(hostWeights, MAX_HTTP_HOSTS)

	for (const group of input.groups) {
		const value = abrCount(group.count, group.avg?.sampleInterval)
		if (value <= 0) continue
		sumRows.push(
			sumRow({
				bucket: group.dimensions.datetimeFiveMinutes,
				metricName: METRIC_FIREWALL_EVENTS,
				description: "Firewall/WAF security events (ABR-adjusted estimate)",
				unit: "{events}",
				attributes: {
					"firewall.action": group.dimensions.action ?? "unknown",
					"firewall.source": group.dimensions.source ?? "unknown",
					"firewall.rule_id": foldRule(group.dimensions.ruleId ?? "unknown"),
					"http.host": foldHost(group.dimensions.clientRequestHTTPHost ?? "unknown"),
				},
				serviceName,
				resourceAttributes,
				value,
			}),
		)
	}

	return { sumRows, gaugeRows: [] }
}

export interface MapDnsGroupsInput {
	readonly orgId: string
	readonly zoneId: string
	readonly zoneName: string
	readonly groups: ReadonlyArray<DnsGroupShape>
}

export const mapDnsGroups = (input: MapDnsGroupsInput): CloudflareMetricRows => {
	const serviceName = `cloudflare/${input.zoneName}`
	const resourceAttributes = httpResourceAttrs(input.orgId, input.zoneId, input.zoneName)
	const sumRows: MetricSumRow[] = []

	// Query names are user-controlled and unbounded (subdomain-per-user patterns, NXDOMAIN
	// scanning) — the top-N cap here is mandatory, not a safety net.
	const nameWeights = new Map<string, number>()
	for (const group of input.groups) {
		const name = group.dimensions.queryName ?? "unknown"
		nameWeights.set(
			name,
			(nameWeights.get(name) ?? 0) + abrCount(group.count, group.avg?.sampleInterval),
		)
	}
	const foldName = foldTail(nameWeights, MAX_DNS_QUERY_NAMES)

	for (const group of input.groups) {
		const value = abrCount(group.count, group.avg?.sampleInterval)
		if (value <= 0) continue
		sumRows.push(
			sumRow({
				bucket: group.dimensions.datetimeFiveMinutes,
				metricName: METRIC_DNS_QUERIES,
				description: "Authoritative DNS queries (ABR-adjusted estimate)",
				unit: "{queries}",
				attributes: {
					"dns.query_name": foldName(group.dimensions.queryName ?? "unknown"),
					"dns.response_code": group.dimensions.responseCode ?? "unknown",
				},
				serviceName,
				resourceAttributes,
				value,
			}),
		)
	}

	return { sumRows, gaugeRows: [] }
}

const queueResourceAttrs = (orgId: string, accountId: string, queueId: string): Attrs => ({
	maple_org_id: orgId,
	"service.name": `cloudflare-queue/${queueId}`,
	"cloud.provider": "cloudflare",
	"cloudflare.account.id": accountId,
	"cloudflare.queue.id": queueId,
})

export interface MapQueueBacklogGroupsInput {
	readonly orgId: string
	readonly accountId: string
	readonly groups: ReadonlyArray<QueueBacklogGroupShape>
}

export const mapQueueBacklogGroups = (input: MapQueueBacklogGroupsInput): CloudflareMetricRows => {
	const gaugeRows: MetricGaugeRow[] = []
	for (const group of input.groups) {
		const queueId = group.dimensions.queueId
		const serviceName = `cloudflare-queue/${queueId}`
		const resourceAttributes = queueResourceAttrs(input.orgId, input.accountId, queueId)
		// Backlog depth is a point-in-time sample (avg over the bucket) — a gauge, and zero is a
		// meaningful reading (drained queue), so unlike counters it is NOT skipped.
		const gauges: ReadonlyArray<readonly [string, string, string, number | null | undefined]> = [
			[
				METRIC_QUEUE_BACKLOG_MESSAGES,
				"Queue backlog depth (messages awaiting delivery)",
				"{messages}",
				group.avg?.messages,
			],
			[METRIC_QUEUE_BACKLOG_BYTES, "Queue backlog size", "By", group.avg?.bytes],
		]
		for (const [metricName, description, unit, value] of gauges) {
			if (value == null) continue
			gaugeRows.push(
				baseRow({
					bucket: group.dimensions.datetimeFiveMinutes,
					metricName,
					description,
					unit,
					attributes: {},
					serviceName,
					resourceAttributes,
					value,
				}),
			)
		}
	}
	return { sumRows: [], gaugeRows }
}

export interface MapQueueConsumersGroupsInput {
	readonly orgId: string
	readonly accountId: string
	readonly groups: ReadonlyArray<QueueConsumersGroupShape>
}

export const mapQueueConsumersGroups = (
	input: MapQueueConsumersGroupsInput,
): CloudflareMetricRows => {
	const gaugeRows: MetricGaugeRow[] = []
	for (const group of input.groups) {
		const concurrency = group.avg?.concurrency
		if (concurrency == null) continue
		const queueId = group.dimensions.queueId
		gaugeRows.push(
			baseRow({
				bucket: group.dimensions.datetimeFiveMinutes,
				metricName: METRIC_QUEUE_CONSUMER_CONCURRENCY,
				description: "Queue consumer concurrency",
				unit: "{consumers}",
				attributes: {},
				serviceName: `cloudflare-queue/${queueId}`,
				resourceAttributes: queueResourceAttrs(input.orgId, input.accountId, queueId),
				value: concurrency,
			}),
		)
	}
	return { sumRows: [], gaugeRows }
}

export interface MapDurableObjectsGroupsInput {
	readonly orgId: string
	readonly accountId: string
	readonly groups: ReadonlyArray<DurableObjectsGroupShape>
	/** Same live-script filter as Workers invocations — DOs belong to their implementing Worker. */
	readonly liveScripts?: ReadonlySet<string> | null
}

export const mapDurableObjectsGroups = (
	input: MapDurableObjectsGroupsInput,
): CloudflareMetricRows => {
	const sumRows: MetricSumRow[] = []
	const gaugeRows: MetricGaugeRow[] = []
	for (const group of input.groups) {
		const scriptName = group.dimensions.scriptName
		if (input.liveScripts != null && !input.liveScripts.has(scriptName)) continue
		const bucket = group.dimensions.datetimeFiveMinutes
		// DOs live on the implementing Worker's service so the service map stays sane.
		const serviceName = `cloudflare-worker/${scriptName}`
		const resourceAttributes: Attrs = {
			maple_org_id: input.orgId,
			"service.name": serviceName,
			"cloud.provider": "cloudflare",
			"cloudflare.account.id": input.accountId,
		}

		const counters: ReadonlyArray<readonly [string, string, string, number]> = [
			[METRIC_DO_REQUESTS, "Durable Object requests", "{requests}", group.sum?.requests ?? 0],
			[METRIC_DO_ERRORS, "Durable Object errors", "{errors}", group.sum?.errors ?? 0],
		]
		for (const [metricName, description, unit, value] of counters) {
			if (value <= 0) continue
			sumRows.push(
				sumRow({ bucket, metricName, description, unit, attributes: {}, serviceName, resourceAttributes, value }),
			)
		}

		const quantiles = group.quantiles
		if (!quantiles) continue
		// wallTime arrives in microseconds — normalize to ms like Worker cpuTime.
		const gauges: ReadonlyArray<readonly [string, number | null | undefined]> = [
			["0.5", scale(quantiles.wallTimeP50, 1 / 1000)],
			["0.99", scale(quantiles.wallTimeP99, 1 / 1000)],
		]
		for (const [quantile, value] of gauges) {
			if (value == null) continue
			gaugeRows.push(
				baseRow({
					bucket,
					metricName: METRIC_DO_WALL_TIME,
					description: "Durable Object wall time",
					unit: "ms",
					attributes: { quantile },
					serviceName,
					resourceAttributes,
					value,
				}),
			)
		}
	}
	return { sumRows, gaugeRows }
}

export interface MapWorkersGroupsInput {
	readonly orgId: string
	readonly accountId: string
	readonly groups: ReadonlyArray<WorkersGroupShape>
	/**
	 * Live script names (REST enumeration). GraphQL returns groups for whatever produced
	 * invocations in the window — including deleted scripts (torn-down PR previews with lingering
	 * crons) — so groups outside this set are dropped. Null/undefined → enumeration unavailable
	 * (missing scope) → emit everything.
	 */
	readonly liveScripts?: ReadonlySet<string> | null
}

export const mapWorkersGroups = (input: MapWorkersGroupsInput): CloudflareMetricRows => {
	const sumRows: MetricSumRow[] = []
	const gaugeRows: MetricGaugeRow[] = []

	for (const group of input.groups) {
		const bucket = group.dimensions.datetimeFiveMinutes
		const scriptName = group.dimensions.scriptName
		if (input.liveScripts != null && !input.liveScripts.has(scriptName)) continue
		const serviceName = `cloudflare-worker/${scriptName}`
		const resourceAttributes: Attrs = {
			maple_org_id: input.orgId,
			"service.name": serviceName,
			"cloud.provider": "cloudflare",
			"cloudflare.account.id": input.accountId,
		}
		const attributes: Attrs = { "worker.status": group.dimensions.status ?? "unknown" }

		const counters: ReadonlyArray<readonly [string, string, string, number]> = [
			[METRIC_WORKER_REQUESTS, "Worker invocations", "{requests}", group.sum?.requests ?? 0],
			[METRIC_WORKER_ERRORS, "Worker invocation errors", "{errors}", group.sum?.errors ?? 0],
		]
		for (const [metricName, description, unit, value] of counters) {
			if (value <= 0) continue
			sumRows.push(
				sumRow({ bucket, metricName, description, unit, attributes, serviceName, resourceAttributes, value }),
			)
		}

		const quantiles = group.quantiles
		if (!quantiles) continue
		// cpuTime arrives in microseconds, duration in seconds — normalize both to ms.
		const gauges: ReadonlyArray<readonly [string, string, string, number | null | undefined]> = [
			[METRIC_WORKER_CPU_TIME, "Worker CPU time", "0.5", scale(quantiles.cpuTimeP50, 1 / 1000)],
			[METRIC_WORKER_CPU_TIME, "Worker CPU time", "0.99", scale(quantiles.cpuTimeP99, 1 / 1000)],
			[METRIC_WORKER_DURATION, "Worker duration (wall time billed)", "0.5", scale(quantiles.durationP50, 1000)],
			[METRIC_WORKER_DURATION, "Worker duration (wall time billed)", "0.99", scale(quantiles.durationP99, 1000)],
		]
		for (const [metricName, description, quantile, value] of gauges) {
			if (value == null) continue
			gaugeRows.push(
				baseRow({
					bucket,
					metricName,
					description,
					unit: "ms",
					attributes: { ...attributes, quantile },
					serviceName,
					resourceAttributes,
					value,
				}),
			)
		}
	}

	return { sumRows, gaugeRows }
}

const scale = (value: number | null | undefined, factor: number): number | null =>
	value == null ? null : value * factor

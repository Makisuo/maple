// ---------------------------------------------------------------------------
// Cloudflare infrastructure page data
//
// Per-zone HTTP edge analytics (`cloudflare/{zoneName}`) and per-Worker
// invocation analytics (`cloudflare-worker/{scriptName}`) written by the
// direct-integration analytics poller. Backs /infra/cloudflare. Rates are
// derived here as 0–1 ratios (×100 only at display, per repo convention).
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect"
import {
	CloudflareInfraPlatformResourcesRequest,
	CloudflareInfraWorkersRequest,
	CloudflareInfraZoneDetailRequest,
	CloudflareInfraZoneDnsRequest,
	CloudflareInfraZoneHostsRequest,
	CloudflareInfraZonesRequest,
	CloudflareInfraZoneSecurityRequest,
	CloudflareInfraZoneTimeseriesRequest,
	CloudflareTopTrafficRequest,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

const ZONE_SERVICE_PREFIX = "cloudflare/"
const WORKER_SERVICE_PREFIX = "cloudflare-worker/"

const stripPrefix = (serviceName: string, prefix: string) =>
	serviceName.startsWith(prefix) ? serviceName.slice(prefix.length) : serviceName

const ratio = (numerator: number, denominator: number) => (denominator > 0 ? numerator / denominator : 0)

export interface CloudflareZoneRow {
	serviceName: string
	/** Zone name with the `cloudflare/` prefix stripped. */
	zoneName: string
	requests: number
	errors5xx: number
	/** 5xx error ratio, 0–1. */
	errorRate: number
	cacheHits: number
	/** Served-by-cache ratio, 0–1. */
	cacheHitRate: number
	bytes: number
	visits: number
	ttfbP50Ms: number
	ttfbP95Ms: number
	ttfbP99Ms: number
	originP50Ms: number
	originP95Ms: number
	originP99Ms: number
}

export interface CloudflareZoneTimeseriesRow {
	serviceName: string
	zoneName: string
	/** Bucket start, ISO-8601 UTC. */
	bucket: string
	requests: number
	errors5xx: number
	cacheHits: number
	bytes: number
	visits: number
}

export interface CloudflareWorkerRow {
	serviceName: string
	/** Script name with the `cloudflare-worker/` prefix stripped. */
	scriptName: string
	requests: number
	errors: number
	/** Invocation error ratio, 0–1. */
	errorRate: number
	subrequests: number
	cpuP50Ms: number
	cpuP99Ms: number
	durationP50Ms: number
	durationP99Ms: number
}

const TimeRangeInputSchema = Schema.Struct({
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
})

const TimeseriesInputSchema = Schema.Struct({
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	bucketSeconds: Schema.Number,
})

export type CloudflareInfraTimeRangeInput = (typeof TimeRangeInputSchema)["Encoded"]
export type CloudflareInfraTimeseriesInput = (typeof TimeseriesInputSchema)["Encoded"]

export const getCloudflareZones = Effect.fn("QueryEngine.getCloudflareZones")(function* ({
	data,
}: {
	data: CloudflareInfraTimeRangeInput
}) {
	const input = yield* decodeInput(TimeRangeInputSchema, data, "getCloudflareZones")
	const result = yield* runWarehouseQuery("cloudflareInfraZones", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.cloudflareInfraZones({
				payload: new CloudflareInfraZonesRequest({
					startTime: input.startTime,
					endTime: input.endTime,
				}),
			})
		}),
	)
	return {
		zones: result.data.map((row): CloudflareZoneRow => {
			const serviceName = String(row.serviceName ?? "")
			const requests = Number(row.requests ?? 0)
			const errors5xx = Number(row.errors5xx ?? 0)
			const cacheHits = Number(row.cacheHits ?? 0)
			return {
				serviceName,
				zoneName: stripPrefix(serviceName, ZONE_SERVICE_PREFIX),
				requests,
				errors5xx,
				errorRate: ratio(errors5xx, requests),
				cacheHits,
				cacheHitRate: ratio(cacheHits, requests),
				bytes: Number(row.bytes ?? 0),
				visits: Number(row.visits ?? 0),
				ttfbP50Ms: Number(row.ttfbP50Ms ?? 0),
				ttfbP95Ms: Number(row.ttfbP95Ms ?? 0),
				ttfbP99Ms: Number(row.ttfbP99Ms ?? 0),
				originP50Ms: Number(row.originP50Ms ?? 0),
				originP95Ms: Number(row.originP95Ms ?? 0),
				originP99Ms: Number(row.originP99Ms ?? 0),
			}
		}),
	}
})

export const getCloudflareZoneTimeseries = Effect.fn("QueryEngine.getCloudflareZoneTimeseries")(
	function* ({ data }: { data: CloudflareInfraTimeseriesInput }) {
		const input = yield* decodeInput(TimeseriesInputSchema, data, "getCloudflareZoneTimeseries")
		const result = yield* runWarehouseQuery("cloudflareInfraZoneTimeseries", () =>
			Effect.gen(function* () {
				const client = yield* MapleApiAtomClient
				return yield* client.queryEngine.cloudflareInfraZoneTimeseries({
					payload: new CloudflareInfraZoneTimeseriesRequest({
						startTime: input.startTime,
						endTime: input.endTime,
						bucketSeconds: input.bucketSeconds,
					}),
				})
			}),
		)
		return {
			buckets: result.data.map((row): CloudflareZoneTimeseriesRow => {
				const serviceName = String(row.serviceName ?? "")
				return {
					serviceName,
					zoneName: stripPrefix(serviceName, ZONE_SERVICE_PREFIX),
					bucket: String(row.bucket ?? ""),
					requests: Number(row.requests ?? 0),
					errors5xx: Number(row.errors5xx ?? 0),
					cacheHits: Number(row.cacheHits ?? 0),
					bytes: Number(row.bytes ?? 0),
					visits: Number(row.visits ?? 0),
				}
			}),
		}
	},
)

export interface CloudflareZoneStatusBucket {
	bucket: string
	/** `"2xx"`-style class, `"unknown"` for out-of-range statuses. */
	statusClass: string
	requests: number
}

export interface CloudflareZoneCacheBucket {
	bucket: string
	/** Cloudflare's raw lowercase cacheStatus (`hit`, `miss`, `dynamic`, …). */
	cacheStatus: string
	requests: number
}

export interface CloudflareZoneLatencyBucket {
	bucket: string
	ttfbP50Ms: number
	ttfbP95Ms: number
	ttfbP99Ms: number
	originP50Ms: number
	originP95Ms: number
	originP99Ms: number
}

const ZoneDetailInputSchema = Schema.Struct({
	serviceName: Schema.String,
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	bucketSeconds: Schema.Number,
})

export type CloudflareZoneDetailInput = (typeof ZoneDetailInputSchema)["Encoded"]

export const getCloudflareZoneDetail = Effect.fn("QueryEngine.getCloudflareZoneDetail")(function* ({
	data,
}: {
	data: CloudflareZoneDetailInput
}) {
	const input = yield* decodeInput(ZoneDetailInputSchema, data, "getCloudflareZoneDetail")
	const result = yield* runWarehouseQuery("cloudflareInfraZoneDetail", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.cloudflareInfraZoneDetail({
				payload: new CloudflareInfraZoneDetailRequest({
					serviceName: input.serviceName,
					startTime: input.startTime,
					endTime: input.endTime,
					bucketSeconds: input.bucketSeconds,
				}),
			})
		}),
	)
	return {
		statusBuckets: result.statusBuckets.map(
			(row): CloudflareZoneStatusBucket => ({
				bucket: String(row.bucket ?? ""),
				statusClass: String(row.statusClass ?? "unknown"),
				requests: Number(row.requests ?? 0),
			}),
		),
		cacheBuckets: result.cacheBuckets.map(
			(row): CloudflareZoneCacheBucket => ({
				bucket: String(row.bucket ?? ""),
				cacheStatus: String(row.cacheStatus ?? "unknown"),
				requests: Number(row.requests ?? 0),
			}),
		),
		latencyBuckets: result.latencyBuckets.map(
			(row): CloudflareZoneLatencyBucket => ({
				bucket: String(row.bucket ?? ""),
				ttfbP50Ms: Number(row.ttfbP50Ms ?? 0),
				ttfbP95Ms: Number(row.ttfbP95Ms ?? 0),
				ttfbP99Ms: Number(row.ttfbP99Ms ?? 0),
				originP50Ms: Number(row.originP50Ms ?? 0),
				originP95Ms: Number(row.originP95Ms ?? 0),
				originP99Ms: Number(row.originP99Ms ?? 0),
			}),
		),
	}
})

export const getCloudflareWorkers = Effect.fn("QueryEngine.getCloudflareWorkers")(function* ({
	data,
}: {
	data: CloudflareInfraTimeRangeInput
}) {
	const input = yield* decodeInput(TimeRangeInputSchema, data, "getCloudflareWorkers")
	const result = yield* runWarehouseQuery("cloudflareInfraWorkers", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.cloudflareInfraWorkers({
				payload: new CloudflareInfraWorkersRequest({
					startTime: input.startTime,
					endTime: input.endTime,
				}),
			})
		}),
	)
	return {
		workers: result.data.map((row): CloudflareWorkerRow => {
			const serviceName = String(row.serviceName ?? "")
			const requests = Number(row.requests ?? 0)
			const errors = Number(row.errors ?? 0)
			return {
				serviceName,
				scriptName: stripPrefix(serviceName, WORKER_SERVICE_PREFIX),
				requests,
				errors,
				errorRate: ratio(errors, requests),
				subrequests: Number(row.subrequests ?? 0),
				cpuP50Ms: Number(row.cpuP50Ms ?? 0),
				cpuP99Ms: Number(row.cpuP99Ms ?? 0),
				durationP50Ms: Number(row.durationP50Ms ?? 0),
				durationP99Ms: Number(row.durationP99Ms ?? 0),
			}
		}),
	}
})

// ---------------------------------------------------------------------------
// Zone detail: extended sections (hosts, security, DNS) + live top traffic
// ---------------------------------------------------------------------------

export interface CloudflareZoneHostTotal {
	/** Hostname (poller-capped top N; the tail shows as "other", pre-host rows as ""). */
	host: string
	requests: number
	errors5xx: number
	/** 5xx error ratio, 0–1. */
	errorRate: number
	cacheHits: number
	/** Served-by-cache ratio, 0–1. */
	cacheHitRate: number
	bytes: number
}

export interface CloudflareZoneHostBucket {
	bucket: string
	host: string
	requests: number
}

export const getCloudflareZoneHosts = Effect.fn("QueryEngine.getCloudflareZoneHosts")(function* ({
	data,
}: {
	data: CloudflareZoneDetailInput
}) {
	const input = yield* decodeInput(ZoneDetailInputSchema, data, "getCloudflareZoneHosts")
	const result = yield* runWarehouseQuery("cloudflareInfraZoneHosts", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.cloudflareInfraZoneHosts({
				payload: new CloudflareInfraZoneHostsRequest({
					serviceName: input.serviceName,
					startTime: input.startTime,
					endTime: input.endTime,
					bucketSeconds: input.bucketSeconds,
				}),
			})
		}),
	)
	return {
		totals: result.totals.map((row): CloudflareZoneHostTotal => {
			const requests = Number(row.requests ?? 0)
			const errors5xx = Number(row.errors5xx ?? 0)
			const cacheHits = Number(row.cacheHits ?? 0)
			return {
				host: String(row.host ?? ""),
				requests,
				errors5xx,
				errorRate: ratio(errors5xx, requests),
				cacheHits,
				cacheHitRate: ratio(cacheHits, requests),
				bytes: Number(row.bytes ?? 0),
			}
		}),
		buckets: result.buckets.map(
			(row): CloudflareZoneHostBucket => ({
				bucket: String(row.bucket ?? ""),
				host: String(row.host ?? ""),
				requests: Number(row.requests ?? 0),
			}),
		),
	}
})

export interface CloudflareZoneFirewallBucket {
	bucket: string
	/** Cloudflare action: block / challenge / managed_challenge / skip / log / …. */
	action: string
	events: number
}

export interface CloudflareZoneFirewallTopRow {
	source: string
	action: string
	ruleId: string
	host: string
	events: number
}

export const getCloudflareZoneSecurity = Effect.fn("QueryEngine.getCloudflareZoneSecurity")(function* ({
	data,
}: {
	data: CloudflareZoneDetailInput
}) {
	const input = yield* decodeInput(ZoneDetailInputSchema, data, "getCloudflareZoneSecurity")
	const result = yield* runWarehouseQuery("cloudflareInfraZoneSecurity", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.cloudflareInfraZoneSecurity({
				payload: new CloudflareInfraZoneSecurityRequest({
					serviceName: input.serviceName,
					startTime: input.startTime,
					endTime: input.endTime,
					bucketSeconds: input.bucketSeconds,
				}),
			})
		}),
	)
	return {
		buckets: result.buckets.map(
			(row): CloudflareZoneFirewallBucket => ({
				bucket: String(row.bucket ?? ""),
				action: String(row.action ?? "unknown"),
				events: Number(row.events ?? 0),
			}),
		),
		top: result.top.map(
			(row): CloudflareZoneFirewallTopRow => ({
				source: String(row.source ?? "unknown"),
				action: String(row.action ?? "unknown"),
				ruleId: String(row.ruleId ?? "unknown"),
				host: String(row.host ?? "unknown"),
				events: Number(row.events ?? 0),
			}),
		),
	}
})

export interface CloudflareZoneDnsBucket {
	bucket: string
	/** DNS RCODE name (NOERROR / NXDOMAIN / SERVFAIL / …). */
	responseCode: string
	queries: number
}

export interface CloudflareZoneDnsName {
	queryName: string
	queries: number
	nxdomain: number
}

export const getCloudflareZoneDns = Effect.fn("QueryEngine.getCloudflareZoneDns")(function* ({
	data,
}: {
	data: CloudflareZoneDetailInput
}) {
	const input = yield* decodeInput(ZoneDetailInputSchema, data, "getCloudflareZoneDns")
	const result = yield* runWarehouseQuery("cloudflareInfraZoneDns", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.cloudflareInfraZoneDns({
				payload: new CloudflareInfraZoneDnsRequest({
					serviceName: input.serviceName,
					startTime: input.startTime,
					endTime: input.endTime,
					bucketSeconds: input.bucketSeconds,
				}),
			})
		}),
	)
	return {
		buckets: result.buckets.map(
			(row): CloudflareZoneDnsBucket => ({
				bucket: String(row.bucket ?? ""),
				responseCode: String(row.responseCode ?? "unknown"),
				queries: Number(row.queries ?? 0),
			}),
		),
		names: result.names.map(
			(row): CloudflareZoneDnsName => ({
				queryName: String(row.queryName ?? "unknown"),
				queries: Number(row.queries ?? 0),
				nxdomain: Number(row.nxdomain ?? 0),
			}),
		),
	}
})

export interface CloudflareQueueRow {
	serviceName: string
	/** Queue id with the `cloudflare-queue/` prefix stripped. */
	queueName: string
	backlogMessages: number
	backlogMessagesMax: number
	backlogBytes: number
	consumerConcurrency: number
}

export interface CloudflareDurableObjectRow {
	serviceName: string
	/** Implementing Worker script name. */
	scriptName: string
	requests: number
	errors: number
	/** DO error ratio, 0–1. */
	errorRate: number
}

const QUEUE_SERVICE_PREFIX = "cloudflare-queue/"

export const getCloudflarePlatformResources = Effect.fn(
	"QueryEngine.getCloudflarePlatformResources",
)(function* ({ data }: { data: CloudflareInfraTimeRangeInput }) {
	const input = yield* decodeInput(TimeRangeInputSchema, data, "getCloudflarePlatformResources")
	const result = yield* runWarehouseQuery("cloudflareInfraPlatformResources", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.cloudflareInfraPlatformResources({
				payload: new CloudflareInfraPlatformResourcesRequest({
					startTime: input.startTime,
					endTime: input.endTime,
				}),
			})
		}),
	)
	return {
		queues: result.queues.map((row): CloudflareQueueRow => {
			const serviceName = String(row.serviceName ?? "")
			return {
				serviceName,
				queueName: stripPrefix(serviceName, QUEUE_SERVICE_PREFIX),
				backlogMessages: Number(row.backlogMessages ?? 0),
				backlogMessagesMax: Number(row.backlogMessagesMax ?? 0),
				backlogBytes: Number(row.backlogBytes ?? 0),
				consumerConcurrency: Number(row.consumerConcurrency ?? 0),
			}
		}),
		durableObjects: result.durableObjects.map((row): CloudflareDurableObjectRow => {
			const serviceName = String(row.serviceName ?? "")
			const requests = Number(row.requests ?? 0)
			const errors = Number(row.errors ?? 0)
			return {
				serviceName,
				scriptName: stripPrefix(serviceName, WORKER_SERVICE_PREFIX),
				requests,
				errors,
				errorRate: ratio(errors, requests),
			}
		}),
	}
})

const TopTrafficInputSchema = Schema.Struct({
	zoneName: Schema.String,
	dimension: Schema.Literals(["host", "path"]),
	/** Epoch ms window bounds. */
	startTime: Schema.Number,
	endTime: Schema.Number,
	limit: Schema.optional(Schema.Number),
})

export type CloudflareTopTrafficInput = (typeof TopTrafficInputSchema)["Encoded"]

export interface CloudflareTopTrafficEntry {
	key: string
	requests: number
	bytes: number
	errors5xx: number
	/** 5xx error ratio, 0–1. */
	errorRate: number
}

/**
 * Live top hosts/paths straight from Cloudflare's GraphQL API (proxied +
 * briefly edge-cached by our API) — path cardinality is never stored as
 * metrics, so this is the only path-level view.
 */
export const getCloudflareTopTraffic = Effect.fn("Integrations.getCloudflareTopTraffic")(function* ({
	data,
}: {
	data: CloudflareTopTrafficInput
}) {
	const input = yield* decodeInput(TopTrafficInputSchema, data, "getCloudflareTopTraffic")
	const result = yield* runWarehouseQuery("cloudflareTopTraffic", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.integrations.cloudflareTopTraffic({
				payload: new CloudflareTopTrafficRequest({
					zoneName: input.zoneName,
					dimension: input.dimension,
					startTime: input.startTime,
					endTime: input.endTime,
					...(input.limit === undefined ? {} : { limit: input.limit }),
				}),
			})
		}),
	)
	return {
		unavailableReason: result.unavailableReason,
		rows: result.rows.map(
			(row): CloudflareTopTrafficEntry => ({
				key: row.key,
				requests: row.requests,
				bytes: row.bytes,
				errors5xx: row.errors5xx,
				errorRate: ratio(row.errors5xx, row.requests),
			}),
		),
	}
})


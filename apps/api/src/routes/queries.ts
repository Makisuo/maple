import * as CH from "@maple/query-engine/ch"
import * as Integrations from "@maple/query-engine-integrations"
import { defineQuery } from "@maple/query-engine/registry"
import { Queries as Core } from "@maple/query-engine/registry"
import type {
	CloudflareInfraZoneDetailRequest,
	ServicePlanetScaleStatsRequest,
	CloudflareInfraPlatformResourcesRequest,
	CloudflareInfraWorkerTimeseriesRequest,
	CloudflareInfraWorkersRequest,
	CloudflareInfraZoneDnsRequest,
	CloudflareInfraZoneHostsRequest,
	CloudflareInfraZoneSecurityRequest,
	CloudflareInfraZoneTimeseriesRequest,
	CloudflareInfraZonesRequest,
	FleetUtilizationTimeseriesRequest,
	GetLogRequest,
	NodeInfraTimeseriesRequest,
	PlanetScaleInfraTimeseriesRequest,
	PodInfraTimeseriesRequest,
	ServiceCloudflareStatsRequest,
	SpanDetailRequest,
	WorkloadInfraTimeseriesRequest,
} from "@maple/domain/http"
import {
	nodeMetricSpec,
	partitionWindowAround,
	podMetricSpec,
	toCloudflareFilters,
	workloadMetricSpec,
} from "@/routes/query-helpers"
import { traceCacheTtlSeconds } from "@/services/warehouse/trace-detail-cache"

/**
 * App-side half of the warehouse query registry.
 *
 * Most entries live in `@maple/query-engine/registry`. These do not, for two
 * reasons that are both about dependency direction rather than taste:
 *
 *  * The Cloudflare and PlanetScale queries are built by
 *    `@maple/query-engine-integrations`, which itself depends on
 *    `@maple/query-engine`. Declaring them in the core registry would invert
 *    that edge.
 *  * A few queries need helpers or services that belong to the API app —
 *    `partitionWindowAround`, `traceCacheTtlSeconds` — and pulling those down
 *    into the query-engine package would drag app concerns into a shared lib.
 *
 * Handlers import `Queries` from here, so the split is invisible at the call
 * site and an entry can move between the two halves without touching handlers.
 */
// --- Cloudflare / PlanetScale integration queries -------------------------
//
// These live app-side rather than in the core registry because
// `@maple/query-engine-integrations` depends on `@maple/query-engine`;
// declaring them there would invert that edge.
//
// Each entry inlines the small payload-derived prologue (`params`, `filters`,
// `base`) that used to sit in the handler. Handlers that report
// `ignoredFilters` keep their own `toCloudflareFilters` call — it is a pure
// function of the payload, so computing it in both places cannot drift, and
// which filters a metric family could not honor is presentation, not query
// construction.

const cloudflareInfraZoneCounters = defineQuery({
	id: "cloudflareInfraZoneCounters",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraZonesRequest, orgId: string) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		// Counters (metrics_sum) + percentiles (metrics_gauge) run
		// concurrently, then merge by ServiceName — same shape as
		// serviceCloudflareStats above.
		const filters = toCloudflareFilters(payload)
		return CH.compile(Integrations.cloudflareZoneCountersSQL(filters), params, {
			rowSchema: Integrations.cloudflareZoneCountersRowSchema,
		})
	},
})

const cloudflareInfraZoneLatency = defineQuery({
	id: "cloudflareInfraZoneLatency",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraZonesRequest, orgId: string) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		// Counters (metrics_sum) + percentiles (metrics_gauge) run
		// concurrently, then merge by ServiceName — same shape as
		// serviceCloudflareStats above.
		const filters = toCloudflareFilters(payload)
		return CH.compile(Integrations.cloudflareZoneLatencySQL(), params, {
			rowSchema: Integrations.cloudflareZoneLatencyRowSchema,
		})
	},
})

const cloudflareInfraZoneHostTotals = defineQuery({
	id: "cloudflareInfraZoneHostTotals",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraZoneHostsRequest, orgId: string) => {
		const params = {
			orgId: orgId,
			serviceName: payload.serviceName,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		const filters = toCloudflareFilters(payload)
		return CH.compile(Integrations.cloudflareZoneHostBreakdownSQL(filters), params, {
			rowSchema: Integrations.cloudflareZoneHostBreakdownRowSchema,
		})
	},
})

const cloudflareInfraZoneHostTimeseries = defineQuery({
	id: "cloudflareInfraZoneHostTimeseries",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraZoneHostsRequest, orgId: string) => {
		const params = {
			orgId: orgId,
			serviceName: payload.serviceName,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		const filters = toCloudflareFilters(payload)
		return CH.compile(
			Integrations.cloudflareZoneHostTimeseriesSQL(filters),
			{ ...params, bucketSeconds: payload.bucketSeconds },
			{ rowSchema: Integrations.cloudflareZoneHostTimeseriesRowSchema },
		)
	},
})

const cloudflareInfraZoneFirewallTimeseries = defineQuery({
	id: "cloudflareInfraZoneFirewallTimeseries",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraZoneSecurityRequest, orgId: string) => {
		const params = {
			orgId: orgId,
			serviceName: payload.serviceName,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		const filters = toCloudflareFilters(payload)
		return CH.compile(
			Integrations.cloudflareZoneFirewallTimeseriesSQL(filters),
			{ ...params, bucketSeconds: payload.bucketSeconds },
			{ rowSchema: Integrations.cloudflareZoneFirewallTimeseriesRowSchema },
		)
	},
})

const cloudflareInfraZoneFirewallTop = defineQuery({
	id: "cloudflareInfraZoneFirewallTop",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraZoneSecurityRequest, orgId: string) => {
		const params = {
			orgId: orgId,
			serviceName: payload.serviceName,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		const filters = toCloudflareFilters(payload)
		return CH.compile(Integrations.cloudflareZoneFirewallTopSQL(filters), params, {
			rowSchema: Integrations.cloudflareZoneFirewallTopRowSchema,
		})
	},
})

const cloudflareInfraZoneDnsTimeseries = defineQuery({
	id: "cloudflareInfraZoneDnsTimeseries",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraZoneDnsRequest, orgId: string) => {
		const params = {
			orgId: orgId,
			serviceName: payload.serviceName,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		const filters = toCloudflareFilters(payload)
		return CH.compile(
			Integrations.cloudflareZoneDnsTimeseriesSQL(filters),
			{ ...params, bucketSeconds: payload.bucketSeconds },
			{ rowSchema: Integrations.cloudflareZoneDnsTimeseriesRowSchema },
		)
	},
})

const cloudflareInfraZoneDnsBreakdown = defineQuery({
	id: "cloudflareInfraZoneDnsBreakdown",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraZoneDnsRequest, orgId: string) => {
		const params = {
			orgId: orgId,
			serviceName: payload.serviceName,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		const filters = toCloudflareFilters(payload)
		return CH.compile(Integrations.cloudflareZoneDnsBreakdownSQL(filters), params, {
			rowSchema: Integrations.cloudflareZoneDnsBreakdownRowSchema,
		})
	},
})

const cloudflareInfraWorkerCounters = defineQuery({
	id: "cloudflareInfraWorkerCounters",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraWorkersRequest, orgId: string) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		return CH.compile(Integrations.cloudflareWorkerCountersSQL(), params, {
			rowSchema: Integrations.cloudflareWorkerCountersRowSchema,
		})
	},
})

const cloudflareInfraWorkerLatency = defineQuery({
	id: "cloudflareInfraWorkerLatency",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraWorkersRequest, orgId: string) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		return CH.compile(Integrations.cloudflareWorkerLatencySQL(), params, {
			rowSchema: Integrations.cloudflareWorkerLatencyRowSchema,
		})
	},
})

const cloudflareInfraQueueGauges = defineQuery({
	id: "cloudflareInfraQueueGauges",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraPlatformResourcesRequest, orgId: string) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		return CH.compile(Integrations.cloudflareQueueGaugesSQL(), params, {
			rowSchema: Integrations.cloudflareQueueGaugesRowSchema,
		})
	},
})

const cloudflareInfraDurableObjects = defineQuery({
	id: "cloudflareInfraDurableObjects",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraPlatformResourcesRequest, orgId: string) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		return CH.compile(Integrations.cloudflareDurableObjectCountersSQL(), params, {
			rowSchema: Integrations.cloudflareDurableObjectCountersRowSchema,
		})
	},
})

const cloudflareServiceCounters = defineQuery({
	id: "cloudflareServiceCounters",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: ServiceCloudflareStatsRequest, orgId: string) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		// Counters (metrics_sum) + percentiles (metrics_gauge) run
		// concurrently, then merge by ServiceName. Routed through the org's
		// configured warehouse exactly like the metric explorer reads these
		// same `cloudflare.*` metrics — no special ingest pin needed.
		return CH.compile(Integrations.cloudflareServiceCountersSQL(), params, {
			rowSchema: Integrations.cloudflareServiceCountersRowSchema,
		})
	},
})

const cloudflareServiceLatency = defineQuery({
	id: "cloudflareServiceLatency",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: ServiceCloudflareStatsRequest, orgId: string) => {
		const params = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}
		// Counters (metrics_sum) + percentiles (metrics_gauge) run
		// concurrently, then merge by ServiceName. Routed through the org's
		// configured warehouse exactly like the metric explorer reads these
		// same `cloudflare.*` metrics — no special ingest pin needed.
		return CH.compile(Integrations.cloudflareServiceLatencySQL(), params, {
			rowSchema: Integrations.cloudflareServiceLatencyRowSchema,
		})
	},
})

const planetscaleInfraTimeseries = defineQuery({
	id: "planetscaleInfraTimeseries",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: PlanetScaleInfraTimeseriesRequest, orgId: string) => {
		const base = {
			orgId: orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			bucketSeconds: Math.max(60, Math.floor(payload.bucketSeconds)),
			database: payload.database,
		}
		return payload.branch === undefined
			? CH.compile(Integrations.planetscaleInfraTimeseriesSQL(), base, {
					rowSchema: Integrations.planetscaleInfraTimeseriesRowSchema,
				})
			: CH.compile(
					Integrations.planetscaleBranchInfraTimeseriesSQL(),
					{ ...base, branch: payload.branch },
					{ rowSchema: Integrations.planetscaleInfraTimeseriesRowSchema },
				)
	},
})

// --- cloudflareInfraZoneDetail sub-queries --------------------------------

const zoneDetailParams = (payload: CloudflareInfraZoneDetailRequest, orgId: string) => ({
	orgId,
	serviceName: payload.serviceName,
	startTime: payload.startTime,
	endTime: payload.endTime,
	bucketSeconds: payload.bucketSeconds,
})

const cloudflareInfraZoneDetailStatus = defineQuery({
	id: "cloudflareInfraZoneDetailStatus",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraZoneDetailRequest, orgId: string) =>
		CH.compile(
			Integrations.cloudflareZoneStatusTimeseriesSQL(toCloudflareFilters(payload)),
			zoneDetailParams(payload, orgId),
			{ rowSchema: Integrations.cloudflareZoneStatusTimeseriesRowSchema },
		),
})

const cloudflareInfraZoneDetailCache = defineQuery({
	id: "cloudflareInfraZoneDetailCache",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraZoneDetailRequest, orgId: string) =>
		CH.compile(
			Integrations.cloudflareZoneCacheTimeseriesSQL(toCloudflareFilters(payload)),
			zoneDetailParams(payload, orgId),
			{ rowSchema: Integrations.cloudflareZoneCacheTimeseriesRowSchema },
		),
})

/** Latency comes from a gauge family that honors no request filters — hence the no-arg SQL. */
const cloudflareInfraZoneDetailLatency = defineQuery({
	id: "cloudflareInfraZoneDetailLatency",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: CloudflareInfraZoneDetailRequest, orgId: string) =>
		CH.compile(Integrations.cloudflareZoneLatencyTimeseriesSQL(), zoneDetailParams(payload, orgId), {
			rowSchema: Integrations.cloudflareZoneLatencyTimeseriesRowSchema,
		}),
})

// --- servicePlanetScaleStats sub-queries ----------------------------------
//
// Each reads either the database-level or the branch-level rollup depending on
// whether a database was requested. The branch lives inside `compile` so the id,
// profile and row schema stay one decision per sub-query rather than two.

const planetscaleStatsParams = (payload: ServicePlanetScaleStatsRequest, orgId: string) => ({
	orgId,
	startTime: payload.startTime,
	endTime: payload.endTime,
	...(payload.database !== undefined ? { database: payload.database } : {}),
})

const planetscaleServiceGauges = defineQuery({
	id: "planetscaleServiceGauges",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: ServicePlanetScaleStatsRequest, orgId: string) => {
		const params = planetscaleStatsParams(payload, orgId)
		return payload.database !== undefined
			? CH.compile(Integrations.planetscaleBranchGaugesSQL(), params, {
					rowSchema: Integrations.planetscaleBranchStatsRowSchema,
				})
			: CH.compile(Integrations.planetscaleGaugesSQL(), params, {
					rowSchema: Integrations.planetscaleDatabaseStatsRowSchema,
				})
	},
})

const planetscaleServiceConnections = defineQuery({
	id: "planetscaleServiceConnections",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: ServicePlanetScaleStatsRequest, orgId: string) => {
		const params = planetscaleStatsParams(payload, orgId)
		return payload.database !== undefined
			? CH.compile(Integrations.planetscaleBranchConnectionsSQL(), params, {
					rowSchema: Integrations.planetscaleBranchConnectionsRowSchema,
				})
			: CH.compile(Integrations.planetscaleConnectionsSQL(), params, {
					rowSchema: Integrations.planetscaleConnectionsRowSchema,
				})
	},
})

const planetscaleServiceStorage = defineQuery({
	id: "planetscaleServiceStorage",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: ServicePlanetScaleStatsRequest, orgId: string) => {
		const params = planetscaleStatsParams(payload, orgId)
		return payload.database !== undefined
			? CH.compile(Integrations.planetscaleBranchStorageSQL(), params, {
					rowSchema: Integrations.planetscaleBranchStorageRowSchema,
				})
			: CH.compile(Integrations.planetscaleStorageSQL(), params, {
					rowSchema: Integrations.planetscaleStorageRowSchema,
				})
	},
})

export const Queries = {
	...Core,

	/**
	 * Bounded to a ±1h window around the requested log so ClickHouse can prune
	 * partitions instead of reading every retained daily partition for an
	 * exact-timestamp match. That window used to be computed in the handler.
	 */
	getLog: defineQuery({
		id: "getLog",
		profile: "list",
		cache: undefined,
		compile: (payload: GetLogRequest, orgId: string) => {
			const { startTime, endTime } = partitionWindowAround(payload.timestamp)
			return CH.compile(
				CH.getLogByKeyQuery({
					serviceName: payload.serviceName,
					traceId: payload.traceId,
					spanId: payload.spanId,
				}),
				{ orgId, startTime, endTime, timestamp: payload.timestamp },
			)
		},
	}),

	/**
	 * A finished trace is immutable and cacheable; one still receiving spans is
	 * not. `traceCacheTtlSeconds` decides from the requested end time against
	 * now, which is why this def takes the dynamic-cache form.
	 */
	spanDetail: defineQuery({
		id: "spanDetail",
		profile: "discovery",
		cache: (payload: SpanDetailRequest, nowMs: number) => traceCacheTtlSeconds(payload.endTime, nowMs),
		compile: (payload: SpanDetailRequest, orgId: string) => {
			// Without both bounds there is no window to narrow to, and passing a
			// half-open range would widen the scan rather than prune it.
			const narrowByTime = payload.startTime != null && payload.endTime != null
			return CH.compile(
				CH.spanDetailQuery({
					traceId: payload.traceId,
					spanId: payload.spanId,
					narrowByTime,
				}),
				narrowByTime ? { orgId, startTime: payload.startTime, endTime: payload.endTime } : { orgId },
			)
		},
	}),

	fleetUtilizationTimeseries: defineQuery({
		id: "fleetUtilizationTimeseries",
		profile: "aggregation",
		cache: undefined,
		compile: (payload: FleetUtilizationTimeseriesRequest, orgId: string) =>
			CH.compile(CH.fleetUtilizationTimeseriesQuery(), {
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				bucketSeconds: payload.bucketSeconds ?? 300,
			}),
	}),

	podInfraTimeseries: defineQuery({
		id: "podInfraTimeseries",
		profile: "aggregation",
		cache: undefined,
		compile: (payload: PodInfraTimeseriesRequest, orgId: string) =>
			CH.compile(
				CH.podGaugeTimeseriesQuery({
					podName: payload.podName,
					namespace: payload.namespace,
					metricName: podMetricSpec(payload.metric).metricName,
				}),
				{
					orgId,
					startTime: payload.startTime,
					endTime: payload.endTime,
					bucketSeconds: payload.bucketSeconds ?? 60,
				},
			),
	}),

	nodeInfraTimeseries: defineQuery({
		id: "nodeInfraTimeseries",
		profile: "aggregation",
		cache: undefined,
		compile: (payload: NodeInfraTimeseriesRequest, orgId: string) =>
			CH.compile(
				CH.nodeGaugeTimeseriesQuery({
					nodeName: payload.nodeName,
					metricName: nodeMetricSpec(payload.metric).metricName,
				}),
				{
					orgId,
					startTime: payload.startTime,
					endTime: payload.endTime,
					bucketSeconds: payload.bucketSeconds ?? 60,
				},
			),
	}),

	workloadInfraTimeseries: defineQuery({
		id: "workloadInfraTimeseries",
		profile: "aggregation",
		cache: undefined,
		compile: (payload: WorkloadInfraTimeseriesRequest, orgId: string) =>
			CH.compile(
				CH.workloadGaugeTimeseriesQuery({
					kind: payload.kind,
					workloadName: payload.workloadName,
					namespace: payload.namespace,
					metricName: workloadMetricSpec(payload.metric).metricName,
					groupByPod: payload.groupByPod,
				}),
				{
					orgId,
					startTime: payload.startTime,
					endTime: payload.endTime,
					bucketSeconds: payload.bucketSeconds ?? 60,
				},
			),
	}),

	cloudflareInfraZoneTimeseries: defineQuery({
		id: "cloudflareInfraZoneTimeseries",
		profile: "aggregation",
		cache: undefined,
		compile: (payload: CloudflareInfraZoneTimeseriesRequest, orgId: string) =>
			CH.compile(
				Integrations.cloudflareZoneTimeseriesSQL(toCloudflareFilters(payload)),
				{
					orgId,
					startTime: payload.startTime,
					endTime: payload.endTime,
					bucketSeconds: payload.bucketSeconds,
				},
				{ rowSchema: Integrations.cloudflareZoneTimeseriesRowSchema },
			),
	}),

	cloudflareInfraWorkerTimeseries: defineQuery({
		id: "cloudflareInfraWorkerTimeseries",
		profile: "aggregation",
		cache: undefined,
		compile: (payload: CloudflareInfraWorkerTimeseriesRequest, orgId: string) =>
			CH.compile(
				Integrations.cloudflareWorkerTimeseriesSQL(),
				{
					orgId,
					startTime: payload.startTime,
					endTime: payload.endTime,
					bucketSeconds: payload.bucketSeconds,
				},
				{ rowSchema: Integrations.cloudflareWorkerTimeseriesRowSchema },
			),
	}),

	// Integration queries, declared above.
	cloudflareInfraZoneCounters,
	cloudflareInfraZoneLatency,
	cloudflareInfraZoneHostTotals,
	cloudflareInfraZoneHostTimeseries,
	cloudflareInfraZoneFirewallTimeseries,
	cloudflareInfraZoneFirewallTop,
	cloudflareInfraZoneDnsTimeseries,
	cloudflareInfraZoneDnsBreakdown,
	cloudflareInfraWorkerCounters,
	cloudflareInfraWorkerLatency,
	cloudflareInfraQueueGauges,
	cloudflareInfraDurableObjects,
	cloudflareServiceCounters,
	cloudflareServiceLatency,
	planetscaleInfraTimeseries,

	// ZoneDetail / PlanetScaleStats sub-queries, declared above.
	cloudflareInfraZoneDetailStatus,
	cloudflareInfraZoneDetailCache,
	cloudflareInfraZoneDetailLatency,
	planetscaleServiceGauges,
	planetscaleServiceConnections,
	planetscaleServiceStorage,
} as const

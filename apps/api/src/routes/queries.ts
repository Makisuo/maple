import * as CH from "@maple/query-engine/ch"
import * as Integrations from "@maple/query-engine-integrations"
import { defineQuery } from "@maple/query-engine/registry"
import { Queries as Core } from "@maple/query-engine/registry"
import type {
	CloudflareInfraWorkerTimeseriesRequest,
	CloudflareInfraZoneTimeseriesRequest,
	FleetUtilizationTimeseriesRequest,
	GetLogRequest,
	NodeInfraTimeseriesRequest,
	PodInfraTimeseriesRequest,
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
} as const

import * as Integrations from "@maple/query-engine-integrations"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import {
	QueryEngineValidationError,
	type ContainerInfraTimeseriesRequest,
	type HostInfraTimeseriesRequest,
	type NodeInfraTimeseriesRequest,
	type PodInfraTimeseriesRequest,
	type WorkloadInfraTimeseriesRequest,
} from "@maple/domain/http"
import { Effect, Schema } from "effect"

/**
 * Helpers shared between the query-engine handlers and the app-side query
 * registry (`./queries`).
 *
 * They live here rather than in either caller because both need them: the
 * registry's `compile` needs the metric name, while the handler needs the unit
 * for the response. Duplicating the switch would let those two drift, which is
 * exactly the failure the registry exists to prevent.
 */

export const toCloudflareFilters = (payload: {
	readonly hosts?: ReadonlyArray<string> | undefined
	readonly cacheStatuses?: ReadonlyArray<string> | undefined
	readonly statusClasses?: ReadonlyArray<string> | undefined
	readonly paths?: ReadonlyArray<string> | undefined
	readonly pathContains?: string | undefined
	readonly countries?: ReadonlyArray<string> | undefined
	readonly methods?: ReadonlyArray<string> | undefined
	readonly protocols?: ReadonlyArray<string> | undefined
	readonly deviceTypes?: ReadonlyArray<string> | undefined
	readonly firewallActions?: ReadonlyArray<string> | undefined
	readonly firewallSources?: ReadonlyArray<string> | undefined
	readonly firewallRuleIds?: ReadonlyArray<string> | undefined
	readonly dnsQueryNames?: ReadonlyArray<string> | undefined
	readonly dnsResponseCodes?: ReadonlyArray<string> | undefined
}): Integrations.CloudflareFilterOpts => ({
	hosts: payload.hosts,
	cacheStatuses: payload.cacheStatuses,
	statusClasses: payload.statusClasses,
	paths: payload.paths,
	pathContains: payload.pathContains,
	countries: payload.countries,
	methods: payload.methods,
	protocols: payload.protocols,
	deviceTypes: payload.deviceTypes,
	firewallActions: payload.firewallActions,
	firewallSources: payload.firewallSources,
	firewallRuleIds: payload.firewallRuleIds,
	dnsQueryNames: payload.dnsQueryNames,
	dnsResponseCodes: payload.dnsResponseCodes,
})

export const partitionWindowAround = (timestamp: string): { startTime: string; endTime: string } => {
	const ms = parseWarehouseDateTime(timestamp)
	return {
		startTime: formatWarehouseDateTime(ms - 3_600_000),
		endTime: formatWarehouseDateTime(ms + 3_600_000),
	}
}

/** Metric name + response unit for a pod infra metric. */
export const podMetricSpec = (metric: PodInfraTimeseriesRequest["metric"]) => {
	switch (metric) {
		case "cpu_usage":
			return { metricName: "k8s.pod.cpu.usage", unit: "cores" as const }
		case "cpu_limit":
			return {
				metricName: "k8s.pod.cpu_limit_utilization",
				unit: "percent" as const,
			}
		case "cpu_request":
			return {
				metricName: "k8s.pod.cpu_request_utilization",
				unit: "percent" as const,
			}
		case "memory_limit":
			return {
				metricName: "k8s.pod.memory_limit_utilization",
				unit: "percent" as const,
			}
		case "memory_request":
			return {
				metricName: "k8s.pod.memory_request_utilization",
				unit: "percent" as const,
			}
	}
}

/** Metric name + response unit for a node infra metric. */
export const nodeMetricSpec = (metric: NodeInfraTimeseriesRequest["metric"]) => {
	switch (metric) {
		case "cpu_usage":
			return { metricName: "k8s.node.cpu.usage", unit: "cores" as const }
		case "uptime":
			return { metricName: "k8s.node.uptime", unit: "seconds" as const }
	}
}

/** Metric name + response unit for a workload infra metric. */
export const workloadMetricSpec = (metric: WorkloadInfraTimeseriesRequest["metric"]) => {
	switch (metric) {
		case "cpu_usage":
			return { metricName: "k8s.pod.cpu.usage", unit: "cores" as const }
		case "cpu_limit":
			return {
				metricName: "k8s.pod.cpu_limit_utilization",
				unit: "percent" as const,
			}
		case "memory_limit":
			return {
				metricName: "k8s.pod.memory_limit_utilization",
				unit: "percent" as const,
			}
	}
}

/**
 * Metric name, grouping key, unit and query-family flag for a host metric.
 *
 * Shared like the pod/node/workload specs: the registry needs `metricName` and
 * `isNetwork` to build the query, the handler needs `unit` and
 * `groupByAttributeKey` for its response.
 */
export const hostMetricSpec = (metric: HostInfraTimeseriesRequest["metric"]) => {
	switch (metric) {
		case "cpu":
			return {
				metricName: "system.cpu.utilization",
				groupByAttributeKey: "state",
				unit: "percent" as const,
				isNetwork: false,
			}
		case "memory":
			return {
				metricName: "system.memory.utilization",
				groupByAttributeKey: "state",
				unit: "percent" as const,
				isNetwork: false,
			}
		case "filesystem":
			return {
				metricName: "system.filesystem.utilization",
				groupByAttributeKey: "mountpoint",
				unit: "percent" as const,
				isNetwork: false,
			}
		case "load15":
			return {
				metricName: "system.cpu.load_average.15m",
				groupByAttributeKey: undefined,
				unit: "load" as const,
				isNetwork: false,
			}
		case "network":
			return {
				metricName: "system.network.io",
				groupByAttributeKey: "direction",
				unit: "bytes_per_second" as const,
				isNetwork: true,
			}
	}
}

/**
 * Metric name(s), grouping/labeling, unit and query-family flag for a container
 * infra metric. `isSum` routes to the metrics_sum query; docker percent gauges
 * carry `divideBy: 100` so chart scales match the pod pages (0..1).
 */
export const containerMetricSpec = (metric: ContainerInfraTimeseriesRequest["metric"]) => {
	switch (metric) {
		case "cpu":
			return {
				metricNames: ["container.cpu.utilization"],
				unit: "percent" as const,
				isSum: false,
				average: undefined,
				divideBy: 100,
				metricLabels: undefined,
				groupByAttributeKey: undefined,
			}
		case "memory_percent":
			return {
				metricNames: ["container.memory.percent"],
				unit: "percent" as const,
				isSum: false,
				average: undefined,
				divideBy: 100,
				metricLabels: undefined,
				groupByAttributeKey: undefined,
			}
		case "uptime":
			return {
				metricNames: ["container.uptime"],
				unit: "seconds" as const,
				isSum: false,
				average: undefined,
				divideBy: undefined,
				metricLabels: undefined,
				groupByAttributeKey: undefined,
			}
		case "memory_bytes":
			// Sampled bytes, not a cumulative counter — summing a bucket's samples
			// would inflate the chart by samples-per-bucket.
			return {
				metricNames: ["container.memory.usage.total"],
				unit: "bytes" as const,
				isSum: true,
				average: true,
				divideBy: undefined,
				metricLabels: undefined,
				groupByAttributeKey: undefined,
			}
		case "network":
			return {
				metricNames: ["container.network.io.usage.rx_bytes", "container.network.io.usage.tx_bytes"],
				unit: "bytes" as const,
				isSum: true,
				average: undefined,
				divideBy: undefined,
				metricLabels: [
					["container.network.io.usage.rx_bytes", "receive"],
					["container.network.io.usage.tx_bytes", "transmit"],
				] as ReadonlyArray<readonly [string, string]>,
				groupByAttributeKey: undefined,
			}
		case "disk_io":
			return {
				metricNames: ["container.blockio.io_service_bytes_recursive"],
				unit: "bytes" as const,
				isSum: true,
				average: undefined,
				divideBy: undefined,
				metricLabels: undefined,
				groupByAttributeKey: "operation",
			}
	}
}

const isProductEventsFunnelError = Schema.is(CH.ProductEventsFunnelError)

/**
 * A funnel definition the query builder cannot compile is a caller error, not a
 * warehouse one. The builders validate synchronously and throw
 * `ProductEventsFunnelError`; the registry's `compile` would turn that into a
 * defect (a 500 with no remediation), so the definition is checked here first
 * and the reason lands in the 400 envelope. Anything else thrown is a genuine
 * defect and stays one. Shared by the internal endpoint and the share API's
 * `product_events_funnel` route plan.
 *
 * Breakdown options are checked through the BREAKDOWN builder: `limit` is
 * validated there and nowhere else, so validating the plain funnel for a
 * breakdown request would let `InvalidLimit` through to `compile` — the exact
 * defect this helper exists to prevent.
 */
export const validateFunnelDefinition = (
	opts: CH.ProductEventsFunnelOpts | CH.ProductEventsFunnelBreakdownOpts,
): Effect.Effect<void, QueryEngineValidationError> =>
	Effect.suspend(() => {
		try {
			if ("breakdownBy" in opts) CH.productEventsFunnelBreakdownQuery(opts)
			else CH.productEventsFunnelQuery(opts)
			return Effect.void
		} catch (error) {
			if (isProductEventsFunnelError(error)) {
				return Effect.fail(
					new QueryEngineValidationError({ message: error.message, details: [error.reason] }),
				)
			}
			return Effect.die(error)
		}
	})

import * as Integrations from "@maple/query-engine-integrations"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import type {
	HostInfraTimeseriesRequest,
	NodeInfraTimeseriesRequest,
	PodInfraTimeseriesRequest,
	WorkloadInfraTimeseriesRequest,
} from "@maple/domain/http"

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

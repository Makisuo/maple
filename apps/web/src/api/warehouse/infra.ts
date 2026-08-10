import {
	FleetUtilizationTimeseriesRequest,
	HostDetailSummaryRequest,
	HostInfraTimeseriesRequest,
	ListHostsRequest,
	ListPodsRequest,
	PodsSummaryRequest,
	PodDetailSummaryRequest,
	PodInfraTimeseriesRequest,
	PodFacetsRequest,
	ListNodesRequest,
	NodeDetailSummaryRequest,
	NodeInfraTimeseriesRequest,
	NodeFacetsRequest,
	ListWorkloadsRequest,
	WorkloadDetailSummaryRequest,
	WorkloadInfraTimeseriesRequest,
	WorkloadFacetsRequest,
	type FleetUtilizationTimeseriesResponse,
	type HostDetailSummaryResponse,
	type HostInfraTimeseriesResponse,
	type ListHostsResponse,
	type ListPodsResponse,
	type PodsSummaryResponse,
	type PodDetailSummaryResponse,
	type PodInfraTimeseriesResponse,
	type PodFacetsResponse,
	type ListNodesResponse,
	type NodeDetailSummaryResponse,
	type NodeInfraTimeseriesResponse,
	type NodeFacetsResponse,
	type ListWorkloadsResponse,
	type WorkloadDetailSummaryResponse,
	type WorkloadInfraTimeseriesResponse,
	type WorkloadFacetsResponse,
} from "@maple/domain/http"
import { Effect } from "effect"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { runWarehouseQuery } from "./effect-utils"

export type WorkloadKind = "deployment" | "statefulset" | "daemonset"

/** Mirrors PodSortKeyLiteral in @maple/domain — `saturation` is peak-of-either-limit. */
export type PodSortKey = "saturation" | "cpuUsage" | "cpuLimitPct" | "memoryLimitPct" | "podName" | "lastSeen"

export type SortDirection = "asc" | "desc"

/** One-click fleet scopes from the summary band. */
export type PodScope = "saturated" | "elevated" | "unbounded" | "stale"

export interface ListHostsInput {
	startTime: string
	endTime: string
	search?: string
	limit?: number
	offset?: number
}

export function listHosts({ data }: { data: ListHostsInput }) {
	return runWarehouseQuery("listHosts", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: ListHostsResponse = yield* client.queryEngine.listHosts({
				payload: new ListHostsRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					search: data.search,
					limit: data.limit,
					offset: data.offset,
				}),
			})
			return response
		}),
	)
}

export interface HostDetailSummaryInput {
	startTime: string
	endTime: string
	hostName: string
}

export function hostDetailSummary({ data }: { data: HostDetailSummaryInput }) {
	return runWarehouseQuery("hostDetailSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: HostDetailSummaryResponse = yield* client.queryEngine.hostDetailSummary({
				payload: new HostDetailSummaryRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					hostName: data.hostName,
				}),
			})
			return response
		}),
	)
}

export type HostInfraMetric = "cpu" | "memory" | "filesystem" | "network" | "load15"

export interface HostInfraTimeseriesInput {
	startTime: string
	endTime: string
	hostName: string
	metric: HostInfraMetric
	bucketSeconds?: number
}

export interface FleetUtilizationTimeseriesInput {
	startTime: string
	endTime: string
	bucketSeconds?: number
}

export function fleetUtilizationTimeseries({ data }: { data: FleetUtilizationTimeseriesInput }) {
	return runWarehouseQuery("fleetUtilizationTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: FleetUtilizationTimeseriesResponse =
				yield* client.queryEngine.fleetUtilizationTimeseries({
					payload: new FleetUtilizationTimeseriesRequest({
						startTime: data.startTime,
						endTime: data.endTime,
						bucketSeconds: data.bucketSeconds,
					}),
				})
			return response
		}),
	)
}

export function hostInfraTimeseries({ data }: { data: HostInfraTimeseriesInput }) {
	return runWarehouseQuery("hostInfraTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: HostInfraTimeseriesResponse = yield* client.queryEngine.hostInfraTimeseries({
				payload: new HostInfraTimeseriesRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					hostName: data.hostName,
					metric: data.metric,
					bucketSeconds: data.bucketSeconds,
				}),
			})
			return response
		}),
	)
}

// Pods

export interface ListPodsInput {
	startTime: string
	endTime: string
	search?: string
	podNames?: ReadonlyArray<string>
	namespaces?: ReadonlyArray<string>
	nodeNames?: ReadonlyArray<string>
	clusters?: ReadonlyArray<string>
	deployments?: ReadonlyArray<string>
	statefulsets?: ReadonlyArray<string>
	daemonsets?: ReadonlyArray<string>
	jobs?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
	computeTypes?: ReadonlyArray<string>
	workloadKind?: WorkloadKind
	workloadName?: string
	scope?: PodScope
	sortBy?: PodSortKey
	sortDir?: SortDirection
	limit?: number
	offset?: number
}

export function listPods({ data }: { data: ListPodsInput }) {
	return runWarehouseQuery("listPods", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: ListPodsResponse = yield* client.queryEngine.listPods({
				payload: new ListPodsRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					search: data.search,
					podNames: data.podNames,
					namespaces: data.namespaces,
					nodeNames: data.nodeNames,
					clusters: data.clusters,
					deployments: data.deployments,
					statefulsets: data.statefulsets,
					daemonsets: data.daemonsets,
					jobs: data.jobs,
					environments: data.environments,
					computeTypes: data.computeTypes,
					workloadKind: data.workloadKind,
					workloadName: data.workloadName,
					scope: data.scope,
					sortBy: data.sortBy,
					sortDir: data.sortDir,
					limit: data.limit,
					offset: data.offset,
				}),
			})
			return response
		}),
	)
}

export interface PodsSummaryInput {
	startTime: string
	endTime: string
	namespaces?: ReadonlyArray<string>
	clusters?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
}

/**
 * Fleet-shape counts for the browse summary band. Deliberately scope-only — it
 * answers "how much of the fleet did my filters hide", which a filtered count
 * cannot.
 */
export function podsSummary({ data }: { data: PodsSummaryInput }) {
	return runWarehouseQuery("podsSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: PodsSummaryResponse = yield* client.queryEngine.podsSummary({
				payload: new PodsSummaryRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					namespaces: data.namespaces,
					clusters: data.clusters,
					environments: data.environments,
				}),
			})
			return response
		}),
	)
}

export interface PodFacetsInput {
	startTime: string
	endTime: string
	search?: string
	podNames?: ReadonlyArray<string>
	namespaces?: ReadonlyArray<string>
	nodeNames?: ReadonlyArray<string>
	clusters?: ReadonlyArray<string>
	deployments?: ReadonlyArray<string>
	statefulsets?: ReadonlyArray<string>
	daemonsets?: ReadonlyArray<string>
	jobs?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
	computeTypes?: ReadonlyArray<string>
}

export function getPodFacets({ data }: { data: PodFacetsInput }) {
	return runWarehouseQuery("podFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: PodFacetsResponse = yield* client.queryEngine.podFacets({
				payload: new PodFacetsRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					search: data.search,
					podNames: data.podNames,
					namespaces: data.namespaces,
					nodeNames: data.nodeNames,
					clusters: data.clusters,
					deployments: data.deployments,
					statefulsets: data.statefulsets,
					daemonsets: data.daemonsets,
					jobs: data.jobs,
					environments: data.environments,
					computeTypes: data.computeTypes,
				}),
			})
			return response
		}),
	)
}

export interface PodDetailSummaryInput {
	startTime: string
	endTime: string
	podName: string
	namespace?: string
}

export function podDetailSummary({ data }: { data: PodDetailSummaryInput }) {
	return runWarehouseQuery("podDetailSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: PodDetailSummaryResponse = yield* client.queryEngine.podDetailSummary({
				payload: new PodDetailSummaryRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					podName: data.podName,
					namespace: data.namespace,
				}),
			})
			return response
		}),
	)
}

export type PodInfraMetric = "cpu_usage" | "cpu_limit" | "cpu_request" | "memory_limit" | "memory_request"

export interface PodInfraTimeseriesInput {
	startTime: string
	endTime: string
	podName: string
	namespace?: string
	metric: PodInfraMetric
	bucketSeconds?: number
}

export function podInfraTimeseries({ data }: { data: PodInfraTimeseriesInput }) {
	return runWarehouseQuery("podInfraTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: PodInfraTimeseriesResponse = yield* client.queryEngine.podInfraTimeseries({
				payload: new PodInfraTimeseriesRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					podName: data.podName,
					namespace: data.namespace,
					metric: data.metric,
					bucketSeconds: data.bucketSeconds,
				}),
			})
			return response
		}),
	)
}

// Nodes

export interface ListNodesInput {
	startTime: string
	endTime: string
	search?: string
	nodeNames?: ReadonlyArray<string>
	clusters?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
	limit?: number
	offset?: number
}

export function listNodes({ data }: { data: ListNodesInput }) {
	return runWarehouseQuery("listNodes", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: ListNodesResponse = yield* client.queryEngine.listNodes({
				payload: new ListNodesRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					search: data.search,
					nodeNames: data.nodeNames,
					clusters: data.clusters,
					environments: data.environments,
					limit: data.limit,
					offset: data.offset,
				}),
			})
			return response
		}),
	)
}

export interface NodeFacetsInput {
	startTime: string
	endTime: string
	search?: string
	nodeNames?: ReadonlyArray<string>
	clusters?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
}

export function getNodeFacets({ data }: { data: NodeFacetsInput }) {
	return runWarehouseQuery("nodeFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: NodeFacetsResponse = yield* client.queryEngine.nodeFacets({
				payload: new NodeFacetsRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					search: data.search,
					nodeNames: data.nodeNames,
					clusters: data.clusters,
					environments: data.environments,
				}),
			})
			return response
		}),
	)
}

export interface NodeDetailSummaryInput {
	startTime: string
	endTime: string
	nodeName: string
}

export function nodeDetailSummary({ data }: { data: NodeDetailSummaryInput }) {
	return runWarehouseQuery("nodeDetailSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: NodeDetailSummaryResponse = yield* client.queryEngine.nodeDetailSummary({
				payload: new NodeDetailSummaryRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					nodeName: data.nodeName,
				}),
			})
			return response
		}),
	)
}

export type NodeInfraMetric = "cpu_usage" | "uptime"

export interface NodeInfraTimeseriesInput {
	startTime: string
	endTime: string
	nodeName: string
	metric: NodeInfraMetric
	bucketSeconds?: number
}

export function nodeInfraTimeseries({ data }: { data: NodeInfraTimeseriesInput }) {
	return runWarehouseQuery("nodeInfraTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: NodeInfraTimeseriesResponse = yield* client.queryEngine.nodeInfraTimeseries({
				payload: new NodeInfraTimeseriesRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					nodeName: data.nodeName,
					metric: data.metric,
					bucketSeconds: data.bucketSeconds,
				}),
			})
			return response
		}),
	)
}

// Workloads (Deployments / StatefulSets / DaemonSets)

export interface ListWorkloadsInput {
	startTime: string
	endTime: string
	kind: WorkloadKind
	search?: string
	workloadNames?: ReadonlyArray<string>
	namespaces?: ReadonlyArray<string>
	clusters?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
	computeTypes?: ReadonlyArray<string>
	limit?: number
	offset?: number
}

export function listWorkloads({ data }: { data: ListWorkloadsInput }) {
	return runWarehouseQuery("listWorkloads", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: ListWorkloadsResponse = yield* client.queryEngine.listWorkloads({
				payload: new ListWorkloadsRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					kind: data.kind,
					search: data.search,
					workloadNames: data.workloadNames,
					namespaces: data.namespaces,
					clusters: data.clusters,
					environments: data.environments,
					computeTypes: data.computeTypes,
					limit: data.limit,
					offset: data.offset,
				}),
			})
			return response
		}),
	)
}

export interface WorkloadFacetsInput {
	startTime: string
	endTime: string
	kind: WorkloadKind
	search?: string
	workloadNames?: ReadonlyArray<string>
	namespaces?: ReadonlyArray<string>
	clusters?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
	computeTypes?: ReadonlyArray<string>
}

export function getWorkloadFacets({ data }: { data: WorkloadFacetsInput }) {
	return runWarehouseQuery("workloadFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: WorkloadFacetsResponse = yield* client.queryEngine.workloadFacets({
				payload: new WorkloadFacetsRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					kind: data.kind,
					search: data.search,
					workloadNames: data.workloadNames,
					namespaces: data.namespaces,
					clusters: data.clusters,
					environments: data.environments,
					computeTypes: data.computeTypes,
				}),
			})
			return response
		}),
	)
}

export interface WorkloadDetailSummaryInput {
	startTime: string
	endTime: string
	kind: WorkloadKind
	workloadName: string
	namespace?: string
}

export function workloadDetailSummary({ data }: { data: WorkloadDetailSummaryInput }) {
	return runWarehouseQuery("workloadDetailSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: WorkloadDetailSummaryResponse = yield* client.queryEngine.workloadDetailSummary({
				payload: new WorkloadDetailSummaryRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					kind: data.kind,
					workloadName: data.workloadName,
					namespace: data.namespace,
				}),
			})
			return response
		}),
	)
}

export type WorkloadInfraMetric = "cpu_usage" | "cpu_limit" | "memory_limit"

export interface WorkloadInfraTimeseriesInput {
	startTime: string
	endTime: string
	kind: WorkloadKind
	workloadName: string
	namespace?: string
	metric: WorkloadInfraMetric
	groupByPod?: boolean
	bucketSeconds?: number
}

export function workloadInfraTimeseries({ data }: { data: WorkloadInfraTimeseriesInput }) {
	return runWarehouseQuery("workloadInfraTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			const response: WorkloadInfraTimeseriesResponse =
				yield* client.queryEngine.workloadInfraTimeseries({
					payload: new WorkloadInfraTimeseriesRequest({
						startTime: data.startTime,
						endTime: data.endTime,
						kind: data.kind,
						workloadName: data.workloadName,
						namespace: data.namespace,
						metric: data.metric,
						groupByPod: data.groupByPod,
						bucketSeconds: data.bucketSeconds,
					}),
				})
			return response
		}),
	)
}

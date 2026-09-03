import {
	FleetUtilizationTimeseriesRequest,
	HostDetailSummaryRequest,
	HostInfraTimeseriesRequest,
	InfraPresenceRequest,
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
	ListContainersRequest,
	ContainersSummaryRequest,
	ContainerDetailSummaryRequest,
	ContainerInfraTimeseriesRequest,
	ContainerFacetsRequest,
	type FleetUtilizationTimeseriesResponse,
	type HostDetailSummaryResponse,
	type HostInfraTimeseriesResponse,
	type InfraPresenceResponse,
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
	type ListContainersResponse,
	type ContainersSummaryResponse,
	type ContainerDetailSummaryResponse,
	type ContainerInfraTimeseriesResponse,
	type ContainerFacetsResponse,
} from "@maple/domain/http"
import { Effect } from "effect"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { runWarehouseQuery } from "./effect-utils"

export type WorkloadKind = "deployment" | "statefulset" | "daemonset"

/** Mirrors PodSortKeyLiteral in @maple/domain — `saturation` is peak-of-either-limit. */
export type PodSortKey = "saturation" | "cpuUsage" | "cpuLimitPct" | "memoryLimitPct" | "podName" | "lastSeen"

export type SortDirection = "asc" | "desc"

/** One-click fleet scopes from the summary band. */
export type PodScope = "saturated" | "elevated" | "unbounded"

/** Which slice of the window's pods to list — see the domain contract. */
export type PodLifecycle = "live" | "ended" | "all"

export interface InfraPresenceInput {
	startTime: string
	endTime: string
}

/** Which Infrastructure surfaces report telemetry — the sidebar's visibility gate. */
export function infraPresence({ data }: { data: InfraPresenceInput }) {
	return runWarehouseQuery("infraPresence", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			const response: InfraPresenceResponse = yield* client.queryEngine.infraPresence({
				payload: new InfraPresenceRequest({
					startTime: data.startTime,
					endTime: data.endTime,
				}),
			})
			return response
		}),
	)
}

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
			const client = yield* MapleInternalAtomClient
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
			const client = yield* MapleInternalAtomClient
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
			const client = yield* MapleInternalAtomClient
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
			const client = yield* MapleInternalAtomClient
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
	excludedPodNames?: ReadonlyArray<string>
	excludedNamespaces?: ReadonlyArray<string>
	excludedNodeNames?: ReadonlyArray<string>
	excludedClusters?: ReadonlyArray<string>
	excludedDeployments?: ReadonlyArray<string>
	excludedStatefulsets?: ReadonlyArray<string>
	excludedDaemonsets?: ReadonlyArray<string>
	excludedJobs?: ReadonlyArray<string>
	excludedEnvironments?: ReadonlyArray<string>
	excludedComputeTypes?: ReadonlyArray<string>
	workloadKind?: WorkloadKind
	workloadName?: string
	scope?: PodScope
	/** Server-side default is `live`. */
	lifecycle?: PodLifecycle
	sortBy?: PodSortKey
	sortDir?: SortDirection
	limit?: number
	offset?: number
}

export function listPods({ data }: { data: ListPodsInput }) {
	return runWarehouseQuery("listPods", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
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
					excludedPodNames: data.excludedPodNames,
					excludedNamespaces: data.excludedNamespaces,
					excludedNodeNames: data.excludedNodeNames,
					excludedClusters: data.excludedClusters,
					excludedDeployments: data.excludedDeployments,
					excludedStatefulsets: data.excludedStatefulsets,
					excludedDaemonsets: data.excludedDaemonsets,
					excludedJobs: data.excludedJobs,
					excludedEnvironments: data.excludedEnvironments,
					excludedComputeTypes: data.excludedComputeTypes,
					workloadKind: data.workloadKind,
					workloadName: data.workloadName,
					scope: data.scope,
					lifecycle: data.lifecycle,
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
			const client = yield* MapleInternalAtomClient
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
	excludedPodNames?: ReadonlyArray<string>
	excludedNamespaces?: ReadonlyArray<string>
	excludedNodeNames?: ReadonlyArray<string>
	excludedClusters?: ReadonlyArray<string>
	excludedDeployments?: ReadonlyArray<string>
	excludedStatefulsets?: ReadonlyArray<string>
	excludedDaemonsets?: ReadonlyArray<string>
	excludedJobs?: ReadonlyArray<string>
	excludedEnvironments?: ReadonlyArray<string>
	excludedComputeTypes?: ReadonlyArray<string>
}

export function getPodFacets({ data }: { data: PodFacetsInput }) {
	return runWarehouseQuery("podFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
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
					excludedPodNames: data.excludedPodNames,
					excludedNamespaces: data.excludedNamespaces,
					excludedNodeNames: data.excludedNodeNames,
					excludedClusters: data.excludedClusters,
					excludedDeployments: data.excludedDeployments,
					excludedStatefulsets: data.excludedStatefulsets,
					excludedDaemonsets: data.excludedDaemonsets,
					excludedJobs: data.excludedJobs,
					excludedEnvironments: data.excludedEnvironments,
					excludedComputeTypes: data.excludedComputeTypes,
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
			const client = yield* MapleInternalAtomClient
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
			const client = yield* MapleInternalAtomClient
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
			const client = yield* MapleInternalAtomClient
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
			const client = yield* MapleInternalAtomClient
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
			const client = yield* MapleInternalAtomClient
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
			const client = yield* MapleInternalAtomClient
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

// Containers (Docker)

/** Mirrors ContainerSortKeyLiteral in @maple/domain — `saturation` is peak-of-either-percent. */
export type ContainerSortKey = "saturation" | "cpuPct" | "memoryPct" | "containerName" | "lastSeen"

/** One-click fleet scopes from the containers summary band (no `unbounded` — see domain). */
export type ContainerScope = "saturated" | "elevated" | "stale"

export interface ContainerFilterInputs {
	search?: string
	containerNames?: ReadonlyArray<string>
	hostNames?: ReadonlyArray<string>
	images?: ReadonlyArray<string>
	composeProjects?: ReadonlyArray<string>
	composeServices?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
	excludedContainerNames?: ReadonlyArray<string>
	excludedHostNames?: ReadonlyArray<string>
	excludedImages?: ReadonlyArray<string>
	excludedComposeProjects?: ReadonlyArray<string>
	excludedComposeServices?: ReadonlyArray<string>
	excludedEnvironments?: ReadonlyArray<string>
}

export interface ListContainersInput extends ContainerFilterInputs {
	startTime: string
	endTime: string
	scope?: ContainerScope
	sortBy?: ContainerSortKey
	sortDir?: SortDirection
	limit?: number
	offset?: number
}

const containerFilterPayload = (data: ContainerFilterInputs) => ({
	search: data.search,
	containerNames: data.containerNames,
	hostNames: data.hostNames,
	images: data.images,
	composeProjects: data.composeProjects,
	composeServices: data.composeServices,
	environments: data.environments,
	excludedContainerNames: data.excludedContainerNames,
	excludedHostNames: data.excludedHostNames,
	excludedImages: data.excludedImages,
	excludedComposeProjects: data.excludedComposeProjects,
	excludedComposeServices: data.excludedComposeServices,
	excludedEnvironments: data.excludedEnvironments,
})

export function listContainers({ data }: { data: ListContainersInput }) {
	return runWarehouseQuery("listContainers", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			const response: ListContainersResponse = yield* client.queryEngine.listContainers({
				payload: new ListContainersRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					...containerFilterPayload(data),
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

export interface ContainersSummaryInput {
	startTime: string
	endTime: string
	hostNames?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
}

/** Fleet-shape counts for the containers summary band — scope-only, like podsSummary. */
export function containersSummary({ data }: { data: ContainersSummaryInput }) {
	return runWarehouseQuery("containersSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			const response: ContainersSummaryResponse = yield* client.queryEngine.containersSummary({
				payload: new ContainersSummaryRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					hostNames: data.hostNames,
					environments: data.environments,
				}),
			})
			return response
		}),
	)
}

export interface ContainerFacetsInput extends ContainerFilterInputs {
	startTime: string
	endTime: string
}

export function getContainerFacets({ data }: { data: ContainerFacetsInput }) {
	return runWarehouseQuery("containerFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			const response: ContainerFacetsResponse = yield* client.queryEngine.containerFacets({
				payload: new ContainerFacetsRequest({
					startTime: data.startTime,
					endTime: data.endTime,
					...containerFilterPayload(data),
				}),
			})
			return response
		}),
	)
}

export interface ContainerDetailSummaryInput {
	startTime: string
	endTime: string
	containerName: string
	hostName?: string
}

export function containerDetailSummary({ data }: { data: ContainerDetailSummaryInput }) {
	return runWarehouseQuery("containerDetailSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			const response: ContainerDetailSummaryResponse = yield* client.queryEngine.containerDetailSummary(
				{
					payload: new ContainerDetailSummaryRequest({
						startTime: data.startTime,
						endTime: data.endTime,
						containerName: data.containerName,
						hostName: data.hostName,
					}),
				},
			)
			return response
		}),
	)
}

export type ContainerInfraMetric =
	| "cpu"
	| "memory_percent"
	| "memory_bytes"
	| "network"
	| "disk_io"
	| "uptime"

export interface ContainerInfraTimeseriesInput {
	startTime: string
	endTime: string
	containerName: string
	hostName?: string
	metric: ContainerInfraMetric
	bucketSeconds?: number
}

export function containerInfraTimeseries({ data }: { data: ContainerInfraTimeseriesInput }) {
	return runWarehouseQuery("containerInfraTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			const response: ContainerInfraTimeseriesResponse =
				yield* client.queryEngine.containerInfraTimeseries({
					payload: new ContainerInfraTimeseriesRequest({
						startTime: data.startTime,
						endTime: data.endTime,
						containerName: data.containerName,
						hostName: data.hostName,
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
			const client = yield* MapleInternalAtomClient
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
			const client = yield* MapleInternalAtomClient
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
			const client = yield* MapleInternalAtomClient
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
			const client = yield* MapleInternalAtomClient
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

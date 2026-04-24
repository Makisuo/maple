import {
  FleetUtilizationTimeseriesRequest,
  HostDetailSummaryRequest,
  HostInfraTimeseriesRequest,
  ListHostsRequest,
  ListPodsRequest,
  PodDetailSummaryRequest,
  PodInfraTimeseriesRequest,
  ListNodesRequest,
  NodeDetailSummaryRequest,
  NodeInfraTimeseriesRequest,
  ListWorkloadsRequest,
  WorkloadDetailSummaryRequest,
  WorkloadInfraTimeseriesRequest,
  type FleetUtilizationTimeseriesResponse,
  type HostDetailSummaryResponse,
  type HostInfraTimeseriesResponse,
  type ListHostsResponse,
  type ListPodsResponse,
  type PodDetailSummaryResponse,
  type PodInfraTimeseriesResponse,
  type ListNodesResponse,
  type NodeDetailSummaryResponse,
  type NodeInfraTimeseriesResponse,
  type ListWorkloadsResponse,
  type WorkloadDetailSummaryResponse,
  type WorkloadInfraTimeseriesResponse,
} from "@maple/domain/http"
import { Effect } from "effect"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { runTinybirdQuery } from "./effect-utils"

export type WorkloadKind = "deployment" | "statefulset" | "daemonset"

export interface ListHostsInput {
  startTime: string
  endTime: string
  search?: string
  limit?: number
  offset?: number
}

export function listHosts({ data }: { data: ListHostsInput }) {
  return runTinybirdQuery("listHosts", () =>
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
  return runTinybirdQuery("hostDetailSummary", () =>
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

export function fleetUtilizationTimeseries({
  data,
}: {
  data: FleetUtilizationTimeseriesInput
}) {
  return runTinybirdQuery("fleetUtilizationTimeseries", () =>
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
  return runTinybirdQuery("hostInfraTimeseries", () =>
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

// ---------------------------------------------------------------------------
// Pods
// ---------------------------------------------------------------------------

export interface ListPodsInput {
  startTime: string
  endTime: string
  search?: string
  namespace?: string
  nodeName?: string
  workloadKind?: WorkloadKind
  workloadName?: string
  limit?: number
  offset?: number
}

export function listPods({ data }: { data: ListPodsInput }) {
  return runTinybirdQuery("listPods", () =>
    Effect.gen(function* () {
      const client = yield* MapleApiAtomClient
      const response: ListPodsResponse = yield* client.queryEngine.listPods({
        payload: new ListPodsRequest({
          startTime: data.startTime,
          endTime: data.endTime,
          search: data.search,
          namespace: data.namespace,
          nodeName: data.nodeName,
          workloadKind: data.workloadKind,
          workloadName: data.workloadName,
          limit: data.limit,
          offset: data.offset,
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
  return runTinybirdQuery("podDetailSummary", () =>
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

export type PodInfraMetric =
  | "cpu_usage"
  | "cpu_limit"
  | "cpu_request"
  | "memory_limit"
  | "memory_request"

export interface PodInfraTimeseriesInput {
  startTime: string
  endTime: string
  podName: string
  namespace?: string
  metric: PodInfraMetric
  bucketSeconds?: number
}

export function podInfraTimeseries({ data }: { data: PodInfraTimeseriesInput }) {
  return runTinybirdQuery("podInfraTimeseries", () =>
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

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export interface ListNodesInput {
  startTime: string
  endTime: string
  search?: string
  limit?: number
  offset?: number
}

export function listNodes({ data }: { data: ListNodesInput }) {
  return runTinybirdQuery("listNodes", () =>
    Effect.gen(function* () {
      const client = yield* MapleApiAtomClient
      const response: ListNodesResponse = yield* client.queryEngine.listNodes({
        payload: new ListNodesRequest({
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

export interface NodeDetailSummaryInput {
  startTime: string
  endTime: string
  nodeName: string
}

export function nodeDetailSummary({ data }: { data: NodeDetailSummaryInput }) {
  return runTinybirdQuery("nodeDetailSummary", () =>
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
  return runTinybirdQuery("nodeInfraTimeseries", () =>
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

// ---------------------------------------------------------------------------
// Workloads (Deployments / StatefulSets / DaemonSets)
// ---------------------------------------------------------------------------

export interface ListWorkloadsInput {
  startTime: string
  endTime: string
  kind: WorkloadKind
  search?: string
  namespace?: string
  limit?: number
  offset?: number
}

export function listWorkloads({ data }: { data: ListWorkloadsInput }) {
  return runTinybirdQuery("listWorkloads", () =>
    Effect.gen(function* () {
      const client = yield* MapleApiAtomClient
      const response: ListWorkloadsResponse = yield* client.queryEngine.listWorkloads({
        payload: new ListWorkloadsRequest({
          startTime: data.startTime,
          endTime: data.endTime,
          kind: data.kind,
          search: data.search,
          namespace: data.namespace,
          limit: data.limit,
          offset: data.offset,
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
  return runTinybirdQuery("workloadDetailSummary", () =>
    Effect.gen(function* () {
      const client = yield* MapleApiAtomClient
      const response: WorkloadDetailSummaryResponse =
        yield* client.queryEngine.workloadDetailSummary({
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

export function workloadInfraTimeseries({
  data,
}: {
  data: WorkloadInfraTimeseriesInput
}) {
  return runTinybirdQuery("workloadInfraTimeseries", () =>
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

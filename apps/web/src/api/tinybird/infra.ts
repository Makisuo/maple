import {
  FleetUtilizationTimeseriesRequest,
  HostDetailSummaryRequest,
  HostInfraTimeseriesRequest,
  ListHostsRequest,
  type FleetUtilizationTimeseriesResponse,
  type HostDetailSummaryResponse,
  type HostInfraTimeseriesResponse,
  type ListHostsResponse,
} from "@maple/domain/http"
import { Effect } from "effect"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { runTinybirdQuery } from "./effect-utils"

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

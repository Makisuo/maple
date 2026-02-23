import { Effect, Schema } from "effect"
import { getTinybird, type HttpEndpointsOverviewOutput } from "@/lib/tinybird"
import {
  TinybirdDateTimeString,
  decodeInput,
  runTinybirdQuery,
} from "@/api/tinybird/effect-utils"

const dateTimeString = TinybirdDateTimeString

export interface HttpEndpointOverview {
  serviceName: string
  endpointName: string
  httpMethod: string
  count: number
  avgDuration: number
  p50Duration: number
  p95Duration: number
  p99Duration: number
  errorRate: number
}

export interface HttpEndpointsOverviewResponse {
  data: HttpEndpointOverview[]
}

const GetHttpEndpointsOverviewInput = Schema.Struct({
  startTime: dateTimeString,
  endTime: dateTimeString,
  serviceName: Schema.optional(Schema.String),
  environments: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})

export type GetHttpEndpointsOverviewInput = Schema.Schema.Type<typeof GetHttpEndpointsOverviewInput>

function coerceRow(raw: HttpEndpointsOverviewOutput): HttpEndpointOverview {
  return {
    serviceName: raw.serviceName,
    endpointName: raw.endpointName,
    httpMethod: raw.httpMethod || "UNKNOWN",
    count: Number(raw.count),
    avgDuration: Number(raw.avgDuration),
    p50Duration: Number(raw.p50Duration),
    p95Duration: Number(raw.p95Duration),
    p99Duration: Number(raw.p99Duration),
    errorRate: Number(raw.errorRate),
  }
}

export function getHttpEndpointsOverview({
  data,
}: {
  data: GetHttpEndpointsOverviewInput
}) {
  return getHttpEndpointsOverviewEffect({ data })
}

const getHttpEndpointsOverviewEffect = Effect.fn("Tinybird.getHttpEndpointsOverview")(
  function* ({
    data,
  }: {
    data: GetHttpEndpointsOverviewInput
  }) {
    const input = yield* decodeInput(
      GetHttpEndpointsOverviewInput,
      data,
      "getHttpEndpointsOverview",
    )

    const tinybird = getTinybird()
    const result = yield* runTinybirdQuery("http_endpoints_overview", () =>
      tinybird.query.http_endpoints_overview({
        start_time: input.startTime,
        end_time: input.endTime,
        service_name: input.serviceName,
        environments: input.environments?.join(","),
      }),
    )

    return {
      data: result.data.map(coerceRow),
    }
  },
)

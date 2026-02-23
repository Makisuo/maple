import { Effect, Schema } from "effect"
import { getTinybird, type HttpEndpointsOverviewOutput } from "@/lib/tinybird"
import {
  TinybirdDateTimeString,
  decodeInput,
  runTinybirdQuery,
} from "@/api/tinybird/effect-utils"
import {
  buildBucketTimeline,
  computeBucketSeconds,
  toIsoBucket,
} from "@/api/tinybird/timeseries-utils"

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

// Sparkline types
export interface EndpointSparklinePoint {
  bucket: string
  throughput: number
  errorRate: number
}

const GetHttpEndpointsSparklinesInput = Schema.Struct({
  startTime: Schema.optional(dateTimeString),
  endTime: Schema.optional(dateTimeString),
  serviceName: Schema.optional(Schema.String),
  environments: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})

export type GetHttpEndpointsSparklinesInput = Schema.Schema.Type<typeof GetHttpEndpointsSparklinesInput>

function fillSparklinePoints(
  points: EndpointSparklinePoint[],
  timeline: string[],
): EndpointSparklinePoint[] {
  if (timeline.length === 0) {
    return [...points].sort((a, b) => a.bucket.localeCompare(b.bucket))
  }

  const byBucket = new Map<string, EndpointSparklinePoint>()
  for (const point of points) {
    byBucket.set(toIsoBucket(point.bucket), point)
  }

  return timeline.map((bucket) => {
    const existing = byBucket.get(bucket)
    if (existing) return existing
    return { bucket, throughput: 0, errorRate: 0 }
  })
}

export function getHttpEndpointsSparklines({
  data,
}: {
  data: GetHttpEndpointsSparklinesInput
}) {
  return getHttpEndpointsSparklinesEffect({ data })
}

const getHttpEndpointsSparklinesEffect = Effect.fn("Tinybird.getHttpEndpointsSparklines")(
  function* ({
    data,
  }: {
    data: GetHttpEndpointsSparklinesInput
  }) {
    const input = yield* decodeInput(
      GetHttpEndpointsSparklinesInput,
      data ?? {},
      "getHttpEndpointsSparklines",
    )

    const tinybird = getTinybird()
    const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)
    const result = yield* runTinybirdQuery("http_endpoints_timeseries", () =>
      tinybird.query.http_endpoints_timeseries({
        start_time: input.startTime,
        end_time: input.endTime,
        bucket_seconds: bucketSeconds,
        service_name: input.serviceName,
        environments: input.environments?.join(","),
      }),
    )

    const timeline = buildBucketTimeline(input.startTime, input.endTime, bucketSeconds)
    // endpointKey format: "serviceName::endpointName::httpMethod"
    const grouped: Record<string, EndpointSparklinePoint[]> = {}
    for (const row of result.data) {
      const bucket = toIsoBucket(row.bucket)
      const point: EndpointSparklinePoint = {
        bucket,
        throughput: Number(row.count),
        errorRate: Number(row.errorRate),
      }
      if (!grouped[row.endpointKey]) {
        grouped[row.endpointKey] = []
      }
      grouped[row.endpointKey].push(point)
    }

    const filledGrouped = Object.fromEntries(
      Object.entries(grouped).map(([key, points]) => [
        key,
        fillSparklinePoints(points, timeline),
      ]),
    )

    return { data: filledGrouped }
  },
)

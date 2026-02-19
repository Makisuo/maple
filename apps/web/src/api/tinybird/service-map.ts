import { Effect, Schema } from "effect"
import { getTinybird, type ServiceDependenciesOutput } from "@/lib/tinybird"
import { estimateThroughput } from "@/lib/sampling"
import {
  TinybirdDateTimeString,
  decodeInput,
  runTinybirdQuery,
} from "@/api/tinybird/effect-utils"

export interface ServiceEdge {
  sourceService: string
  targetService: string
  callCount: number
  estimatedCallCount: number
  errorCount: number
  errorRate: number
  avgDurationMs: number
  p95DurationMs: number
  hasSampling: boolean
  samplingWeight: number
}

export interface ServiceMapResponse {
  edges: ServiceEdge[]
}

const GetServiceMapInputSchema = Schema.Struct({
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
  deploymentEnv: Schema.optional(Schema.String),
})

export type GetServiceMapInput = Schema.Schema.Type<typeof GetServiceMapInputSchema>

function transformEdge(row: ServiceDependenciesOutput, durationSeconds: number): ServiceEdge {
  const callCount = Number(row.callCount)
  const errorCount = Number(row.errorCount)
  const sampledSpanCount = Number(row.sampledSpanCount)
  const unsampledSpanCount = Number(row.unsampledSpanCount)
  const threshold = row.dominantThreshold || ""
  const sampling = estimateThroughput(sampledSpanCount, unsampledSpanCount, threshold, durationSeconds)
  const estimatedCallCount = sampling.hasSampling
    ? Math.round(sampling.estimated * durationSeconds)
    : callCount
  return {
    sourceService: row.sourceService,
    targetService: row.targetService,
    callCount,
    estimatedCallCount,
    errorCount,
    errorRate: callCount > 0 ? (errorCount / callCount) * 100 : 0,
    avgDurationMs: Number(row.avgDurationMs),
    p95DurationMs: Number(row.p95DurationMs),
    hasSampling: sampling.hasSampling,
    samplingWeight: sampling.weight,
  }
}

export const getServiceMap = Effect.fn("Tinybird.getServiceMap")(
  function* ({
    data,
  }: {
    data: GetServiceMapInput
  }) {
    const input = yield* decodeInput(GetServiceMapInputSchema, data ?? {}, "getServiceMap")
    const tinybird = getTinybird()
    const result = yield* runTinybirdQuery("service_dependencies", () =>
      tinybird.query.service_dependencies({
        start_time: input.startTime,
        end_time: input.endTime,
        deployment_env: input.deploymentEnv,
      }),
    )

    const startMs = input.startTime
      ? new Date(input.startTime.replace(" ", "T") + "Z").getTime()
      : 0
    const endMs = input.endTime
      ? new Date(input.endTime.replace(" ", "T") + "Z").getTime()
      : 0
    const durationSeconds =
      startMs > 0 && endMs > 0
        ? Math.max((endMs - startMs) / 1000, 1)
        : 3600

    return {
      edges: result.data.map((row) => transformEdge(row, durationSeconds)),
    }
  },
)

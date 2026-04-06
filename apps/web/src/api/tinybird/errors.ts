import { Effect, Schema } from "effect"
import { QueryEngineExecuteRequest } from "@maple/query-engine"
import {
  ErrorsByTypeRequest,
  ErrorsSummaryRequest,
  ErrorDetailTracesRequest,
  ErrorsTimeseriesRequest,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
  TinybirdDateTimeString,
  decodeInput,
  executeQueryEngine,
  extractFacets,
  runTinybirdQuery,
} from "@/api/tinybird/effect-utils"

const OptionalStringArray = Schema.optional(Schema.mutable(Schema.Array(Schema.String)))

export interface ErrorByType {
  errorType: string
  sampleMessage: string
  count: number
  affectedServicesCount: number
  firstSeen: Date
  lastSeen: Date
}

export interface ErrorsByTypeResponse {
  data: ErrorByType[]
}

const GetErrorsByTypeInputSchema = Schema.Struct({
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
  services: OptionalStringArray,
  deploymentEnvs: OptionalStringArray,
  errorTypes: OptionalStringArray,
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  showSpam: Schema.optional(Schema.Boolean),
  rootOnly: Schema.optional(Schema.Boolean),
})

export type GetErrorsByTypeInput = Schema.Schema.Type<typeof GetErrorsByTypeInputSchema>

export function getErrorsByType({
  data,
}: {
  data: GetErrorsByTypeInput
}) {
  return getErrorsByTypeEffect({ data })
}

const getErrorsByTypeEffect = Effect.fn("QueryEngine.getErrorsByType")(function* ({
  data,
}: {
  data: GetErrorsByTypeInput
}) {
    const input = yield* decodeInput(GetErrorsByTypeInputSchema, data ?? {}, "getErrorsByType")
    const fallback = defaultErrorsTimeRange()

    const result = yield* runTinybirdQuery("errorsByType", () =>
      Effect.gen(function* () {
        const client = yield* MapleApiAtomClient
        return yield* client.queryEngine.errorsByType({
          payload: new ErrorsByTypeRequest({
            startTime: input.startTime ?? fallback.startTime,
            endTime: input.endTime ?? fallback.endTime,
            rootOnly: input.rootOnly,
            services: input.services,
            deploymentEnvs: input.deploymentEnvs,
            errorTypes: input.errorTypes,
            limit: input.limit,
          }),
        })
      }),
    )

    return {
      data: result.data.map((raw) => ({
        errorType: raw.errorType,
        sampleMessage: raw.sampleMessage,
        count: Number(raw.count),
        affectedServicesCount: Number(raw.affectedServicesCount),
        firstSeen: new Date(raw.firstSeen),
        lastSeen: new Date(raw.lastSeen),
      })),
    }
})

export interface FacetItem {
  name: string
  count: number
}

export interface ErrorsFacets {
  services: FacetItem[]
  deploymentEnvs: FacetItem[]
  errorTypes: FacetItem[]
}

export interface ErrorsFacetsResponse {
  data: ErrorsFacets
}

const GetErrorsFacetsInputSchema = Schema.Struct({
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
  services: OptionalStringArray,
  deploymentEnvs: OptionalStringArray,
  errorTypes: OptionalStringArray,
  showSpam: Schema.optional(Schema.Boolean),
  rootOnly: Schema.optional(Schema.Boolean),
})

export type GetErrorsFacetsInput = Schema.Schema.Type<typeof GetErrorsFacetsInputSchema>

const defaultErrorsTimeRange = () => {
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19)
  return { startTime: fmt(dayAgo), endTime: fmt(now) }
}

export function getErrorsFacets({
  data,
}: {
  data: GetErrorsFacetsInput
}) {
  return getErrorsFacetsEffect({ data })
}

const getErrorsFacetsEffect = Effect.fn("QueryEngine.getErrorsFacets")(function* ({
  data,
}: {
  data: GetErrorsFacetsInput
}) {
    const input = yield* decodeInput(GetErrorsFacetsInputSchema, data ?? {}, "getErrorsFacets")
    const fallback = defaultErrorsTimeRange()

    const response = yield* executeQueryEngine("queryEngine.getErrorsFacets", new QueryEngineExecuteRequest({
      startTime: input.startTime ?? fallback.startTime,
      endTime: input.endTime ?? fallback.endTime,
      query: {
        kind: "facets" as const,
        source: "errors" as const,
        filters: {
          rootOnly: input.rootOnly,
          services: input.services,
          deploymentEnvs: input.deploymentEnvs,
          errorTypes: input.errorTypes,
        },
      },
    }))

    const facetsData = extractFacets(response)
    const services: FacetItem[] = []
    const deploymentEnvs: FacetItem[] = []
    const errorTypes: FacetItem[] = []

    for (const row of facetsData) {
      const item = { name: row.name, count: Number(row.count) }
      switch (row.facetType) {
        case "service":
          services.push(item)
          break
        case "deploymentEnv":
          deploymentEnvs.push(item)
          break
        case "errorType":
          errorTypes.push(item)
          break
      }
    }

    return {
      data: { services, deploymentEnvs, errorTypes },
    }
})

export interface ErrorsSummary {
  totalErrors: number
  totalSpans: number
  errorRate: number
  affectedServicesCount: number
  affectedTracesCount: number
}

export interface ErrorsSummaryResponse {
  data: ErrorsSummary | null
}

const GetErrorsSummaryInputSchema = Schema.Struct({
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
  services: OptionalStringArray,
  deploymentEnvs: OptionalStringArray,
  errorTypes: OptionalStringArray,
  showSpam: Schema.optional(Schema.Boolean),
  rootOnly: Schema.optional(Schema.Boolean),
})

export type GetErrorsSummaryInput = Schema.Schema.Type<typeof GetErrorsSummaryInputSchema>

export function getErrorsSummary({
  data,
}: {
  data: GetErrorsSummaryInput
}) {
  return getErrorsSummaryEffect({ data })
}

const getErrorsSummaryEffect = Effect.fn("QueryEngine.getErrorsSummary")(function* ({
  data,
}: {
  data: GetErrorsSummaryInput
}) {
    const input = yield* decodeInput(GetErrorsSummaryInputSchema, data ?? {}, "getErrorsSummary")
    const fallback = defaultErrorsTimeRange()

    const result = yield* runTinybirdQuery("errorsSummary", () =>
      Effect.gen(function* () {
        const client = yield* MapleApiAtomClient
        return yield* client.queryEngine.errorsSummary({
          payload: new ErrorsSummaryRequest({
            startTime: input.startTime ?? fallback.startTime,
            endTime: input.endTime ?? fallback.endTime,
            rootOnly: input.rootOnly,
            services: input.services,
            deploymentEnvs: input.deploymentEnvs,
            errorTypes: input.errorTypes,
          }),
        })
      }),
    )

    const summary = result.data
    return {
      data: summary ? {
        totalErrors: Number(summary.totalErrors),
        totalSpans: Number(summary.totalSpans),
        errorRate: Number(summary.errorRate),
        affectedServicesCount: Number(summary.affectedServicesCount),
        affectedTracesCount: Number(summary.affectedTracesCount),
      } : null,
    }
})

export interface ErrorDetailTrace {
  traceId: string
  startTime: Date
  durationMicros: number
  spanCount: number
  services: string[]
  rootSpanName: string
  errorMessage: string
}

export interface ErrorDetailTracesResponse {
  data: ErrorDetailTrace[]
}

const GetErrorDetailTracesInputSchema = Schema.Struct({
  errorType: Schema.String,
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
  services: OptionalStringArray,
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  showSpam: Schema.optional(Schema.Boolean),
  rootOnly: Schema.optional(Schema.Boolean),
})

export type GetErrorDetailTracesInput = Schema.Schema.Type<typeof GetErrorDetailTracesInputSchema>

export function getErrorDetailTraces({
  data,
}: {
  data: GetErrorDetailTracesInput
}) {
  return getErrorDetailTracesEffect({ data })
}

const getErrorDetailTracesEffect = Effect.fn("QueryEngine.getErrorDetailTraces")(function* ({
  data,
}: {
  data: GetErrorDetailTracesInput
}) {
    const input = yield* decodeInput(
      GetErrorDetailTracesInputSchema,
      data ?? {},
      "getErrorDetailTraces",
    )
    const fallback = defaultErrorsTimeRange()

    const result = yield* runTinybirdQuery("errorDetailTraces", () =>
      Effect.gen(function* () {
        const client = yield* MapleApiAtomClient
        return yield* client.queryEngine.errorDetailTraces({
          payload: new ErrorDetailTracesRequest({
            startTime: input.startTime ?? fallback.startTime,
            endTime: input.endTime ?? fallback.endTime,
            errorType: input.errorType,
            rootOnly: input.rootOnly,
            services: input.services,
            limit: input.limit,
          }),
        })
      }),
    )

    return {
      data: result.data.map((raw) => ({
        traceId: raw.traceId,
        startTime: new Date(raw.startTime),
        durationMicros: Number(raw.durationMicros),
        spanCount: Number(raw.spanCount),
        services: [...raw.services],
        rootSpanName: raw.rootSpanName,
        errorMessage: raw.errorMessage,
      })),
    }
})

export interface ErrorsTimeseriesItem {
  bucket: string
  count: number
}

const GetErrorsTimeseriesInputSchema = Schema.Struct({
  errorType: Schema.String,
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
  services: OptionalStringArray,
  bucketSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  showSpam: Schema.optional(Schema.Boolean),
})

export type GetErrorsTimeseriesInput = Schema.Schema.Type<typeof GetErrorsTimeseriesInputSchema>

export function getErrorsTimeseries({
  data,
}: {
  data: GetErrorsTimeseriesInput
}) {
  return getErrorsTimeseriesEffect({ data })
}

const getErrorsTimeseriesEffect = Effect.fn("QueryEngine.getErrorsTimeseries")(function* ({
  data,
}: {
  data: GetErrorsTimeseriesInput
}) {
    const input = yield* decodeInput(GetErrorsTimeseriesInputSchema, data ?? {}, "getErrorsTimeseries")
    const fallback = defaultErrorsTimeRange()

    const result = yield* runTinybirdQuery("errorsTimeseries", () =>
      Effect.gen(function* () {
        const client = yield* MapleApiAtomClient
        return yield* client.queryEngine.errorsTimeseries({
          payload: new ErrorsTimeseriesRequest({
            startTime: input.startTime ?? fallback.startTime,
            endTime: input.endTime ?? fallback.endTime,
            errorType: input.errorType,
            services: input.services,
            bucketSeconds: input.bucketSeconds,
          }),
        })
      }),
    )

    return {
      data: result.data.map((raw) => ({
        bucket: String(raw.bucket),
        count: Number(raw.count),
      })),
    }
})

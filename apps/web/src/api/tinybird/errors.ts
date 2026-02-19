import { Effect, Schema } from "effect"
import {
  getTinybird,
  type ErrorDetailTracesOutput,
  type ErrorsByTypeOutput,
  type ErrorsFacetsOutput,
  type ErrorsSummaryOutput,
} from "@/lib/tinybird"
import { getSpamPatternsParam } from "@/lib/spam-patterns"
import {
  TinybirdDateTimeString,
  decodeInput,
  runTinybirdQuery,
  type TinybirdApiError,
} from "@/api/tinybird/effect-utils"

const OptionalStringArray = Schema.optional(Schema.mutable(Schema.Array(Schema.String)))

export interface ErrorByType {
  errorType: string
  count: number
  affectedServicesCount: number
  firstSeen: Date
  lastSeen: Date
  affectedServices: string[]
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
  limit: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThan(0))),
  showSpam: Schema.optional(Schema.Boolean),
})

export type GetErrorsByTypeInput = Schema.Schema.Type<typeof GetErrorsByTypeInputSchema>

function transformErrorByType(raw: ErrorsByTypeOutput): ErrorByType {
  return {
    errorType: raw.errorType,
    count: Number(raw.count),
    affectedServicesCount: Number(raw.affectedServicesCount),
    firstSeen: new Date(raw.firstSeen),
    lastSeen: new Date(raw.lastSeen),
    affectedServices: raw.affectedServices,
  }
}

export function getErrorsByType({
  data,
}: {
  data: GetErrorsByTypeInput
}): Effect.Effect<ErrorsByTypeResponse, TinybirdApiError> {
  return Effect.gen(function* () {
    const input = yield* decodeInput(GetErrorsByTypeInputSchema, data ?? {}, "getErrorsByType")
    const tinybird = getTinybird()

    const result = yield* runTinybirdQuery("errors_by_type", () =>
      tinybird.query.errors_by_type({
        start_time: input.startTime,
        end_time: input.endTime,
        services: input.services?.join(","),
        deployment_envs: input.deploymentEnvs?.join(","),
        error_types: input.errorTypes?.join(","),
        limit: input.limit,
        exclude_spam_patterns: getSpamPatternsParam(input.showSpam),
      }),
    )

    return {
      data: result.data.map(transformErrorByType),
    }
  })
}

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
})

export type GetErrorsFacetsInput = Schema.Schema.Type<typeof GetErrorsFacetsInputSchema>

function transformErrorsFacets(facetsData: ErrorsFacetsOutput[]): ErrorsFacets {
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

  return { services, deploymentEnvs, errorTypes }
}

export function getErrorsFacets({
  data,
}: {
  data: GetErrorsFacetsInput
}): Effect.Effect<ErrorsFacetsResponse, TinybirdApiError> {
  return Effect.gen(function* () {
    const input = yield* decodeInput(GetErrorsFacetsInputSchema, data ?? {}, "getErrorsFacets")
    const tinybird = getTinybird()

    const result = yield* runTinybirdQuery("errors_facets", () =>
      tinybird.query.errors_facets({
        start_time: input.startTime,
        end_time: input.endTime,
        services: input.services?.join(","),
        deployment_envs: input.deploymentEnvs?.join(","),
        error_types: input.errorTypes?.join(","),
        exclude_spam_patterns: getSpamPatternsParam(input.showSpam),
      }),
    )

    return {
      data: transformErrorsFacets(result.data),
    }
  })
}

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
})

export type GetErrorsSummaryInput = Schema.Schema.Type<typeof GetErrorsSummaryInputSchema>

function transformErrorsSummary(raw: ErrorsSummaryOutput): ErrorsSummary {
  return {
    totalErrors: Number(raw.totalErrors),
    totalSpans: Number(raw.totalSpans),
    errorRate: Number(raw.errorRate),
    affectedServicesCount: Number(raw.affectedServicesCount),
    affectedTracesCount: Number(raw.affectedTracesCount),
  }
}

export function getErrorsSummary({
  data,
}: {
  data: GetErrorsSummaryInput
}): Effect.Effect<ErrorsSummaryResponse, TinybirdApiError> {
  return Effect.gen(function* () {
    const input = yield* decodeInput(GetErrorsSummaryInputSchema, data ?? {}, "getErrorsSummary")
    const tinybird = getTinybird()

    const result = yield* runTinybirdQuery("errors_summary", () =>
      tinybird.query.errors_summary({
        start_time: input.startTime,
        end_time: input.endTime,
        services: input.services?.join(","),
        deployment_envs: input.deploymentEnvs?.join(","),
        error_types: input.errorTypes?.join(","),
        exclude_spam_patterns: getSpamPatternsParam(input.showSpam),
      }),
    )

    const summary = result.data[0]
    return {
      data: summary ? transformErrorsSummary(summary) : null,
    }
  })
}

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
  limit: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThan(0))),
  showSpam: Schema.optional(Schema.Boolean),
})

export type GetErrorDetailTracesInput = Schema.Schema.Type<typeof GetErrorDetailTracesInputSchema>

function transformErrorDetailTrace(raw: ErrorDetailTracesOutput): ErrorDetailTrace {
  return {
    traceId: raw.traceId,
    startTime: new Date(raw.startTime),
    durationMicros: Number(raw.durationMicros),
    spanCount: Number(raw.spanCount),
    services: raw.services,
    rootSpanName: raw.rootSpanName,
    errorMessage: raw.errorMessage,
  }
}

export function getErrorDetailTraces({
  data,
}: {
  data: GetErrorDetailTracesInput
}): Effect.Effect<ErrorDetailTracesResponse, TinybirdApiError> {
  return Effect.gen(function* () {
    const input = yield* decodeInput(
      GetErrorDetailTracesInputSchema,
      data ?? {},
      "getErrorDetailTraces",
    )
    const tinybird = getTinybird()

    const result = yield* runTinybirdQuery("error_detail_traces", () =>
      tinybird.query.error_detail_traces({
        error_type: input.errorType,
        start_time: input.startTime,
        end_time: input.endTime,
        services: input.services?.join(","),
        limit: input.limit,
        exclude_spam_patterns: getSpamPatternsParam(input.showSpam),
      }),
    )

    return {
      data: result.data.map(transformErrorDetailTrace),
    }
  })
}

import { Effect, Schema } from "effect"
import {
  getTinybird,
  type ListTracesOutput,
  type SpanHierarchyOutput,
  type TracesDurationStatsOutput,
  type TracesFacetsOutput,
} from "@/lib/tinybird"
import {
  TinybirdDateTimeString,
  decodeInput,
  runTinybirdQuery,
} from "@/api/tinybird/effect-utils"

const ListTracesInputSchema = Schema.Struct({
  limit: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1), Schema.lessThanOrEqualTo(1000)),
  ),
  offset: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
  service: Schema.optional(Schema.String),
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
  spanName: Schema.optional(Schema.String),
  hasError: Schema.optional(Schema.Boolean),
  minDurationMs: Schema.optional(Schema.Number),
  maxDurationMs: Schema.optional(Schema.Number),
  httpMethod: Schema.optional(Schema.String),
  httpStatusCode: Schema.optional(Schema.String),
  deploymentEnv: Schema.optional(Schema.String),
  rootOnly: Schema.optional(Schema.Boolean),
})

export type ListTracesInput = Schema.Schema.Type<typeof ListTracesInputSchema>

const DEFAULT_LIMIT = 100
const DEFAULT_OFFSET = 0

export interface Trace {
  traceId: string
  startTime: string
  endTime: string
  durationMs: number
  spanCount: number
  services: string[]
  rootSpanName: string
  hasError: boolean
}

export interface TracesResponse {
  data: Trace[]
  meta: {
    limit: number
    offset: number
  }
}

function transformTrace(raw: ListTracesOutput): Trace {
  return {
    traceId: raw.traceId,
    startTime: String(raw.startTime),
    endTime: String(raw.endTime),
    durationMs: Number(raw.durationMicros) / 1000,
    spanCount: Number(raw.spanCount),
    services: raw.services,
    rootSpanName: raw.rootSpanName,
    hasError: Number(raw.hasError) === 1,
  }
}

export function listTraces({
  data,
}: {
  data: ListTracesInput
}) {
  return listTracesEffect({ data })
}

const listTracesEffect = Effect.fn("Tinybird.listTraces")(function* ({
  data,
}: {
  data: ListTracesInput
}) {
    const input = yield* decodeInput(ListTracesInputSchema, data ?? {}, "listTraces")
    const limit = input.limit ?? DEFAULT_LIMIT
    const offset = input.offset ?? DEFAULT_OFFSET

    const tinybird = getTinybird()
    const result = yield* runTinybirdQuery("list_traces", () =>
      tinybird.query.list_traces({
        limit,
        offset,
        service: input.service,
        start_time: input.startTime,
        end_time: input.endTime,
        span_name: input.spanName,
        has_error: input.hasError,
        min_duration_ms: input.minDurationMs,
        max_duration_ms: input.maxDurationMs,
        http_method: input.httpMethod,
        http_status_code: input.httpStatusCode,
        deployment_env: input.deploymentEnv,
        root_only: input.rootOnly,
      }),
    )

    return {
      data: result.data.map(transformTrace),
      meta: {
        limit,
        offset,
      },
    }
})

export interface Span {
  traceId: string
  spanId: string
  parentSpanId: string
  spanName: string
  serviceName: string
  spanKind: string
  durationMs: number
  startTime: string
  statusCode: string
  statusMessage: string
  spanAttributes: Record<string, string>
  resourceAttributes: Record<string, string>
}

export interface SpanNode extends Span {
  children: SpanNode[]
  depth: number
}

export interface SpanHierarchyResponse {
  traceId: string
  spans: Span[]
  rootSpans: SpanNode[]
  totalDurationMs: number
}

const GetSpanHierarchyInputSchema = Schema.Struct({
  traceId: Schema.String.pipe(Schema.minLength(1)),
  spanId: Schema.optional(Schema.String),
})

export type GetSpanHierarchyInput = Schema.Schema.Type<typeof GetSpanHierarchyInputSchema>

function parseAttributes(value: string | null | undefined): Record<string, string> {
  if (!value) return {}
  const parsed = JSON.parse(value)
  return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
}

function transformSpan(raw: SpanHierarchyOutput): Span {
  return {
    traceId: raw.traceId,
    spanId: raw.spanId,
    parentSpanId: raw.parentSpanId,
    spanName: raw.spanName,
    serviceName: raw.serviceName,
    spanKind: raw.spanKind,
    durationMs: Number(raw.durationMs),
    startTime: String(raw.startTime),
    statusCode: raw.statusCode,
    statusMessage: raw.statusMessage,
    spanAttributes: parseAttributes(raw.spanAttributes),
    resourceAttributes: parseAttributes(raw.resourceAttributes),
  }
}

function buildSpanTree(spans: Span[]): SpanNode[] {
  const spanMap = new Map<string, SpanNode>()
  const rootSpans: SpanNode[] = []

  for (const span of spans) {
    spanMap.set(span.spanId, { ...span, children: [], depth: 0 })
  }

  for (const span of spans) {
    const node = spanMap.get(span.spanId)
    if (!node) {
      continue
    }
    if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
      const parent = spanMap.get(span.parentSpanId)
      parent?.children.push(node)
    } else {
      rootSpans.push(node)
    }
  }

  function setDepth(node: SpanNode, depth: number) {
    node.depth = depth
    for (const child of node.children) {
      setDepth(child, depth + 1)
    }
  }

  for (const root of rootSpans) {
    setDepth(root, 0)
  }

  function sortChildren(node: SpanNode) {
    node.children.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    for (const child of node.children) {
      sortChildren(child)
    }
  }

  for (const root of rootSpans) {
    sortChildren(root)
  }

  rootSpans.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
  return rootSpans
}

export function getSpanHierarchy({
  data,
}: {
  data: GetSpanHierarchyInput
}) {
  return getSpanHierarchyEffect({ data })
}

const getSpanHierarchyEffect = Effect.fn("Tinybird.getSpanHierarchy")(function* ({
  data,
}: {
  data: GetSpanHierarchyInput
}) {
    const input = yield* decodeInput(GetSpanHierarchyInputSchema, data, "getSpanHierarchy")
    const tinybird = getTinybird()

    const result = yield* runTinybirdQuery("span_hierarchy", () =>
      tinybird.query.span_hierarchy({
        trace_id: input.traceId,
        span_id: input.spanId,
      }),
    )

    const spans = result.data.map(transformSpan)
    const rootSpans = buildSpanTree(spans)
    const totalDurationMs = spans.length > 0 ? Math.max(...spans.map((span) => span.durationMs)) : 0

    return {
      traceId: input.traceId,
      spans,
      rootSpans,
      totalDurationMs,
    }
})

export interface FacetItem {
  name: string
  count: number
}

export interface TracesFacets {
  services: FacetItem[]
  spanNames: FacetItem[]
  httpMethods: FacetItem[]
  httpStatusCodes: FacetItem[]
  deploymentEnvs: FacetItem[]
  errorCount: number
  durationStats: {
    minDurationMs: number
    maxDurationMs: number
    p50DurationMs: number
    p95DurationMs: number
  }
}

export interface TracesFacetsResponse {
  data: TracesFacets
}

export interface TracesDurationStatsResponse {
  data: Array<{
    minDurationMs: number
    maxDurationMs: number
    p50DurationMs: number
    p95DurationMs: number
  }>
}

const GetTracesFacetsInputSchema = Schema.Struct({
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
  service: Schema.optional(Schema.String),
  spanName: Schema.optional(Schema.String),
  hasError: Schema.optional(Schema.Boolean),
  minDurationMs: Schema.optional(Schema.Number),
  maxDurationMs: Schema.optional(Schema.Number),
  httpMethod: Schema.optional(Schema.String),
  httpStatusCode: Schema.optional(Schema.String),
  deploymentEnv: Schema.optional(Schema.String),
})

export type GetTracesFacetsInput = Schema.Schema.Type<typeof GetTracesFacetsInputSchema>

function transformFacets(
  facetsData: TracesFacetsOutput[],
  durationStatsData: TracesDurationStatsOutput[],
): TracesFacets {
  const services: FacetItem[] = []
  const spanNames: FacetItem[] = []
  const httpMethods: FacetItem[] = []
  const httpStatusCodes: FacetItem[] = []
  const deploymentEnvs: FacetItem[] = []
  let errorCount = 0

  for (const row of facetsData) {
    const item = { name: row.name, count: Number(row.count) }
    switch (row.facetType) {
      case "service":
        services.push(item)
        break
      case "spanName":
        spanNames.push(item)
        break
      case "httpMethod":
        httpMethods.push(item)
        break
      case "httpStatus":
        httpStatusCodes.push(item)
        break
      case "deploymentEnv":
        deploymentEnvs.push(item)
        break
      case "errorCount":
        errorCount = Number(row.count)
        break
    }
  }

  const durationStats = durationStatsData[0]
    ? {
        minDurationMs: Number(durationStatsData[0].minDurationMs),
        maxDurationMs: Number(durationStatsData[0].maxDurationMs),
        p50DurationMs: Number(durationStatsData[0].p50DurationMs),
        p95DurationMs: Number(durationStatsData[0].p95DurationMs),
      }
    : { minDurationMs: 0, maxDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0 }

  return {
    services,
    spanNames,
    httpMethods,
    httpStatusCodes,
    deploymentEnvs,
    errorCount,
    durationStats,
  }
}

export function getTracesFacets({
  data,
}: {
  data: GetTracesFacetsInput
}) {
  return getTracesFacetsEffect({ data })
}

const getTracesFacetsEffect = Effect.fn("Tinybird.getTracesFacets")(function* ({
  data,
}: {
  data: GetTracesFacetsInput
}) {
    const input = yield* decodeInput(GetTracesFacetsInputSchema, data ?? {}, "getTracesFacets")
    const tinybird = getTinybird()

    const [facetsResult, durationStatsResult] = yield* Effect.all([
      runTinybirdQuery("traces_facets", () =>
        tinybird.query.traces_facets({
          start_time: input.startTime,
          end_time: input.endTime,
          service: input.service,
          span_name: input.spanName,
          has_error: input.hasError,
          min_duration_ms: input.minDurationMs,
          max_duration_ms: input.maxDurationMs,
          http_method: input.httpMethod,
          http_status_code: input.httpStatusCode,
          deployment_env: input.deploymentEnv,
        }),
      ),
      runTinybirdQuery("traces_duration_stats", () =>
        tinybird.query.traces_duration_stats({
          start_time: input.startTime,
          end_time: input.endTime,
          service: input.service,
          span_name: input.spanName,
          has_error: input.hasError,
          http_method: input.httpMethod,
          http_status_code: input.httpStatusCode,
          deployment_env: input.deploymentEnv,
        }),
      ),
    ])

    return {
      data: transformFacets(facetsResult.data, durationStatsResult.data),
    }
})

export function getTracesDurationStats({
  data,
}: {
  data: GetTracesFacetsInput
}) {
  return getTracesDurationStatsEffect({ data })
}

const getTracesDurationStatsEffect = Effect.fn("Tinybird.getTracesDurationStats")(function* ({
  data,
}: {
  data: GetTracesFacetsInput
}) {
    const input = yield* decodeInput(
      GetTracesFacetsInputSchema,
      data ?? {},
      "getTracesDurationStats",
    )
    const tinybird = getTinybird()
    const result = yield* runTinybirdQuery("traces_duration_stats", () =>
      tinybird.query.traces_duration_stats({
        start_time: input.startTime,
        end_time: input.endTime,
        service: input.service,
        span_name: input.spanName,
        has_error: input.hasError,
        http_method: input.httpMethod,
        http_status_code: input.httpStatusCode,
        deployment_env: input.deploymentEnv,
      }),
    )

    return {
      data: result.data.map((row) => ({
        minDurationMs: Number(row.minDurationMs),
        maxDurationMs: Number(row.maxDurationMs),
        p50DurationMs: Number(row.p50DurationMs),
        p95DurationMs: Number(row.p95DurationMs),
      })),
    }
})

const GetSpanAttributeKeysInputSchema = Schema.Struct({
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
})

export type GetSpanAttributeKeysInput = Schema.Schema.Type<typeof GetSpanAttributeKeysInputSchema>

export interface SpanAttributeKeysResponse {
  data: Array<{ attributeKey: string; usageCount: number }>
}

export function getSpanAttributeKeys({
  data,
}: {
  data: GetSpanAttributeKeysInput
}) {
  return getSpanAttributeKeysEffect({ data })
}

const getSpanAttributeKeysEffect = Effect.fn("Tinybird.getSpanAttributeKeys")(function* ({
  data,
}: {
  data: GetSpanAttributeKeysInput
}) {
    const input = yield* decodeInput(
      GetSpanAttributeKeysInputSchema,
      data ?? {},
      "getSpanAttributeKeys",
    )
    const tinybird = getTinybird()
    const result = yield* runTinybirdQuery("span_attribute_keys", () =>
      tinybird.query.span_attribute_keys({
        start_time: input.startTime,
        end_time: input.endTime,
      }),
    )

    return {
      data: result.data.map((row) => ({
        attributeKey: row.attributeKey,
        usageCount: Number(row.usageCount),
      })),
    }
})

const GetSpanAttributeValuesInputSchema = Schema.Struct({
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
  attributeKey: Schema.String,
})

export type GetSpanAttributeValuesInput = Schema.Schema.Type<typeof GetSpanAttributeValuesInputSchema>

export interface SpanAttributeValuesResponse {
  data: Array<{ attributeValue: string; usageCount: number }>
}

export function getSpanAttributeValues({
  data,
}: {
  data: GetSpanAttributeValuesInput
}) {
  return getSpanAttributeValuesEffect({ data })
}

const getSpanAttributeValuesEffect = Effect.fn("Tinybird.getSpanAttributeValues")(
  function* ({
    data,
  }: {
    data: GetSpanAttributeValuesInput
  }) {
    const input = yield* decodeInput(
      GetSpanAttributeValuesInputSchema,
      data ?? {},
      "getSpanAttributeValues",
    )

    if (!input.attributeKey) {
      return { data: [] }
    }

    const tinybird = getTinybird()
    const result = yield* runTinybirdQuery("span_attribute_values", () =>
      tinybird.query.span_attribute_values({
        start_time: input.startTime,
        end_time: input.endTime,
        attribute_key: input.attributeKey,
      }),
    )

    return {
      data: result.data.map((row) => ({
        attributeValue: row.attributeValue,
        usageCount: Number(row.usageCount),
      })),
    }
  },
)

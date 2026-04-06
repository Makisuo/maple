import { Effect, Schema } from "effect"
import { QueryEngineExecuteRequest, type AttributeFilter } from "@maple/query-engine"
import { TraceId, SpanId } from "@maple/domain"
import { SpanHierarchyRequest } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
  TinybirdDateTimeString,
  TinybirdTransformError,
  decodeInput,
  executeQueryEngine,
  extractAttributeValues,
  extractFacets,
  extractStats,
  runTinybirdQuery,
} from "@/api/tinybird/effect-utils"
import { getHttpInfo, type HttpInfo } from "@maple/ui/lib/http"

const toTraceId = Schema.decodeSync(TraceId)
const toSpanId = Schema.decodeSync(SpanId)

const ContainsMatchMode = Schema.optional(Schema.Literals(["contains"]))

const ListTracesInputSchema = Schema.Struct({
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)),
  ),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
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
  attributeKey: Schema.optional(Schema.String),
  attributeValue: Schema.optional(Schema.String),
  resourceAttributeKey: Schema.optional(Schema.String),
  resourceAttributeValue: Schema.optional(Schema.String),
  rootOnly: Schema.optional(Schema.Boolean),
  serviceMatchMode: ContainsMatchMode,
  spanNameMatchMode: ContainsMatchMode,
  deploymentEnvMatchMode: ContainsMatchMode,
  attributeValueMatchMode: ContainsMatchMode,
  resourceAttributeValueMatchMode: ContainsMatchMode,
})

export type ListTracesInput = Schema.Schema.Type<typeof ListTracesInputSchema>

const DEFAULT_LIMIT = 100
const DEFAULT_OFFSET = 0

export interface TraceRootSpanSummary {
  name: string
  kind: string
  statusCode: string
  attributes: Record<string, string>
  http: HttpInfo | null
}

export interface Trace {
  traceId: TraceId
  startTime: string
  endTime: string
  durationMs: number
  spanCount: number
  services: string[]
  rootSpan: TraceRootSpanSummary
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

function buildAttributeFilters(input: ListTracesInput): AttributeFilter[] {
  const filters: AttributeFilter[] = []

  if (input.httpMethod) {
    filters.push({ key: "http.method", value: input.httpMethod, mode: "equals" })
  }
  if (input.httpStatusCode) {
    filters.push({ key: "http.status_code", value: input.httpStatusCode, mode: "equals" })
  }
  if (input.attributeKey && input.attributeValue) {
    filters.push({
      key: input.attributeKey,
      value: input.attributeValue,
      mode: input.attributeValueMatchMode === "contains" ? "contains" : "equals",
    })
  }

  return filters
}

function buildResourceAttributeFilters(input: ListTracesInput): AttributeFilter[] {
  const filters: AttributeFilter[] = []

  if (input.resourceAttributeKey && input.resourceAttributeValue) {
    filters.push({
      key: input.resourceAttributeKey,
      value: input.resourceAttributeValue,
      mode: input.resourceAttributeValueMatchMode === "contains" ? "contains" : "equals",
    })
  }

  return filters
}

/** Transform a list row from tracesListQuery */
function transformSpanListRow(row: Record<string, unknown>): Trace {
  const spanAttrs = (row.spanAttributes ?? {}) as Record<string, string>
  const rootSpanAttributes: Record<string, string> = {}
  if (spanAttrs["http.method"]) rootSpanAttributes["http.method"] = spanAttrs["http.method"]
  if (spanAttrs["http.route"]) rootSpanAttributes["http.route"] = spanAttrs["http.route"]
  if (spanAttrs["http.status_code"]) rootSpanAttributes["http.status_code"] = spanAttrs["http.status_code"]

  const timestamp = String(row.timestamp)
  return {
    traceId: toTraceId(String(row.traceId)),
    startTime: timestamp,
    endTime: timestamp,
    durationMs: Number(row.durationMs),
    spanCount: 1,
    services: [String(row.serviceName)],
    rootSpan: {
      name: String(row.spanName),
      kind: String(row.spanKind),
      statusCode: String(row.statusCode),
      attributes: rootSpanAttributes,
      http: getHttpInfo(String(row.spanName), rootSpanAttributes),
    },
    rootSpanName: String(row.spanName),
    hasError: row.hasError === true || row.hasError === 1,
  }
}

export function listTraces({
  data,
}: {
  data: ListTracesInput
}) {
  return listTracesEffect({ data })
}

const listTracesEffect = Effect.fn("QueryEngine.listTraces")(function* ({
  data,
}: {
  data: ListTracesInput
}) {
  const input = yield* decodeInput(ListTracesInputSchema, data ?? {}, "listTraces")
  const limit = input.limit ?? DEFAULT_LIMIT
  const offset = input.offset ?? DEFAULT_OFFSET

  const attributeFilters = buildAttributeFilters(input)
  const resourceAttributeFilters = buildResourceAttributeFilters(input)

  const matchModes: Record<string, string> = {}
  if (input.serviceMatchMode === "contains") matchModes.serviceName = "contains"
  if (input.spanNameMatchMode === "contains") matchModes.spanName = "contains"
  if (input.deploymentEnvMatchMode === "contains") matchModes.deploymentEnv = "contains"

  const rootOnly = input.rootOnly ?? true

  if (input.service) yield* Effect.annotateCurrentSpan("service", input.service)
  yield* Effect.annotateCurrentSpan("rootOnly", rootOnly)
  yield* Effect.annotateCurrentSpan("limit", limit)

  const request = new QueryEngineExecuteRequest({
    startTime: input.startTime ?? "2020-01-01 00:00:00",
    endTime: input.endTime ?? "2099-12-31 23:59:59",
    query: {
      kind: "list" as const,
      source: "traces" as const,
      limit,
      offset,
      filters: {
        serviceName: input.service,
        spanName: input.spanName,
        rootSpansOnly: rootOnly,
        errorsOnly: input.hasError,
        environments: input.deploymentEnv ? [input.deploymentEnv] : undefined,
        minDurationMs: input.minDurationMs,
        maxDurationMs: input.maxDurationMs,
        matchModes: Object.keys(matchModes).length > 0 ? matchModes : undefined,
        attributeFilters: attributeFilters.length > 0 ? attributeFilters : undefined,
        resourceAttributeFilters: resourceAttributeFilters.length > 0 ? resourceAttributeFilters : undefined,
      },
    },
  })

  const response = yield* executeQueryEngine("queryEngine.listTraces", request)

  if (response.result.kind !== "list") {
    return yield* Effect.fail(
      new TinybirdTransformError({
        operation: "queryEngine.listTraces",
        message: `Unexpected result kind from query engine: ${response.result.kind}`,
      }),
    )
  }

  const traces = response.result.data.map(transformSpanListRow)

  return {
    data: traces,
    meta: { limit, offset },
  }
})

export interface Span {
  traceId: TraceId
  spanId: SpanId
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
  isMissing?: boolean
}

export interface SpanHierarchyResponse {
  traceId: TraceId
  spans: Span[]
  rootSpans: SpanNode[]
  totalDurationMs: number
}

const GetSpanHierarchyInputSchema = Schema.Struct({
  traceId: TraceId,
  spanId: Schema.optional(SpanId),
})

export type GetSpanHierarchyInput = Schema.Schema.Type<typeof GetSpanHierarchyInputSchema>

function parseAttributes(value: string | null | undefined): Record<string, string> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

interface SpanHierarchyRow {
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
  spanAttributes: string
  resourceAttributes: string
}

function transformSpan(raw: SpanHierarchyRow): Span {
  return {
    traceId: toTraceId(raw.traceId),
    spanId: toSpanId(raw.spanId),
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

  const missingParentGroups = new Map<string, SpanNode[]>()

  for (const span of spans) {
    const node = spanMap.get(span.spanId)
    if (!node) {
      continue
    }
    if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
      const parent = spanMap.get(span.parentSpanId)
      parent?.children.push(node)
    } else if (span.parentSpanId) {
      const group = missingParentGroups.get(span.parentSpanId) || []
      group.push(node)
      missingParentGroups.set(span.parentSpanId, group)
    } else {
      rootSpans.push(node)
    }
  }

  for (const [missingParentId, children] of missingParentGroups) {
    const placeholder: SpanNode = {
      traceId: children[0].traceId,
      spanId: toSpanId(missingParentId),
      parentSpanId: "",
      spanName: "Missing Span",
      serviceName: "unknown",
      spanKind: "SPAN_KIND_INTERNAL",
      durationMs: 0,
      startTime: children[0].startTime,
      statusCode: "Unset",
      statusMessage: "",
      spanAttributes: {},
      resourceAttributes: {},
      children,
      depth: 0,
      isMissing: true,
    }
    rootSpans.push(placeholder)
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

const getSpanHierarchyEffect = Effect.fn("QueryEngine.getSpanHierarchy")(function* ({
  data,
}: {
  data: GetSpanHierarchyInput
}) {
    const input = yield* decodeInput(GetSpanHierarchyInputSchema, data, "getSpanHierarchy")

    yield* Effect.annotateCurrentSpan("traceId", input.traceId)
    if (input.spanId) yield* Effect.annotateCurrentSpan("spanId", input.spanId)

    const result = yield* runTinybirdQuery("spanHierarchy", () =>
      Effect.gen(function* () {
        const client = yield* MapleApiAtomClient
        return yield* client.queryEngine.spanHierarchy({
          payload: new SpanHierarchyRequest({
            traceId: input.traceId,
            spanId: input.spanId,
          }),
        })
      }),
    )

    const spans = result.data.map((raw) => transformSpan(raw as SpanHierarchyRow))
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
  attributeKey: Schema.optional(Schema.String),
  attributeValue: Schema.optional(Schema.String),
  resourceAttributeKey: Schema.optional(Schema.String),
  resourceAttributeValue: Schema.optional(Schema.String),
  serviceMatchMode: ContainsMatchMode,
  spanNameMatchMode: ContainsMatchMode,
  deploymentEnvMatchMode: ContainsMatchMode,
  attributeValueMatchMode: ContainsMatchMode,
  resourceAttributeValueMatchMode: ContainsMatchMode,
})

export type GetTracesFacetsInput = Schema.Schema.Type<typeof GetTracesFacetsInputSchema>

function buildTracesFiltersFromInput(input: GetTracesFacetsInput) {
  const attributeFilters = buildAttributeFilters(input as ListTracesInput)
  const resourceAttributeFilters = buildResourceAttributeFilters(input as ListTracesInput)
  const matchModes: Record<string, string> = {}
  if (input.serviceMatchMode === "contains") matchModes.serviceName = "contains"
  if (input.spanNameMatchMode === "contains") matchModes.spanName = "contains"
  if (input.deploymentEnvMatchMode === "contains") matchModes.deploymentEnv = "contains"

  return {
    serviceName: input.service,
    spanName: input.spanName,
    errorsOnly: input.hasError,
    minDurationMs: input.minDurationMs,
    maxDurationMs: input.maxDurationMs,
    environments: input.deploymentEnv ? [input.deploymentEnv] : undefined,
    matchModes: Object.keys(matchModes).length > 0 ? matchModes : undefined,
    attributeFilters: attributeFilters.length > 0 ? attributeFilters : undefined,
    resourceAttributeFilters: resourceAttributeFilters.length > 0 ? resourceAttributeFilters : undefined,
  }
}

export function getTracesFacets({
  data,
}: {
  data: GetTracesFacetsInput
}) {
  return getTracesFacetsEffect({ data })
}

const getTracesFacetsEffect = Effect.fn("QueryEngine.getTracesFacets")(function* ({
  data,
}: {
  data: GetTracesFacetsInput
}) {
    const input = yield* decodeInput(GetTracesFacetsInputSchema, data ?? {}, "getTracesFacets")

    if (input.service) yield* Effect.annotateCurrentSpan("service", input.service)

    const filters = buildTracesFiltersFromInput(input)
    const fallback = defaultTimeRange()
    const startTime = input.startTime ?? fallback.startTime
    const endTime = input.endTime ?? fallback.endTime

    const [facetsResponse, statsResponse] = yield* Effect.all([
      executeQueryEngine("queryEngine.getTracesFacets", new QueryEngineExecuteRequest({
        startTime, endTime,
        query: { kind: "facets" as const, source: "traces" as const, filters },
      })),
      executeQueryEngine("queryEngine.getTracesDurationStats", new QueryEngineExecuteRequest({
        startTime, endTime,
        query: { kind: "stats" as const, source: "traces" as const, filters },
      })),
    ])

    const facetsData = extractFacets(facetsResponse)
    const statsData = extractStats(statsResponse)

    const toItem = (row: { name: string; count: number }): FacetItem => ({ name: row.name, count: Number(row.count) })
    const byType = (type: string) => facetsData.filter((r) => r.facetType === type).map(toItem)
    const errorRow = facetsData.find((r) => r.facetType === "errorCount")

    return {
      data: {
        services: byType("service"),
        spanNames: byType("spanName"),
        httpMethods: byType("httpMethod"),
        httpStatusCodes: byType("httpStatus"),
        deploymentEnvs: byType("deploymentEnv"),
        errorCount: errorRow ? Number(errorRow.count) : 0,
        durationStats: statsData,
      } satisfies TracesFacets,
    }
})

export function getTracesDurationStats({
  data,
}: {
  data: GetTracesFacetsInput
}) {
  return getTracesDurationStatsEffect({ data })
}

const getTracesDurationStatsEffect = Effect.fn("QueryEngine.getTracesDurationStats")(function* ({
  data,
}: {
  data: GetTracesFacetsInput
}) {
    const input = yield* decodeInput(
      GetTracesFacetsInputSchema,
      data ?? {},
      "getTracesDurationStats",
    )
    const filters = buildTracesFiltersFromInput(input)
    const fallback = defaultTimeRange()

    const response = yield* executeQueryEngine("queryEngine.getTracesDurationStats", new QueryEngineExecuteRequest({
      startTime: input.startTime ?? fallback.startTime,
      endTime: input.endTime ?? fallback.endTime,
      query: { kind: "stats" as const, source: "traces" as const, filters },
    }))

    return {
      data: [extractStats(response)],
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

const defaultTimeRange = () => {
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19)
  return { startTime: fmt(dayAgo), endTime: fmt(now) }
}

const getSpanAttributeKeysEffect = Effect.fn("QueryEngine.getSpanAttributeKeys")(function* ({
  data,
}: {
  data: GetSpanAttributeKeysInput
}) {
    const input = yield* decodeInput(
      GetSpanAttributeKeysInputSchema,
      data ?? {},
      "getSpanAttributeKeys",
    )
    const fallback = defaultTimeRange()
    const request = new QueryEngineExecuteRequest({
      startTime: input.startTime ?? fallback.startTime,
      endTime: input.endTime ?? fallback.endTime,
      query: { kind: "attributeKeys" as const, source: "traces" as const, scope: "span" as const },
    })
    const response = yield* executeQueryEngine("queryEngine.getSpanAttributeKeys", request)
    const result = response.result
    if (result.kind !== "attributeKeys") return { data: [] }

    return {
      data: result.data.map((row) => ({
        attributeKey: row.key,
        usageCount: Number(row.count),
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

const getSpanAttributeValuesEffect = Effect.fn("QueryEngine.getSpanAttributeValues")(
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

    yield* Effect.annotateCurrentSpan("attributeKey", input.attributeKey)

    if (!input.attributeKey) {
      return { data: [] }
    }

    const fallback = defaultTimeRange()
    const response = yield* executeQueryEngine("queryEngine.getSpanAttributeValues", new QueryEngineExecuteRequest({
      startTime: input.startTime ?? fallback.startTime,
      endTime: input.endTime ?? fallback.endTime,
      query: { kind: "attributeValues" as const, source: "traces" as const, scope: "span" as const, attributeKey: input.attributeKey },
    }))

    return {
      data: extractAttributeValues(response).map((row) => ({
        attributeValue: row.value,
        usageCount: Number(row.count),
      })),
    }
  },
)

const GetResourceAttributeKeysInputSchema = Schema.Struct({
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
})

export type GetResourceAttributeKeysInput = Schema.Schema.Type<typeof GetResourceAttributeKeysInputSchema>

export interface ResourceAttributeKeysResponse {
  data: Array<{ attributeKey: string; usageCount: number }>
}

export function getResourceAttributeKeys({
  data,
}: {
  data: GetResourceAttributeKeysInput
}) {
  return getResourceAttributeKeysEffect({ data })
}

const getResourceAttributeKeysEffect = Effect.fn("QueryEngine.getResourceAttributeKeys")(function* ({
  data,
}: {
  data: GetResourceAttributeKeysInput
}) {
    const input = yield* decodeInput(
      GetResourceAttributeKeysInputSchema,
      data ?? {},
      "getResourceAttributeKeys",
    )
    const fallback = defaultTimeRange()
    const request = new QueryEngineExecuteRequest({
      startTime: input.startTime ?? fallback.startTime,
      endTime: input.endTime ?? fallback.endTime,
      query: { kind: "attributeKeys" as const, source: "traces" as const, scope: "resource" as const },
    })
    const response = yield* executeQueryEngine("queryEngine.getResourceAttributeKeys", request)
    const result = response.result
    if (result.kind !== "attributeKeys") return { data: [] }

    return {
      data: result.data.map((row) => ({
        attributeKey: row.key,
        usageCount: Number(row.count),
      })),
    }
})

const GetResourceAttributeValuesInputSchema = Schema.Struct({
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
  attributeKey: Schema.String,
})

export type GetResourceAttributeValuesInput = Schema.Schema.Type<typeof GetResourceAttributeValuesInputSchema>

export interface ResourceAttributeValuesResponse {
  data: Array<{ attributeValue: string; usageCount: number }>
}

export function getResourceAttributeValues({
  data,
}: {
  data: GetResourceAttributeValuesInput
}) {
  return getResourceAttributeValuesEffect({ data })
}

const getResourceAttributeValuesEffect = Effect.fn("QueryEngine.getResourceAttributeValues")(
  function* ({
    data,
  }: {
    data: GetResourceAttributeValuesInput
  }) {
    const input = yield* decodeInput(
      GetResourceAttributeValuesInputSchema,
      data ?? {},
      "getResourceAttributeValues",
    )

    yield* Effect.annotateCurrentSpan("attributeKey", input.attributeKey)

    if (!input.attributeKey) {
      return { data: [] }
    }

    const fallback = defaultTimeRange()
    const response = yield* executeQueryEngine("queryEngine.getResourceAttributeValues", new QueryEngineExecuteRequest({
      startTime: input.startTime ?? fallback.startTime,
      endTime: input.endTime ?? fallback.endTime,
      query: { kind: "attributeValues" as const, source: "traces" as const, scope: "resource" as const, attributeKey: input.attributeKey },
    }))

    return {
      data: extractAttributeValues(response).map((row) => ({
        attributeValue: row.value,
        usageCount: Number(row.count),
      })),
    }
  },
)

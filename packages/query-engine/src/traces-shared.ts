// ---------------------------------------------------------------------------
// Shared constants and helpers used by both the legacy traces-sql-builder
// and the new CH DSL queries.
// ---------------------------------------------------------------------------

import type { TracesMetric, AttributeFilter } from "./query-engine"

// ---------------------------------------------------------------------------
// Metric → column needs mapping
// ---------------------------------------------------------------------------

export type MetricNeed = "count" | "avg_duration" | "quantiles" | "error_rate" | "apdex"

export const METRIC_NEEDS: Record<TracesMetric, MetricNeed[]> = {
  count: ["count"],
  avg_duration: ["count", "avg_duration"],
  p50_duration: ["count", "quantiles"],
  p95_duration: ["count", "quantiles"],
  p99_duration: ["count", "quantiles"],
  error_rate: ["count", "error_rate"],
  apdex: ["count", "apdex"],
}

// ---------------------------------------------------------------------------
// trace_list_mv column mappings
// ---------------------------------------------------------------------------

export const TRACE_LIST_MV_ATTR_MAP: Record<string, string> = {
  "http.method": "HttpMethod",
  "http.request.method": "HttpMethod",
  "http.route": "HttpRoute",
  "url.path": "HttpRoute",
  "http.target": "HttpRoute",
  "http.status_code": "HttpStatusCode",
  "http.response.status_code": "HttpStatusCode",
}

export const TRACE_LIST_MV_RESOURCE_MAP: Record<string, string> = {
  "deployment.environment": "DeploymentEnv",
}

export const NUMERIC_MV_COLUMNS = new Set(["HttpStatusCode"])

// ---------------------------------------------------------------------------
// trace_list_mv eligibility check
// ---------------------------------------------------------------------------

export function canUseTraceListMv(params: {
  rootOnly?: boolean
  attributeFilters?: readonly AttributeFilter[]
  resourceAttributeFilters?: readonly AttributeFilter[]
  commitShas?: readonly string[]
  groupBy?: readonly string[] | string
  groupByAttributeKeys?: readonly string[]
  groupByAttributeKey?: string
}): boolean {
  if (!params.rootOnly) return false
  if (params.commitShas?.length) return false

  if (params.attributeFilters) {
    for (const af of params.attributeFilters) {
      if (!TRACE_LIST_MV_ATTR_MAP[af.key]) return false
    }
  }

  if (params.resourceAttributeFilters) {
    for (const rf of params.resourceAttributeFilters) {
      if (!TRACE_LIST_MV_RESOURCE_MAP[rf.key]) return false
    }
  }

  const groupByArray = Array.isArray(params.groupBy) ? params.groupBy : params.groupBy ? [params.groupBy] : []
  if (groupByArray.includes("attribute")) {
    const attrKeys = params.groupByAttributeKeys ?? (params.groupByAttributeKey ? [params.groupByAttributeKey] : [])
    for (const key of attrKeys) {
      if (!TRACE_LIST_MV_ATTR_MAP[key]) return false
    }
  }

  return true
}

// ---------------------------------------------------------------------------
// Attribute filter → SQL string
// ---------------------------------------------------------------------------

const MODE_TO_OPERATOR: Record<string, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
}

export function buildAttrFilterSQL(
  af: AttributeFilter,
  useMv: boolean,
  mapName: "SpanAttributes" | "ResourceAttributes",
  mvMap: Record<string, string>,
): string {
  const mvColumn = useMv ? mvMap[af.key] : undefined
  const escapedKey = `'${escapeForSQL(af.key)}'`
  const escapedValue = `'${escapeForSQL(af.value ?? "")}'`

  if (af.mode === "exists") {
    return mvColumn
      ? `${mvColumn} != ''`
      : `mapContains(${mapName}, ${escapedKey})`
  }

  if (af.mode === "contains") {
    const col = mvColumn ?? `${mapName}[${escapedKey}]`
    return `positionCaseInsensitive(${col}, ${escapedValue}) > 0`
  }

  const op = MODE_TO_OPERATOR[af.mode]
  if (op) {
    if (mvColumn) {
      const cast = NUMERIC_MV_COLUMNS.has(mvColumn) ? `toUInt16OrZero(${mvColumn})` : mvColumn
      return `${cast} ${op} ${escapedValue}`
    }
    const rawEscaped = af.value?.replace(/\\/g, "\\\\").replace(/'/g, "\\'") ?? ""
    return `toFloat64OrZero(${mapName}[${escapedKey}]) ${op} ${rawEscaped}`
  }

  // equals (default)
  if (mvColumn) {
    return `${mvColumn} = ${escapedValue}`
  }
  return `${mapName}[${escapedKey}] = ${escapedValue}`
}

function escapeForSQL(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

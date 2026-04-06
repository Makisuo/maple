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

export function canUseTraceListMv(_params: {
  rootOnly?: boolean
  attributeFilters?: readonly AttributeFilter[]
  resourceAttributeFilters?: readonly AttributeFilter[]
  commitShas?: readonly string[]
  groupBy?: readonly string[] | string
  groupByAttributeKeys?: readonly string[]
  groupByAttributeKey?: string
}): boolean {
  // The MV only contains ParentSpanId='' rows, but rootOnly means
  // "entry point spans" (Server/Consumer OR ParentSpanId=''), which is broader.
  // Disable MV until it is updated to include Server/Consumer spans.
  return false
}

// ---------------------------------------------------------------------------
// Attribute filter → typed Condition
// ---------------------------------------------------------------------------

import * as CH from "./ch/expr"

export function buildAttrFilterCondition(
  af: AttributeFilter,
  useMv: boolean,
  mapName: "SpanAttributes" | "ResourceAttributes",
  mvMap: Record<string, string>,
): CH.Condition {
  const mvColumn = useMv ? mvMap[af.key] : undefined
  const colExpr: CH.Expr<string> = mvColumn
    ? CH.dynamicColumn<string>(mvColumn)
    : CH.mapGet(CH.dynamicColumn<Record<string, string>>(mapName), af.key)
  const value = af.value ?? ""

  if (af.mode === "exists") {
    return mvColumn
      ? CH.dynamicColumn<string>(mvColumn).neq("")
      : CH.mapContains(CH.dynamicColumn<Record<string, string>>(mapName), af.key)
  }

  if (af.mode === "contains") {
    return CH.positionCaseInsensitive(colExpr, CH.lit(value)).gt(0)
  }

  if (af.mode === "gt") {
    const numExpr = mvColumn && NUMERIC_MV_COLUMNS.has(mvColumn)
      ? CH.toUInt16OrZero(CH.dynamicColumn<string>(mvColumn))
      : CH.toFloat64OrZero(colExpr)
    return numExpr.gt(Number(value))
  }
  if (af.mode === "gte") {
    const numExpr = mvColumn && NUMERIC_MV_COLUMNS.has(mvColumn)
      ? CH.toUInt16OrZero(CH.dynamicColumn<string>(mvColumn))
      : CH.toFloat64OrZero(colExpr)
    return numExpr.gte(Number(value))
  }
  if (af.mode === "lt") {
    const numExpr = mvColumn && NUMERIC_MV_COLUMNS.has(mvColumn)
      ? CH.toUInt16OrZero(CH.dynamicColumn<string>(mvColumn))
      : CH.toFloat64OrZero(colExpr)
    return numExpr.lt(Number(value))
  }
  if (af.mode === "lte") {
    const numExpr = mvColumn && NUMERIC_MV_COLUMNS.has(mvColumn)
      ? CH.toUInt16OrZero(CH.dynamicColumn<string>(mvColumn))
      : CH.toFloat64OrZero(colExpr)
    return numExpr.lte(Number(value))
  }

  // equals (default)
  return colExpr.eq(value)
}

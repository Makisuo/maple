// ---------------------------------------------------------------------------
// Shared constants and helpers used by the CH DSL queries.
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
// trace_list_mv column mappings (used by performance-hints UI)
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

// ---------------------------------------------------------------------------
// Attribute filter → typed Condition
// ---------------------------------------------------------------------------

import * as CH from "./ch/expr"

export function buildAttrFilterCondition(
  af: AttributeFilter,
  mapName: "SpanAttributes" | "ResourceAttributes",
): CH.Condition {
  const colExpr: CH.Expr<string> = CH.mapGet(CH.dynamicColumn<Record<string, string>>(mapName), af.key)
  const value = af.value ?? ""

  if (af.mode === "exists") {
    return CH.mapContains(CH.dynamicColumn<Record<string, string>>(mapName), af.key)
  }

  if (af.mode === "contains") {
    return CH.positionCaseInsensitive(colExpr, CH.lit(value)).gt(0)
  }

  if (af.mode === "gt") {
    return CH.toFloat64OrZero(colExpr).gt(Number(value))
  }
  if (af.mode === "gte") {
    return CH.toFloat64OrZero(colExpr).gte(Number(value))
  }
  if (af.mode === "lt") {
    return CH.toFloat64OrZero(colExpr).lt(Number(value))
  }
  if (af.mode === "lte") {
    return CH.toFloat64OrZero(colExpr).lte(Number(value))
  }

  // equals (default)
  return colExpr.eq(value)
}

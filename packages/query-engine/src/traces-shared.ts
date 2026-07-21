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

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { normalizedSpanNameExpr } from "@maple/domain/tinybird/span-display-name"

// ---------------------------------------------------------------------------
// HTTP semconv coalescing
//
// OpenTelemetry renamed several HTTP span attributes in the stable semconv:
//   http.method      → http.request.method
//   http.status_code → http.response.status_code
// `trace_list_mv` coalesces both spellings when it pre-extracts its columns
// (see materializations.ts), so the quick-filter facet counts cover spans that
// use *either* key. Filters that read the raw `traces` table must coalesce the
// same way — otherwise a facet shows a count while applying it matches zero
// rows (the data carries the new key, the filter looked up the old one).
// ---------------------------------------------------------------------------

const HTTP_SEMCONV_ALIASES: Record<string, readonly string[]> = {
	"http.method": ["http.method", "http.request.method"],
	"http.request.method": ["http.method", "http.request.method"],
	"http.status_code": ["http.status_code", "http.response.status_code"],
	"http.response.status_code": ["http.status_code", "http.response.status_code"],
}

/** `if(map[k0] != '', map[k0], if(map[k1] != '', …))` — first non-empty alias. */
function coalescedMapGet(mapExpr: CH.Expr<Record<string, string>>, keys: readonly string[]): CH.Expr<string> {
	let expr = CH.mapGet(mapExpr, keys[keys.length - 1])
	for (let i = keys.length - 2; i >= 0; i--) {
		const candidate = CH.mapGet(mapExpr, keys[i])
		expr = CH.if_(candidate.neq(""), candidate, expr)
	}
	return expr
}

/** `mapContains(map, k0) OR mapContains(map, k1) OR …` */
function anyMapContains(mapExpr: CH.Expr<Record<string, string>>, keys: readonly string[]): CH.Condition {
	let cond = CH.mapContains(mapExpr, keys[0])
	for (let i = 1; i < keys.length; i++) {
		cond = cond.or(CH.mapContains(mapExpr, keys[i]))
	}
	return cond
}

/**
 * Rewrites an HTTP server span name to the display form used by the UI and by
 * `trace_list_mv.SpanName`: spanName `"http.server GET"` + route → `"GET /api/users"`.
 * Centralized so the MV, span-hierarchy query, and span-name filter stay in
 * sync — drift between them caused the "Root Span" quick filter to return zero rows.
 */
export function httpDisplaySpanName(
	spanName: CH.Expr<string>,
	route: CH.Expr<string>,
	urlPath: CH.Expr<string>,
): CH.Expr<string> {
	return normalizedSpanNameExpr(spanName, route, urlPath)
}

export function buildAttrFilterCondition(
	af: AttributeFilter,
	mapName: "SpanAttributes" | "LogAttributes" | "ResourceAttributes",
): CH.Condition {
	const mapExpr = CH.dynamicColumn<Record<string, string>>(mapName)
	// Span attributes renamed across OTel semconv versions match either spelling,
	// mirroring trace_list_mv. Resource attributes have no such aliases.
	const keys = mapName === "SpanAttributes" ? (HTTP_SEMCONV_ALIASES[af.key] ?? [af.key]) : [af.key]
	const colExpr: CH.Expr<string> = coalescedMapGet(mapExpr, keys)
	const value = af.value ?? ""

	const positive = ((): CH.Condition => {
		if (af.mode === "exists") {
			return anyMapContains(mapExpr, keys)
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
	})()

	return af.negated ? CH.not(positive) : positive
}

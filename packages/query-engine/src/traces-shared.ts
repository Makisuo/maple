// Shared constants and helpers used by the CH DSL queries.

import type { TracesMetric, AttributeFilter } from "@maple/domain/query-engine"
import type { AttributeIndexMode } from "./capabilities"

// Metric → column needs mapping

export type MetricNeed = "count" | "avg_duration" | "quantiles" | "error_rate" | "apdex"

export const METRIC_NEEDS: Record<TracesMetric, MetricNeed[]> = {
	count: ["count"],
	avg_duration: ["count", "avg_duration"],
	p50_duration: ["count", "quantiles"],
	p95_duration: ["count", "quantiles"],
	p99_duration: ["count", "quantiles"],
	error_rate: ["count", "error_rate"],
	apdex: ["count", "apdex"],
} satisfies Record<TracesMetric, MetricNeed[]>

// trace_list_mv column mappings (used by performance-hints UI)

export const TRACE_LIST_MV_ATTR_MAP: Record<string, string> = {
	"http.method": "HttpMethod",
	"http.request.method": "HttpMethod",
	"http.route": "HttpRoute",
	"url.path": "HttpRoute",
	"http.target": "HttpRoute",
	"http.status_code": "HttpStatusCode",
	"http.response.status_code": "HttpStatusCode",
} satisfies Record<string, string>

export const TRACE_LIST_MV_RESOURCE_MAP: Record<string, string> = {
	"deployment.environment": "DeploymentEnv",
	"deployment.environment.name": "DeploymentEnv",
} satisfies Record<string, string>

// Attribute filter → typed Condition

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { normalizedSpanNameExpr } from "@maple/domain/tinybird/span-display-name"
import * as T from "@maple-dev/clickhouse-builder/types"

// Semconv rename coalescing
//
// OpenTelemetry renamed several HTTP span attributes in the stable semconv:
//   http.method      → http.request.method
//   http.status_code → http.response.status_code
// `trace_list_mv` coalesces both spellings when it pre-extracts its columns
// (see materializations.ts), so the quick-filter facet counts cover spans that
// use *either* key. Filters that read the raw `traces` table must coalesce the
// same way — otherwise a facet shows a count while applying it matches zero
// rows (the data carries the new key, the filter looked up the old one).

const HTTP_SEMCONV_ALIASES: Record<string, readonly string[]> = {
	"http.method": ["http.method", "http.request.method"],
	"http.request.method": ["http.method", "http.request.method"],
	"http.status_code": ["http.status_code", "http.response.status_code"],
	"http.response.status_code": ["http.status_code", "http.response.status_code"],
} satisfies Record<string, readonly string[]>

/**
 * The same treatment for the one renamed *resource* attribute: the registry
 * marks `deployment.environment` deprecated, "Replaced by
 * `deployment.environment.name`". Both spellings are in the wild — our own SDKs
 * dual-emit, a current OTel SDK sends only `.name`, an older one only the legacy
 * key — so either filter spelling has to match either stored key. Canonical
 * first, matching `DEPLOYMENT_ENV_SQL`'s coalesce order.
 */
const RESOURCE_SEMCONV_ALIASES: Record<string, readonly string[]> = {
	"deployment.environment": ["deployment.environment.name", "deployment.environment"],
	"deployment.environment.name": ["deployment.environment.name", "deployment.environment"],
} satisfies Record<string, readonly string[]>

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
	indexMode: AttributeIndexMode = "none",
): CH.Condition {
	const mapExpr = CH.dynamicColumn<Record<string, string>>(mapName)
	// Attributes renamed across OTel semconv versions match either spelling,
	// mirroring trace_list_mv (span attributes) and the MVs' pre-extracted
	// `DeploymentEnv` (resource attributes).
	const aliasTable =
		mapName === "SpanAttributes"
			? HTTP_SEMCONV_ALIASES
			: mapName === "ResourceAttributes"
				? RESOURCE_SEMCONV_ALIASES
				: undefined
	const keys = aliasTable?.[af.key] ?? [af.key]
	const colExpr: CH.Expr<string> = coalescedMapGet(mapExpr, keys)
	const value = af.value ?? ""

	/**
	 * OR one index prefilter per aliased key. `undefined` when there are no keys
	 * to prefilter on, in which case the exact predicate stands alone — an
	 * alias table never yields an empty list, but a prefilter over no keys is
	 * `has(…, NULL)` rather than a wider read.
	 */
	const orOverKeys = (make: (key: string) => CH.Condition): CH.Condition | undefined =>
		keys.reduce<CH.Condition | undefined>(
			(acc, key) => (acc === undefined ? make(key) : acc.or(make(key))),
			undefined,
		)

	const positive = ((): CH.Condition => {
		if (af.mode === "exists") {
			// ClickHouse `Map` lookups return the value type's default (`''`) for a
			// missing key, and instrumentation also writes genuinely empty values.
			// `mapContains` alone therefore let `''` rows through, so an `exists`
			// filter still produced a "(no value)" bucket in breakdowns — exactly
			// what the user was filtering out. Require a non-empty value too, which
			// makes `!exists` (the `NOT (...)` wrapper below) mean "absent or empty".
			const exact = anyMapContains(mapExpr, keys).and(colExpr.neq(""))
			if (af.negated || indexMode === "none") return exact
			const candidate = orOverKeys((key) => CH.has(CH.mapKeys(mapExpr), CH.lit(key)))
			return candidate === undefined ? exact : candidate.and(exact)
		}
		if (af.mode === "contains") {
			return CH.positionCaseInsensitive(colExpr, CH.lit(value)).gt(0)
		}
		if (af.mode === "in") {
			// No index prefilter: bloom/text candidates are per-value, so an OR of N
			// of them plus the exact IN reads more granules than the IN alone once N
			// grows. The IN over the coalesced alias expression is already exact.
			const values = af.values ?? []
			// `x IN ()` is a ClickHouse syntax error, and an empty candidate set
			// matches nothing by definition — emit a constant-false predicate so a
			// `negated` empty filter still correctly excludes nothing.
			if (values.length === 0) return CH.rawCond("0")
			return CH.inList(colExpr, values)
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
		const exact = colExpr.eq(value)
		// Empty values intentionally share ClickHouse Map's "missing key returns
		// default empty string" behavior. A KV-items prefilter would exclude
		// missing keys and change that contract, so keep the baseline predicate.
		if (af.negated || value === "" || indexMode === "none") return exact

		if (indexMode === "text") {
			const itemColumnByMap = {
				SpanAttributes: "SpanAttributeItems",
				LogAttributes: "LogAttributeItems",
				ResourceAttributes: "ResourceAttributeItems",
			} as const
			const items = CH.dynamicColumn<ReadonlyArray<string>>(itemColumnByMap[mapName])
			const candidate = orOverKeys((key) =>
				CH.has(items, CH.concat(key, CH.rawExpr("char(31)", T.string), value)),
			)
			return candidate === undefined ? exact : candidate.and(exact)
		}

		// Bloom filters index keys and values independently. The original map
		// equality remains as exact confirmation, preventing cross-key matches.
		const keyCandidate = orOverKeys((key) => CH.has(CH.mapKeys(mapExpr), CH.lit(key)))
		const valueCandidate = CH.has(CH.mapValues(mapExpr), CH.lit(value))
		return keyCandidate === undefined
			? valueCandidate.and(exact)
			: keyCandidate.and(valueCandidate).and(exact)
	})()

	return af.negated ? CH.not(positive) : positive
}

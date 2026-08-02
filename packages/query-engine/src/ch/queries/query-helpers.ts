// ---------------------------------------------------------------------------
// Shared query helpers
//
// Reusable expression builders and WHERE condition helpers used across
// traces, alerts, services, and metrics queries.
// ---------------------------------------------------------------------------

import type { AttributeFilter, MetricType } from "../../query-engine"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import type { ColumnAccessor } from "@maple-dev/clickhouse-builder"
import type { ServiceOverviewSpans, Traces, TracesAggregatesHourly } from "../tables"
import { MetricsSum, MetricsGauge, MetricsHistogram, MetricsExpHistogram } from "../tables"
import { buildAttrFilterCondition, httpDisplaySpanName } from "../../traces-shared"
import type { AttributeIndexMode } from "../../capabilities"

// ---------------------------------------------------------------------------
// APDEX expressions
// ---------------------------------------------------------------------------

/**
 * Build the standard APDEX aggregation expressions (satisfiedCount,
 * toleratingCount, apdexScore) from a duration expression and threshold.
 *
 * Per the Apdex spec, a *failed* request counts as frustrated regardless of how
 * fast it was. When `errorCondition` is supplied, errored spans are excluded
 * from the satisfied and tolerating buckets (they remain in `total`, so they
 * drag the score down). Omitting it falls back to latency-only classification.
 *
 * @param durationMs - An expression representing span duration in milliseconds
 *                     (typically `$.Duration.div(1000000)`)
 * @param thresholdMs - The APDEX "T" threshold in milliseconds
 * @param errorCondition - Optional predicate identifying errored spans
 *                         (typically `$.StatusCode.eq("Error")`)
 */
export function apdexExprs(durationMs: CH.Expr<number>, thresholdMs: number, errorCondition?: CH.Condition) {
	const satisfiedLatency = durationMs.lt(thresholdMs)
	const toleratingLatency = durationMs.gte(thresholdMs).and(durationMs.lt(thresholdMs * 4))
	// Gate the latency buckets on "not an error" so failed requests fall through
	// to frustrated. `total` still counts every span, so errors pull the score down.
	const satisfiedCond = errorCondition ? CH.not(errorCondition).and(satisfiedLatency) : satisfiedLatency
	const toleratingCond = errorCondition ? CH.not(errorCondition).and(toleratingLatency) : toleratingLatency
	const satisfied = CH.countIf(satisfiedCond)
	const tolerating = CH.countIf(toleratingCond)
	const total = CH.count()
	// Split the formula so SQL operator precedence stays correct.
	// (s + t*0.5) / n  ≡  s/n + (t*0.5)/n
	// Writing it as `satisfied.add(tolerating.mul(0.5)).div(count())` would
	// compile to `satisfied + tolerating * 0.5 / count()`, which by SQL
	// precedence evaluates as `satisfied + ((tolerating*0.5)/count())` — i.e.
	// returns ~`satisfied`, not a 0–1 ratio.
	const satisfiedRatio = satisfied.div(total)
	const toleratingRatio = tolerating.mul(0.5).div(total)
	return {
		satisfiedCount: satisfied,
		toleratingCount: tolerating,
		apdexScore: CH.if_(total.gt(0), CH.round_(satisfiedRatio.add(toleratingRatio), 4), CH.lit(0)),
	}
}

// ---------------------------------------------------------------------------
// Attribute map projection
// ---------------------------------------------------------------------------

/**
 * Build a ClickHouse `map()` literal that extracts only the requested attribute
 * keys from a Map column. Selecting the full `SpanAttributes` / `ResourceAttributes`
 * map for every row materializes large per-row JSON — projecting just the keys
 * the UI renders is a large win on wide traces.
 */
export function buildProjectedMapExpr(
	requestedKeys: readonly string[],
	mapName: "SpanAttributes" | "ResourceAttributes" | "LogAttributes",
): CH.Expr<Record<string, string>> {
	if (requestedKeys.length === 0) return CH.mapLiteral()
	const pairs: Array<[string, CH.Expr<string>]> = requestedKeys.map((key) => {
		const valueExpr: CH.Expr<string> = CH.mapGet(CH.dynamicColumn<Record<string, string>>(mapName), key)
		return [key, valueExpr]
	})
	return CH.mapLiteral(...pairs)
}

// ---------------------------------------------------------------------------
// Traces base WHERE conditions
// ---------------------------------------------------------------------------

interface TracesMatchModes {
	serviceName?: "contains"
	spanName?: "contains"
	deploymentEnv?: "contains"
	serviceNamespace?: "contains"
}

export interface TracesBaseWhereOpts {
	serviceName?: string
	spanName?: string
	/** Multi-value spelling; wins over the scalar field when non-empty. */
	serviceNames?: readonly string[]
	spanNames?: readonly string[]
	statusCode?: "Ok" | "Error" | "Unset"
	rootOnly?: boolean
	errorsOnly?: boolean
	environments?: readonly string[]
	namespaces?: readonly string[]
	commitShas?: readonly string[]
	attributeFilters?: readonly AttributeFilter[]
	resourceAttributeFilters?: readonly AttributeFilter[]
	matchModes?: TracesMatchModes
	minDurationMs?: number
	maxDurationMs?: number
	excludedServiceNames?: readonly string[]
	excludedSpanNames?: readonly string[]
	excludedEnvironments?: readonly string[]
	excludedNamespaces?: readonly string[]
	attributeIndexMode?: AttributeIndexMode
}

/**
 * Collapse the scalar and array spellings of an inclusion filter into one list.
 *
 * The scalar field is the original spelling and is still what the dashboard DSL,
 * MCP tools and alert rules emit; the array is what the traces UI sends once the
 * user ticks more than one facet value. The array wins when non-empty.
 *
 * Returns `undefined` for "no filter" so callers can keep using `CH.when`.
 */
export function inclusionValues(
	scalar: string | undefined,
	list: readonly string[] | undefined,
): readonly string[] | undefined {
	if (list?.length) return list
	if (scalar) return [scalar]
	return undefined
}

/**
 * `col = 'x'` for a single value, `col IN (...)` for several.
 *
 * Keeping equality as its own form matters beyond aesthetics: single-value is
 * the overwhelmingly common case, and `=` is what the captured `db.query.text`
 * span attribute and every query fingerprint carried before multi-select.
 */
export function inclusionCondition(col: CH.Expr<string>, values: readonly string[]): CH.Condition {
	return values.length === 1 ? col.eq(values[0]!) : CH.inList(col, values)
}

/**
 * Tri-state errorsOnly filter: `true` keeps only errored spans, `false` keeps
 * only non-errored spans, `undefined` applies no filter. The `false` case
 * backs `has_error = false` clauses (e.g. the "OK" side of an errors-vs-OK
 * comparison) — collapsing it to "no filter" silently counts every span.
 */
export function errorsOnlyCondition(
	statusCode: CH.Expr<string>,
	errorsOnly: boolean | undefined,
): CH.Condition | undefined {
	if (errorsOnly === true) return statusCode.eq("Error")
	if (errorsOnly === false) return statusCode.neq("Error")
	return undefined
}

type TracesBaseWhereColumns = Pick<
	typeof Traces.columns,
	| "OrgId"
	| "Timestamp"
	| "ServiceName"
	| "SpanName"
	| "SpanKind"
	| "ParentSpanId"
	| "StatusCode"
	| "Duration"
	| "ResourceAttributes"
	| "SpanAttributes"
>

/**
 * Build the WHERE conditions shared between traces queries and alert queries:
 * OrgId, Timestamp range, serviceName, spanName, rootOnly, errorsOnly,
 * environments, commitShas, attribute filters, duration filters, and
 * optional "contains" match modes.
 *
 * Alert queries omit matchModes and duration filters — they just don't pass them.
 */
export function tracesBaseWhereConditions(
	$: ColumnAccessor<TracesBaseWhereColumns>,
	opts: TracesBaseWhereOpts,
): Array<CH.Condition | undefined> {
	const mm = opts.matchModes
	const services = inclusionValues(opts.serviceName, opts.serviceNames)
	const spanNames = inclusionValues(opts.spanName, opts.spanNames)
	const conditions: Array<CH.Condition | undefined> = [
		$.OrgId.eq(param.string("orgId")),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
		CH.when(services, (v: readonly string[]) =>
			mm?.serviceName === "contains" && v.length === 1
				? CH.positionCaseInsensitive($.ServiceName, CH.lit(v[0]!)).gt(0)
				: inclusionCondition($.ServiceName, v),
		),
		CH.when(spanNames, (v: readonly string[]) => {
			// The "Root Span" facet and trace_list_mv expose the *display* name
			// ("GET /api/users"); the raw traces table stores "http.server GET".
			// Match either spelling so a facet click actually selects rows.
			const display = httpDisplaySpanName(
				$.SpanName,
				$.SpanAttributes.get("http.route"),
				$.SpanAttributes.get("url.path"),
			)
			return mm?.spanName === "contains" && v.length === 1
				? CH.positionCaseInsensitive($.SpanName, CH.lit(v[0]!))
						.gt(0)
						.or(CH.positionCaseInsensitive(display, CH.lit(v[0]!)).gt(0))
				: inclusionCondition($.SpanName, v).or(inclusionCondition(display, v))
		}),
		CH.when(opts.statusCode, (v: string) => $.StatusCode.eq(v)),
		CH.whenTrue(!!opts.rootOnly, () => $.SpanKind.in_("Server", "Consumer").or($.ParentSpanId.eq(""))),
		errorsOnlyCondition($.StatusCode, opts.errorsOnly),
	]

	if (opts.minDurationMs != null) {
		conditions.push($.Duration.gte(opts.minDurationMs * 1000000))
	}
	if (opts.maxDurationMs != null) {
		conditions.push($.Duration.lte(opts.maxDurationMs * 1000000))
	}

	if (opts.environments?.length) {
		if (mm?.deploymentEnv === "contains" && opts.environments.length === 1) {
			conditions.push(
				CH.positionCaseInsensitive(
					$.ResourceAttributes.get("deployment.environment"),
					CH.lit(opts.environments[0]),
				).gt(0),
			)
		} else {
			conditions.push(CH.inList($.ResourceAttributes.get("deployment.environment"), opts.environments))
		}
	}
	if (opts.namespaces?.length) {
		if (mm?.serviceNamespace === "contains" && opts.namespaces.length === 1) {
			conditions.push(
				CH.positionCaseInsensitive(
					$.ResourceAttributes.get("service.namespace"),
					CH.lit(opts.namespaces[0]),
				).gt(0),
			)
		} else {
			conditions.push(CH.inList($.ResourceAttributes.get("service.namespace"), opts.namespaces))
		}
	}
	if (opts.commitShas?.length) {
		conditions.push(CH.inList($.ResourceAttributes.get("deployment.commit_sha"), opts.commitShas))
	}
	if (opts.attributeFilters) {
		for (const af of opts.attributeFilters) {
			conditions.push(buildAttrFilterCondition(af, "SpanAttributes", opts.attributeIndexMode))
		}
	}
	if (opts.resourceAttributeFilters) {
		for (const rf of opts.resourceAttributeFilters) {
			conditions.push(buildAttrFilterCondition(rf, "ResourceAttributes", opts.attributeIndexMode))
		}
	}
	if (opts.excludedServiceNames?.length) {
		conditions.push(CH.notInList($.ServiceName, opts.excludedServiceNames))
	}
	if (opts.excludedSpanNames?.length) {
		// Display-name aware: exclude rows matching either the raw or rewritten span name.
		const display = httpDisplaySpanName(
			$.SpanName,
			$.SpanAttributes.get("http.route"),
			$.SpanAttributes.get("url.path"),
		)
		conditions.push(
			CH.not(
				CH.inList($.SpanName, opts.excludedSpanNames).or(CH.inList(display, opts.excludedSpanNames)),
			),
		)
	}
	if (opts.excludedEnvironments?.length) {
		conditions.push(
			CH.notInList($.ResourceAttributes.get("deployment.environment"), opts.excludedEnvironments),
		)
	}
	if (opts.excludedNamespaces?.length) {
		conditions.push(CH.notInList($.ResourceAttributes.get("service.namespace"), opts.excludedNamespaces))
	}

	return conditions
}

// ---------------------------------------------------------------------------
// ServiceOverviewSpans MV compatibility
//
// The service_overview_spans MV pre-filters traces at write time to
// `SpanKind IN ('Server','Consumer') OR ParentSpanId = ''` and pre-extracts
// `DeploymentEnv` / `CommitSha` from ResourceAttributes. It is ~20-100x cheaper
// to scan than raw `traces` for dashboard timeseries that don't break down by
// span name or attributes.
//
// Checks whether a set of filters/groupBy can be satisfied purely from the
// MV's column set. The MV lacks SpanName, SpanKind, ParentSpanId,
// SpanAttributes, and ResourceAttributes.
// ---------------------------------------------------------------------------

/** Returns true iff the opts + groupBy can be served by service_overview_spans_mv. */
export function canUseServiceOverviewMv(opts: TracesBaseWhereOpts, groupBy?: readonly string[]): boolean {
	// The MV is *lossy*: it stores only entry-point spans (Server/Consumer OR
	// root). That set is equivalent to the raw table only when the query itself
	// asks for entry points via `rootOnly`. Routing a non-rootOnly query here
	// silently swaps the population — the query says "all spans" and gets
	// "entry spans", which is how one dashboard could show a breakdown by
	// service (MV-routed, entry spans) next to a breakdown by span name
	// (raw-routed, all spans) with a 20x gap between their totals.
	if (!opts.rootOnly) return false
	// The MV has no SpanName column, so neither spelling of the span-name filter
	// can be served from it.
	if (opts.spanName || opts.spanNames?.length) return false
	if (opts.excludedSpanNames?.length) return false
	if (opts.attributeFilters?.length) return false
	if (opts.resourceAttributeFilters?.length) return false
	if (groupBy) {
		for (const g of groupBy) {
			if (g === "span_name" || g === "http_method" || g === "attribute") return false
		}
	}
	return true
}

/**
 * Build the WHERE conditions for queries against service_overview_spans.
 * Mirrors the subset of tracesBaseWhereConditions that the MV can serve.
 * `rootOnly` is a no-op here: the MV already pre-filters to entry-point spans,
 * and `canUseServiceOverviewMv` only routes rootOnly queries to it.
 */
export function serviceOverviewWhereConditions(
	$: ColumnAccessor<typeof ServiceOverviewSpans.columns>,
	opts: TracesBaseWhereOpts,
): Array<CH.Condition | undefined> {
	const mm = opts.matchModes
	const services = inclusionValues(opts.serviceName, opts.serviceNames)
	const conditions: Array<CH.Condition | undefined> = [
		$.OrgId.eq(param.string("orgId")),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
		CH.when(services, (v: readonly string[]) =>
			mm?.serviceName === "contains" && v.length === 1
				? CH.positionCaseInsensitive($.ServiceName, CH.lit(v[0]!)).gt(0)
				: inclusionCondition($.ServiceName, v),
		),
		errorsOnlyCondition($.StatusCode, opts.errorsOnly),
	]

	if (opts.minDurationMs != null) {
		conditions.push($.Duration.gte(opts.minDurationMs * 1000000))
	}
	if (opts.maxDurationMs != null) {
		conditions.push($.Duration.lte(opts.maxDurationMs * 1000000))
	}

	if (opts.environments?.length) {
		if (mm?.deploymentEnv === "contains" && opts.environments.length === 1) {
			conditions.push(CH.positionCaseInsensitive($.DeploymentEnv, CH.lit(opts.environments[0])).gt(0))
		} else {
			conditions.push(CH.inList($.DeploymentEnv, opts.environments))
		}
	}
	if (opts.namespaces?.length) {
		if (mm?.serviceNamespace === "contains" && opts.namespaces.length === 1) {
			conditions.push(CH.positionCaseInsensitive($.ServiceNamespace, CH.lit(opts.namespaces[0])).gt(0))
		} else {
			conditions.push(CH.inList($.ServiceNamespace, opts.namespaces))
		}
	}
	if (opts.commitShas?.length) {
		conditions.push(CH.inList($.CommitSha, opts.commitShas))
	}
	if (opts.excludedServiceNames?.length) {
		conditions.push(CH.notInList($.ServiceName, opts.excludedServiceNames))
	}
	if (opts.excludedEnvironments?.length) {
		conditions.push(CH.notInList($.DeploymentEnv, opts.excludedEnvironments))
	}
	if (opts.excludedNamespaces?.length) {
		conditions.push(CH.notInList($.ServiceNamespace, opts.excludedNamespaces))
	}

	return conditions
}

// ---------------------------------------------------------------------------
// TracesAggregatesHourly MV compatibility
//
// `traces_aggregates_hourly` is the generalized aggregating MV. Its dimensions
// are (OrgId, Hour, ServiceName, SpanName, SpanKind, StatusCode, IsEntryPoint,
// DeploymentEnv) and it stores sample-weighted -State columns (count, duration
// sum, t-digest quantiles, error count) plus min/max. Queries that filter and
// group on a subset of those dimensions can be answered by reading hourly rows
// instead of raw spans — orders of magnitude cheaper for 7d+ ranges.
// ---------------------------------------------------------------------------

/**
 * Returns true iff a query (filters + groupBy + bucketSeconds) can be served
 * from `traces_aggregates_hourly` instead of raw `traces`.
 *
 * Constraints:
 *   - bucket >= 1h (the MV is hourly; finer granularity needs raw)
 *   - No span/resource attribute filters (MV doesn't carry the maps)
 *   - groupBy keys must map to MV dimensions (no http_method, no attribute-based)
 */
export function canUseTracesAggregatesMv(
	opts: TracesBaseWhereOpts,
	groupBy: readonly string[] | undefined,
	bucketSeconds: number | undefined,
): boolean {
	if (bucketSeconds == null || bucketSeconds < 3600) return false
	if (opts.attributeFilters?.length) return false
	if (opts.resourceAttributeFilters?.length) return false
	if (opts.commitShas?.length) return false // MV doesn't carry CommitSha
	if (opts.namespaces?.length || opts.excludedNamespaces?.length) return false // MV doesn't carry ServiceNamespace
	if (opts.minDurationMs != null || opts.maxDurationMs != null) return false
	if (groupBy) {
		for (const g of groupBy) {
			if (g === "http_method" || g === "attribute") return false
		}
	}
	return true
}

/**
 * Build WHERE conditions for queries against traces_aggregates_hourly.
 *
 * `hourBounds` overrides the default `[startTime, endTime]` window with raw SQL
 * expressions. Callers that union this MV with raw partial-hour edges pass the
 * whole-hour interior (`[firstFullHour, endHour)`) so the two halves tile the
 * requested window exactly instead of overlapping or leaving a gap.
 */
export function tracesAggregatesWhereConditions(
	$: ColumnAccessor<typeof TracesAggregatesHourly.columns>,
	opts: TracesBaseWhereOpts,
	hourBounds?: { readonly gte: string; readonly lt: string },
): Array<CH.Condition | undefined> {
	const mm = opts.matchModes
	const services = inclusionValues(opts.serviceName, opts.serviceNames)
	const spanNames = inclusionValues(opts.spanName, opts.spanNames)
	const conditions: Array<CH.Condition | undefined> = [
		$.OrgId.eq(param.string("orgId")),
		hourBounds ? $.Hour.gte(CH.rawExpr<string>(hourBounds.gte)) : $.Hour.gte(param.dateTime("startTime")),
		hourBounds ? $.Hour.lt(CH.rawExpr<string>(hourBounds.lt)) : $.Hour.lte(param.dateTime("endTime")),
		CH.when(services, (v: readonly string[]) =>
			mm?.serviceName === "contains" && v.length === 1
				? CH.positionCaseInsensitive($.ServiceName, CH.lit(v[0]!)).gt(0)
				: inclusionCondition($.ServiceName, v),
		),
		CH.when(spanNames, (v: readonly string[]) =>
			mm?.spanName === "contains" && v.length === 1
				? CH.positionCaseInsensitive($.SpanName, CH.lit(v[0]!)).gt(0)
				: inclusionCondition($.SpanName, v),
		),
		CH.whenTrue(!!opts.rootOnly, () => $.IsEntryPoint.eq(1)),
		errorsOnlyCondition($.StatusCode, opts.errorsOnly),
	]

	if (opts.environments?.length) {
		if (mm?.deploymentEnv === "contains" && opts.environments.length === 1) {
			conditions.push(CH.positionCaseInsensitive($.DeploymentEnv, CH.lit(opts.environments[0])).gt(0))
		} else {
			conditions.push(CH.inList($.DeploymentEnv, opts.environments))
		}
	}
	if (opts.excludedServiceNames?.length) {
		conditions.push(CH.notInList($.ServiceName, opts.excludedServiceNames))
	}
	if (opts.excludedSpanNames?.length) {
		conditions.push(CH.notInList($.SpanName, opts.excludedSpanNames))
	}
	if (opts.excludedEnvironments?.length) {
		conditions.push(CH.notInList($.DeploymentEnv, opts.excludedEnvironments))
	}

	// Note: minDurationMs/maxDurationMs filtering is intentionally *not* supported
	// here. The MV stores aggregate state, not individual durations — filtering
	// before merge would change which spans contribute to the t-digest, requiring
	// a different MV partitioning scheme. Queries with duration filters route to
	// raw traces.
	return conditions
}

// ---------------------------------------------------------------------------
// Metrics table lookup + SELECT factory
// ---------------------------------------------------------------------------

const VALUE_TABLES = {
	sum: MetricsSum,
	gauge: MetricsGauge,
} as const

const HISTOGRAM_TABLES = {
	histogram: MetricsHistogram,
	exponential_histogram: MetricsExpHistogram,
} as const

export function resolveMetricTable(metricType: MetricType) {
	const isHistogram = metricType === "histogram" || metricType === "exponential_histogram"
	const tbl = isHistogram
		? HISTOGRAM_TABLES[metricType as keyof typeof HISTOGRAM_TABLES]
		: VALUE_TABLES[metricType as keyof typeof VALUE_TABLES]
	return { tbl, isHistogram }
}

/**
 * Build the standard metrics aggregation SELECT expressions.
 * For value tables (sum/gauge): operates on $.Value column.
 * For histogram tables: operates on $.Sum, $.Count, $.Min, $.Max columns.
 */
export function metricsSelectExprs($: ColumnAccessor<typeof MetricsSum.columns>, isHistogram: boolean) {
	if (isHistogram) {
		const $h = $ as unknown as ColumnAccessor<typeof MetricsHistogram.columns>
		return {
			avgValue: CH.if_(CH.sum($h.Count).gt(0), CH.sum($h.Sum).div(CH.sum($h.Count)), CH.lit(0)),
			minValue: CH.min_($h.Min),
			maxValue: CH.max_($h.Max),
			sumValue: CH.sum($h.Sum),
			dataPointCount: CH.sum($h.Count),
		}
	}
	return {
		avgValue: CH.avg($.Value),
		minValue: CH.min_($.Value),
		maxValue: CH.max_($.Value),
		sumValue: CH.sum($.Value),
		dataPointCount: CH.count(),
	}
}

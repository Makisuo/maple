// ---------------------------------------------------------------------------
// Shared query helpers
//
// Reusable expression builders and WHERE condition helpers used across
// traces, alerts, services, and metrics queries.
// ---------------------------------------------------------------------------

import type { AttributeFilter, MetricType } from "../../query-engine"
import * as CH from "../expr"
import { param } from "../param"
import type { ColumnAccessor } from "../query"
import type { ServiceOverviewSpans, Traces, TracesAggregatesHourly } from "../tables"
import { MetricsSum, MetricsGauge, MetricsHistogram, MetricsExpHistogram } from "../tables"
import { buildAttrFilterCondition } from "../../traces-shared"

// ---------------------------------------------------------------------------
// APDEX expressions
// ---------------------------------------------------------------------------

/**
 * Build the standard APDEX aggregation expressions (satisfiedCount,
 * toleratingCount, apdexScore) from a duration expression and threshold.
 *
 * @param durationMs - An expression representing span duration in milliseconds
 *                     (typically `$.Duration.div(1000000)`)
 * @param thresholdMs - The APDEX "T" threshold in milliseconds
 */
export function apdexExprs(durationMs: CH.Expr<number>, thresholdMs: number) {
	const satisfied = CH.countIf(durationMs.lt(thresholdMs))
	const tolerating = CH.countIf(durationMs.gte(thresholdMs).and(durationMs.lt(thresholdMs * 4)))
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
// Traces base WHERE conditions
// ---------------------------------------------------------------------------

interface TracesMatchModes {
	serviceName?: "contains"
	spanName?: "contains"
	deploymentEnv?: "contains"
}

export interface TracesBaseWhereOpts {
	serviceName?: string
	spanName?: string
	rootOnly?: boolean
	errorsOnly?: boolean
	environments?: readonly string[]
	commitShas?: readonly string[]
	attributeFilters?: readonly AttributeFilter[]
	resourceAttributeFilters?: readonly AttributeFilter[]
	matchModes?: TracesMatchModes
	minDurationMs?: number
	maxDurationMs?: number
}

/**
 * Build the WHERE conditions shared between traces queries and alert queries:
 * OrgId, Timestamp range, serviceName, spanName, rootOnly, errorsOnly,
 * environments, commitShas, attribute filters, duration filters, and
 * optional "contains" match modes.
 *
 * Alert queries omit matchModes and duration filters — they just don't pass them.
 */
export function tracesBaseWhereConditions(
	$: ColumnAccessor<typeof Traces.columns>,
	opts: TracesBaseWhereOpts,
): Array<CH.Condition | undefined> {
	const mm = opts.matchModes
	const conditions: Array<CH.Condition | undefined> = [
		$.OrgId.eq(param.string("orgId")),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
		CH.when(opts.serviceName, (v: string) =>
			mm?.serviceName === "contains"
				? CH.positionCaseInsensitive($.ServiceName, CH.lit(v)).gt(0)
				: $.ServiceName.eq(v),
		),
		CH.when(opts.spanName, (v: string) =>
			mm?.spanName === "contains"
				? CH.positionCaseInsensitive($.SpanName, CH.lit(v)).gt(0)
				: $.SpanName.eq(v),
		),
		CH.whenTrue(!!opts.rootOnly, () => $.SpanKind.in_("Server", "Consumer").or($.ParentSpanId.eq(""))),
		CH.whenTrue(!!opts.errorsOnly, () => $.StatusCode.eq("Error")),
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
	if (opts.commitShas?.length) {
		conditions.push(CH.inList($.ResourceAttributes.get("deployment.commit_sha"), opts.commitShas))
	}
	if (opts.attributeFilters) {
		for (const af of opts.attributeFilters) {
			conditions.push(buildAttrFilterCondition(af, "SpanAttributes"))
		}
	}
	if (opts.resourceAttributeFilters) {
		for (const rf of opts.resourceAttributeFilters) {
			conditions.push(buildAttrFilterCondition(rf, "ResourceAttributes"))
		}
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
	if (opts.spanName) return false
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
 * `rootOnly` is a no-op here: the MV already pre-filters to entry-point spans.
 */
export function serviceOverviewWhereConditions(
	$: ColumnAccessor<typeof ServiceOverviewSpans.columns>,
	opts: TracesBaseWhereOpts,
): Array<CH.Condition | undefined> {
	const mm = opts.matchModes
	const conditions: Array<CH.Condition | undefined> = [
		$.OrgId.eq(param.string("orgId")),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
		CH.when(opts.serviceName, (v: string) =>
			mm?.serviceName === "contains"
				? CH.positionCaseInsensitive($.ServiceName, CH.lit(v)).gt(0)
				: $.ServiceName.eq(v),
		),
		CH.whenTrue(!!opts.errorsOnly, () => $.StatusCode.eq("Error")),
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
	if (opts.commitShas?.length) {
		conditions.push(CH.inList($.CommitSha, opts.commitShas))
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
	if (opts.minDurationMs != null || opts.maxDurationMs != null) return false
	if (groupBy) {
		for (const g of groupBy) {
			if (g === "http_method" || g === "attribute") return false
		}
	}
	return true
}

/** Build WHERE conditions for queries against traces_aggregates_hourly. */
export function tracesAggregatesWhereConditions(
	$: ColumnAccessor<typeof TracesAggregatesHourly.columns>,
	opts: TracesBaseWhereOpts,
): Array<CH.Condition | undefined> {
	const mm = opts.matchModes
	const conditions: Array<CH.Condition | undefined> = [
		$.OrgId.eq(param.string("orgId")),
		$.Hour.gte(param.dateTime("startTime")),
		$.Hour.lte(param.dateTime("endTime")),
		CH.when(opts.serviceName, (v: string) =>
			mm?.serviceName === "contains"
				? CH.positionCaseInsensitive($.ServiceName, CH.lit(v)).gt(0)
				: $.ServiceName.eq(v),
		),
		CH.when(opts.spanName, (v: string) =>
			mm?.spanName === "contains"
				? CH.positionCaseInsensitive($.SpanName, CH.lit(v)).gt(0)
				: $.SpanName.eq(v),
		),
		CH.whenTrue(!!opts.rootOnly, () => $.IsEntryPoint.eq(1)),
		CH.whenTrue(!!opts.errorsOnly, () => $.StatusCode.eq("Error")),
	]

	if (opts.environments?.length) {
		if (mm?.deploymentEnv === "contains" && opts.environments.length === 1) {
			conditions.push(CH.positionCaseInsensitive($.DeploymentEnv, CH.lit(opts.environments[0])).gt(0))
		} else {
			conditions.push(CH.inList($.DeploymentEnv, opts.environments))
		}
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

export const VALUE_TABLES = {
	sum: MetricsSum,
	gauge: MetricsGauge,
} as const

export const HISTOGRAM_TABLES = {
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

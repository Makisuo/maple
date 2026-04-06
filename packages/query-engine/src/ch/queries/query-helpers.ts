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
import type { Traces } from "../tables"
import {
  MetricsSum,
  MetricsGauge,
  MetricsHistogram,
  MetricsExpHistogram,
} from "../tables"
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
  return {
    satisfiedCount: satisfied,
    toleratingCount: tolerating,
    apdexScore: CH.if_(
      CH.count().gt(0),
      CH.round_(
        satisfied.add(tolerating.mul(0.5)).div(CH.count()),
        4,
      ),
      CH.lit(0),
    ),
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
    CH.whenTrue(!!opts.rootOnly, () =>
      $.SpanKind.in_("Server", "Consumer").or($.ParentSpanId.eq("")),
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
      conditions.push(CH.positionCaseInsensitive($.ResourceAttributes.get("deployment.environment"), CH.lit(opts.environments[0])).gt(0))
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
export function metricsSelectExprs(
  $: ColumnAccessor<typeof MetricsSum.columns>,
  isHistogram: boolean,
) {
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

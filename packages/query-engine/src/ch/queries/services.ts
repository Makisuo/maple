// ---------------------------------------------------------------------------
// Typed Services Queries
//
// DSL-based query definitions for service overview, releases, apdex, and usage.
// ---------------------------------------------------------------------------

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from, type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import { unionAll, type CHUnionQuery } from "@maple-dev/clickhouse-builder"
import { ServiceOverviewSpans, ServiceUsage } from "../tables"
import { apdexExprs, serviceOverviewWhereConditions } from "./query-helpers"

// ---------------------------------------------------------------------------
// Service overview
// ---------------------------------------------------------------------------

export interface ServiceOverviewOpts {
	environments?: readonly string[]
	namespaces?: readonly string[]
	commitShas?: readonly string[]
	serviceName?: string
	limit?: number
}

export interface ServiceOverviewOutput {
	readonly serviceName: string
	readonly serviceNamespace: string
	readonly environment: string
	readonly commitSha: string
	readonly throughput: number
	readonly errorCount: number
	readonly estimatedErrorCount: number
	readonly spanCount: number
	readonly p50LatencyMs: number
	readonly p95LatencyMs: number
	readonly p99LatencyMs: number
	readonly estimatedSpanCount: number
}

export interface ServiceCatalogOpts {
	serviceName?: string
	deploymentEnvironment?: string
	serviceNamespace?: string
	limit?: number
	offset?: number
}

export interface ServiceCatalogOutput {
	readonly serviceName: string
	readonly serviceNamespaces: readonly string[]
	readonly deploymentEnvironments: readonly string[]
	readonly spanCount: number
	readonly errorCount: number
	readonly estimatedErrorCount: number
	readonly estimatedSpanCount: number
	readonly p50LatencyMs: number
	readonly p95LatencyMs: number
	readonly p99LatencyMs: number
}

/** Name-level public service catalog, intentionally aggregated across env/namespace. */
export function serviceCatalogQuery(opts: ServiceCatalogOpts) {
	return from(ServiceOverviewSpans)
		.select(($) => ({
			serviceName: $.ServiceName,
			serviceNamespaces: CH.rawExpr<readonly string[]>(
				"arraySort(arrayFilter(x -> x != '', arrayDistinct(groupArray(ServiceNamespace))))",
			),
			deploymentEnvironments: CH.rawExpr<readonly string[]>(
				"arraySort(arrayFilter(x -> x != '', arrayDistinct(groupArray(DeploymentEnv))))",
			),
			spanCount: CH.count(),
			errorCount: CH.countIf($.StatusCode.eq("Error")),
			estimatedErrorCount: CH.sumIf($.SampleRate, $.StatusCode.eq("Error")),
			estimatedSpanCount: CH.sum($.SampleRate),
			p50LatencyMs: CH.quantile(0.5)($.Duration).div(1000000),
			p95LatencyMs: CH.quantile(0.95)($.Duration).div(1000000),
			p99LatencyMs: CH.quantile(0.99)($.Duration).div(1000000),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.when(opts.serviceName, (value: string) => $.ServiceName.eq(value)),
			CH.when(opts.deploymentEnvironment, (value: string) => $.DeploymentEnv.eq(value)),
			CH.when(opts.serviceNamespace, (value: string) => $.ServiceNamespace.eq(value)),
		])
		.groupBy("serviceName")
		.orderBy(["estimatedSpanCount", "desc"], ["serviceName", "asc"])
		.limit(opts.limit ?? 20)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

export function serviceOverviewQuery(opts: ServiceOverviewOpts) {
	return from(ServiceOverviewSpans)
		.select(($) => ({
			serviceName: $.ServiceName,
			serviceNamespace: $.ServiceNamespace,
			environment: $.DeploymentEnv,
			commitSha: $.CommitSha,
			throughput: CH.count(),
			errorCount: CH.countIf($.StatusCode.eq("Error")),
			estimatedErrorCount: CH.sumIf($.SampleRate, $.StatusCode.eq("Error")),
			spanCount: CH.count(),
			p50LatencyMs: CH.quantile(0.5)($.Duration).div(1000000),
			p95LatencyMs: CH.quantile(0.95)($.Duration).div(1000000),
			p99LatencyMs: CH.quantile(0.99)($.Duration).div(1000000),
			// Per-span weighted sum: each row's `SampleRate` is 1.0 for unsampled
			// rows or `1 / acceptanceProbability` for spans carrying a `th:` value.
			// Replaces the broken `sampledSpanCount * dominantWeight` approximation.
			estimatedSpanCount: CH.sum($.SampleRate),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.when(opts.serviceName, (value: string) => $.ServiceName.eq(value)),
			opts.environments?.length ? CH.inList($.DeploymentEnv, opts.environments) : undefined,
			opts.namespaces?.length ? CH.inList($.ServiceNamespace, opts.namespaces) : undefined,
			opts.commitShas?.length ? CH.inList($.CommitSha, opts.commitShas) : undefined,
		])
		.groupBy("serviceName", "serviceNamespace", "environment", "commitSha")
		.orderBy(["throughput", "desc"])
		.limit(opts.limit ?? 100)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Service health baseline
// ---------------------------------------------------------------------------

export interface ServiceHealthBaselineOpts {
	environments?: readonly string[]
	namespaces?: readonly string[]
}

export interface ServiceHealthBaselineOutput {
	readonly serviceName: string
	readonly serviceNamespace: string
	readonly environment: string
	readonly baselineP95LatencyMs: number
	readonly baselineSpanCount: number
}

/**
 * Per-service latency baseline backing the dashboard's baseline-relative
 * health badges. Same source MV as {@link serviceOverviewQuery} but grouped
 * without `CommitSha` and meant to be compiled with a trailing multi-day
 * window ending at the start of the range being judged, so a service is only
 * flagged when it's slow relative to its own history.
 */
export function serviceHealthBaselineQuery(opts: ServiceHealthBaselineOpts) {
	return from(ServiceOverviewSpans)
		.select(($) => ({
			serviceName: $.ServiceName,
			serviceNamespace: $.ServiceNamespace,
			environment: $.DeploymentEnv,
			baselineP95LatencyMs: CH.quantile(0.95)($.Duration).div(1000000),
			baselineSpanCount: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			opts.environments?.length ? CH.inList($.DeploymentEnv, opts.environments) : undefined,
			opts.namespaces?.length ? CH.inList($.ServiceNamespace, opts.namespaces) : undefined,
		])
		.groupBy("serviceName", "serviceNamespace", "environment")
		.orderBy(["baselineSpanCount", "desc"])
		.limit(200)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Service releases timeline
// ---------------------------------------------------------------------------

export interface ServiceReleasesTimelineOpts {
	serviceName: string
}

export interface ServiceReleasesTimelineOutput {
	readonly bucket: string
	readonly commitSha: string
	readonly count: number
}

export function serviceReleasesTimelineQuery(opts: ServiceReleasesTimelineOpts) {
	return from(ServiceOverviewSpans)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			commitSha: $.CommitSha,
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			$.CommitSha.neq(""),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.groupBy("bucket", "commitSha")
		.orderBy(["bucket", "asc"])
		.limit(1000)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Service environments
//
// Distinct non-empty deployment environments a single service reports in the
// window. Backs the service-detail environment switcher, replacing an
// all-services overview scan that fetched every service's rows just to extract
// one service's environments. Service-scoped + time-windowed so ClickHouse
// prunes both the service and the date partitions.
// ---------------------------------------------------------------------------

export interface ServiceEnvironmentsOpts {
	serviceName: string
}

export interface ServiceEnvironmentsOutput {
	readonly environment: string
}

export function serviceEnvironmentsQuery(opts: ServiceEnvironmentsOpts) {
	return from(ServiceOverviewSpans)
		.select(($) => ({
			environment: $.DeploymentEnv,
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			$.DeploymentEnv.neq(""),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.groupBy("environment")
		.orderBy(["environment", "asc"])
		.limit(100)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Service Apdex time series
// ---------------------------------------------------------------------------

export interface ServiceApdexTimeseriesOpts {
	serviceName: string
	apdexThresholdMs?: number
}

export interface ServiceApdexTimeseriesOutput {
	readonly bucket: string
	readonly totalCount: number
	readonly satisfiedCount: number
	readonly toleratingCount: number
	readonly apdexScore: number
}

export function serviceApdexTimeseriesQuery(opts: ServiceApdexTimeseriesOpts) {
	const thresholdMs = opts.apdexThresholdMs ?? 500

	// Routes through `service_overview_spans` (the entry-point MV) rather than
	// raw `traces`. The MV pre-filters at write time to
	// `SpanKind IN ('Server','Consumer') OR ParentSpanId = ''` — exactly the
	// root-span predicate apdex needs — and pre-extracts `DeploymentEnv` /
	// `CommitSha` from ResourceAttributes. Cuts scan volume by ~20-100x vs.
	// the raw-table path (same pattern `tracesTimeseriesQuery` already uses via
	// `canUseServiceOverviewMv`).
	return from(ServiceOverviewSpans)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			totalCount: CH.count(),
			...apdexExprs($.Duration.div(1000000), thresholdMs, $.StatusCode.eq("Error")),
		}))
		.where(($) => serviceOverviewWhereConditions($, { serviceName: opts.serviceName }))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Service usage
// ---------------------------------------------------------------------------

export interface ServiceUsageOpts {
	serviceName?: string
}

export interface ServiceUsageOutput {
	readonly serviceName: string
	readonly totalLogCount: number
	readonly totalLogSizeBytes: number
	readonly totalTraceCount: number
	readonly totalTraceSizeBytes: number
	readonly totalSumMetricCount: number
	readonly totalSumMetricSizeBytes: number
	readonly totalGaugeMetricCount: number
	readonly totalGaugeMetricSizeBytes: number
	readonly totalHistogramMetricCount: number
	readonly totalHistogramMetricSizeBytes: number
	readonly totalExpHistogramMetricCount: number
	readonly totalExpHistogramMetricSizeBytes: number
	readonly totalSizeBytes: number
}

export function serviceUsageQuery(opts: ServiceUsageOpts) {
	return from(ServiceUsage)
		.select(($) => ({
			serviceName: $.ServiceName,
			totalLogCount: CH.sum($.LogCount),
			totalLogSizeBytes: CH.sum($.LogSizeBytes),
			totalTraceCount: CH.sum($.TraceCount),
			totalTraceSizeBytes: CH.sum($.TraceSizeBytes),
			totalSumMetricCount: CH.sum($.SumMetricCount),
			totalSumMetricSizeBytes: CH.sum($.SumMetricSizeBytes),
			totalGaugeMetricCount: CH.sum($.GaugeMetricCount),
			totalGaugeMetricSizeBytes: CH.sum($.GaugeMetricSizeBytes),
			totalHistogramMetricCount: CH.sum($.HistogramMetricCount),
			totalHistogramMetricSizeBytes: CH.sum($.HistogramMetricSizeBytes),
			totalExpHistogramMetricCount: CH.sum($.ExpHistogramMetricCount),
			totalExpHistogramMetricSizeBytes: CH.sum($.ExpHistogramMetricSizeBytes),
			totalSizeBytes: CH.sum($.LogSizeBytes)
				.add(CH.sum($.TraceSizeBytes))
				.add(CH.sum($.SumMetricSizeBytes))
				.add(CH.sum($.GaugeMetricSizeBytes))
				.add(CH.sum($.HistogramMetricSizeBytes))
				.add(CH.sum($.ExpHistogramMetricSizeBytes)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			// `service_usage` is keyed on top-of-hour `Hour`. Comparing to the raw
			// `startTime` / `endTime` literals misses every sub-hour window — e.g.
			// "last 15 min" at 22:23–22:38 returns no rows because `Hour=22:00 <
			// 22:23`. Snap both bounds to their hour floor so any hour overlapping
			// the requested window contributes. The cards over-report toward the
			// edges (they show the full enclosing hour, not just the partial
			// window) which is the only sensible answer when the MV is hourly.
			$.Hour.gte(CH.toStartOfHour(CH.toDateTime(param.dateTime("startTime")))),
			$.Hour.lte(CH.toStartOfHour(CH.toDateTime(param.dateTime("endTime")))),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		])
		.groupBy("serviceName")
		.orderBy(["totalSizeBytes", "desc"])
		.format("JSON")
}

export interface ServiceUsageWithPreviousOutput extends ServiceUsageOutput {
	readonly previousLogCount: number
	readonly previousTraceCount: number
	readonly previousSumMetricCount: number
	readonly previousGaugeMetricCount: number
	readonly previousHistogramMetricCount: number
	readonly previousExpHistogramMetricCount: number
	readonly previousSizeBytes: number
}

/**
 * Single-scan variant of {@link serviceUsageQuery} that also returns each
 * service's totals for a previous comparison window. Scans the union span
 * [previousStartTime, endTime] once and splits it with `sumIf`, replacing the
 * two separate per-period requests the usage cards used to fire. `total*`
 * columns keep their current-window meaning (snap-to-hour, see
 * `serviceUsageQuery`); `previous*` columns carry only the aggregate counts the
 * delta chips consume.
 */
export function serviceUsageWithPreviousQuery(opts: ServiceUsageOpts) {
	const hourFloor = (p: string) => CH.toStartOfHour(CH.toDateTime(param.dateTime(p)))
	const inCurrent = ($: ColumnAccessor<typeof ServiceUsage.columns>) =>
		$.Hour.gte(hourFloor("startTime")).and($.Hour.lte(hourFloor("endTime")))
	const inPrevious = ($: ColumnAccessor<typeof ServiceUsage.columns>) =>
		$.Hour.gte(hourFloor("previousStartTime")).and($.Hour.lte(hourFloor("previousEndTime")))

	return from(ServiceUsage)
		.select(($) => ({
			serviceName: $.ServiceName,
			totalLogCount: CH.sumIf($.LogCount, inCurrent($)),
			totalLogSizeBytes: CH.sumIf($.LogSizeBytes, inCurrent($)),
			totalTraceCount: CH.sumIf($.TraceCount, inCurrent($)),
			totalTraceSizeBytes: CH.sumIf($.TraceSizeBytes, inCurrent($)),
			totalSumMetricCount: CH.sumIf($.SumMetricCount, inCurrent($)),
			totalSumMetricSizeBytes: CH.sumIf($.SumMetricSizeBytes, inCurrent($)),
			totalGaugeMetricCount: CH.sumIf($.GaugeMetricCount, inCurrent($)),
			totalGaugeMetricSizeBytes: CH.sumIf($.GaugeMetricSizeBytes, inCurrent($)),
			totalHistogramMetricCount: CH.sumIf($.HistogramMetricCount, inCurrent($)),
			totalHistogramMetricSizeBytes: CH.sumIf($.HistogramMetricSizeBytes, inCurrent($)),
			totalExpHistogramMetricCount: CH.sumIf($.ExpHistogramMetricCount, inCurrent($)),
			totalExpHistogramMetricSizeBytes: CH.sumIf($.ExpHistogramMetricSizeBytes, inCurrent($)),
			totalSizeBytes: CH.sumIf($.LogSizeBytes, inCurrent($))
				.add(CH.sumIf($.TraceSizeBytes, inCurrent($)))
				.add(CH.sumIf($.SumMetricSizeBytes, inCurrent($)))
				.add(CH.sumIf($.GaugeMetricSizeBytes, inCurrent($)))
				.add(CH.sumIf($.HistogramMetricSizeBytes, inCurrent($)))
				.add(CH.sumIf($.ExpHistogramMetricSizeBytes, inCurrent($))),
			previousLogCount: CH.sumIf($.LogCount, inPrevious($)),
			previousTraceCount: CH.sumIf($.TraceCount, inPrevious($)),
			previousSumMetricCount: CH.sumIf($.SumMetricCount, inPrevious($)),
			previousGaugeMetricCount: CH.sumIf($.GaugeMetricCount, inPrevious($)),
			previousHistogramMetricCount: CH.sumIf($.HistogramMetricCount, inPrevious($)),
			previousExpHistogramMetricCount: CH.sumIf($.ExpHistogramMetricCount, inPrevious($)),
			previousSizeBytes: CH.sumIf($.LogSizeBytes, inPrevious($))
				.add(CH.sumIf($.TraceSizeBytes, inPrevious($)))
				.add(CH.sumIf($.SumMetricSizeBytes, inPrevious($)))
				.add(CH.sumIf($.GaugeMetricSizeBytes, inPrevious($)))
				.add(CH.sumIf($.HistogramMetricSizeBytes, inPrevious($)))
				.add(CH.sumIf($.ExpHistogramMetricSizeBytes, inPrevious($))),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			// Scan the union window [previousStartTime, endTime] once; sumIf splits
			// it into the two periods. Hour-floored bounds match serviceUsageQuery.
			$.Hour.gte(hourFloor("previousStartTime")),
			$.Hour.lte(hourFloor("endTime")),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		])
		.groupBy("serviceName")
		.orderBy(["totalSizeBytes", "desc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Services facets (UNION ALL — environment + commit_sha facets)
// ---------------------------------------------------------------------------

export interface ServicesFacetsOutput {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

// NOTE: kept as a 4-way UNION ALL on purpose. A single-scan rewrite (ARRAY JOIN
// of (facetType, value) pairs, or GROUP BY GROUPING SETS) reads ~3× fewer rows
// but benchmarked 2–4× SLOWER in wall-clock on the deployed warehouse: ClickHouse
// runs the UNION branches in parallel and each is a cheap LowCardinality GROUP BY,
// whereas the array/tuple/lambda CPU + row replication of the single-scan forms
// dominates. The I/O saving doesn't translate to latency here.
export function servicesFacetsQuery(): CHUnionQuery<ServicesFacetsOutput> {
	const baseWhere = (
		$: ColumnAccessor<typeof ServiceOverviewSpans.columns>,
	): Array<CH.Condition | undefined> => [
		$.OrgId.eq(param.string("orgId")),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
	]

	const envQuery = from(ServiceOverviewSpans)
		.select(($) => ({
			name: $.DeploymentEnv,
			count: CH.count(),
			facetType: CH.lit("environment"),
		}))
		.where(($) => [...baseWhere($), $.DeploymentEnv.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)

	const namespaceQuery = from(ServiceOverviewSpans)
		.select(($) => ({
			name: $.ServiceNamespace,
			count: CH.count(),
			facetType: CH.lit("namespace"),
		}))
		.where(($) => [...baseWhere($), $.ServiceNamespace.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)

	const commitQuery = from(ServiceOverviewSpans)
		.select(($) => ({
			name: $.CommitSha,
			count: CH.count(),
			facetType: CH.lit("commit_sha"),
		}))
		.where(($) => [...baseWhere($), $.CommitSha.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)

	const serviceQuery = from(ServiceOverviewSpans)
		.select(($) => ({
			name: $.ServiceName,
			count: CH.count(),
			facetType: CH.lit("service"),
		}))
		.where(($) => [...baseWhere($), $.ServiceName.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)

	return unionAll(envQuery, namespaceQuery, commitQuery, serviceQuery).format("JSON")
}

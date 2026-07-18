// ---------------------------------------------------------------------------
// Typed Logs Queries
//
// DSL-based query definitions for logs timeseries and breakdown.
// ---------------------------------------------------------------------------

import { compileCH, compileFnCall } from "@maple-dev/clickhouse-builder"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from, fromUnion, type CHQuery, type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import type { ColumnDefs } from "@maple-dev/clickhouse-builder/types"
import * as T from "@maple-dev/clickhouse-builder/types"
import { unionAll, type CHUnionQuery } from "@maple-dev/clickhouse-builder"
import { Logs, LogsAggregatesHourly } from "../tables"
import { finalizeTimeseries } from "./series-cap"

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

interface LogsQueryOpts {
	serviceName?: string
	severity?: string
	traceId?: string
	spanId?: string
	search?: string
	environments?: readonly string[]
	namespaces?: readonly string[]
	matchModes?: {
		deploymentEnv?: "contains"
		serviceNamespace?: "contains"
	}
}

/** Stable identity for log records that do not carry a native OTel record ID. */
const logRecordIdentity = ($: ColumnAccessor<typeof Logs.columns>): CH.Expr<string> => {
	const record = compileFnCall<readonly unknown[]>(
		"tuple",
		$.Timestamp,
		$.TraceId,
		$.SpanId,
		$.TraceFlags,
		$.SeverityText,
		$.SeverityNumber,
		$.ServiceName,
		$.Body,
		$.ResourceSchemaUrl,
		$.ResourceAttributes,
		$.ScopeSchemaUrl,
		$.ScopeName,
		$.ScopeVersion,
		$.ScopeAttributes,
		$.LogAttributes,
	)
	return compileFnCall<string>("hex", compileFnCall<unknown>("MD5", CH.toJSONString(record)))
}

function environmentCondition(
	$: ColumnAccessor<typeof Logs.columns>,
	opts: LogsQueryOpts,
): CH.Condition | undefined {
	if (!opts.environments?.length) return undefined
	const envAttr = $.ResourceAttributes.get("deployment.environment")
	if (opts.matchModes?.deploymentEnv === "contains" && opts.environments.length === 1) {
		return CH.positionCaseInsensitive(envAttr, CH.lit(opts.environments[0]!)).gt(0)
	}
	return CH.inList(envAttr, opts.environments)
}

function namespaceCondition(
	$: ColumnAccessor<typeof Logs.columns>,
	opts: LogsQueryOpts,
): CH.Condition | undefined {
	if (!opts.namespaces?.length) return undefined
	const nsAttr = $.ResourceAttributes.get("service.namespace")
	if (opts.matchModes?.serviceNamespace === "contains" && opts.namespaces.length === 1) {
		return CH.positionCaseInsensitive(nsAttr, CH.lit(opts.namespaces[0]!)).gt(0)
	}
	return CH.inList(nsAttr, opts.namespaces)
}

const START_DT = "toDateTime(__PARAM_startTime__)"
const END_DT = "toDateTime(__PARAM_endTime__)"
const START_HOUR = `toStartOfHour(${START_DT})`
const END_HOUR = `toStartOfHour(${END_DT})`
const FIRST_FULL_HOUR = `if(${START_DT} = ${START_HOUR}, ${START_HOUR}, ${START_HOUR} + INTERVAL 1 HOUR)`

function rawLogsTimeRange($: ColumnAccessor<typeof Logs.columns>): Array<CH.Condition | undefined> {
	return [
		// TimestampTime is the partition/index key; this filter unlocks
		// partition pruning. Timestamp filter retained for sub-second accuracy.
		$.TimestampTime.gte(param.dateTime("startTime")),
		$.TimestampTime.lte(param.dateTime("endTime")),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
	]
}

function rawLogEdgeCondition(): CH.Condition {
	return CH.rawCond(`(TimestampTime < ${FIRST_FULL_HOUR} OR TimestampTime >= ${END_HOUR})`)
}

function canUseLogsAggregateInterior(opts: LogsQueryOpts): boolean {
	if (opts.traceId) return false
	if (opts.spanId) return false
	if (opts.search) return false
	if (opts.matchModes?.deploymentEnv === "contains") return false
	if (opts.matchModes?.serviceNamespace === "contains") return false
	return true
}

// ---------------------------------------------------------------------------
// Timeseries query
// ---------------------------------------------------------------------------

export interface LogsTimeseriesOpts extends LogsQueryOpts {
	groupBy?: readonly string[]
	/**
	 * Bucket size in seconds, supplied here so the query builder can route to
	 * `logs_aggregates_hourly` when the bucket is hour-aligned. Optional: when
	 * absent (or sub-hour), the raw `logs` table is used.
	 */
	bucketSeconds?: number
	/**
	 * Opt-in top-N series cap for group-by charts. When set, only the N groups
	 * with the largest total count (across all buckets) are fetched.
	 */
	seriesLimit?: number
}

export interface LogsTimeseriesOutput {
	readonly bucket: string
	readonly groupName: string
	readonly count: number
}

// Synthetic column defs matching LogsTimeseriesOutput, used to wrap the inner
// query in a CTE when the top-N series cap is applied.
const LOGS_TS_COLUMNS: ColumnDefs = {
	bucket: T.string,
	groupName: T.string,
	count: T.float64,
}

/**
 * Predicate for routing to the pre-aggregated hourly MV.
 *
 * The MV stores per-hour buckets keyed by (OrgId, Hour, ServiceName,
 * SeverityText, DeploymentEnv). It cannot answer queries that need raw row
 * lookups (traceId, full-text search on Body) or sub-hour granularity, but for
 * the dashboard log-volume chart at 1h+ ranges it cuts scan volume by orders
 * of magnitude.
 */
export function canUseLogsAggregatesHourly(
	opts: LogsTimeseriesOpts,
	bucketSeconds: number | undefined,
): boolean {
	if (bucketSeconds === undefined || bucketSeconds < 3600 || bucketSeconds % 3600 !== 0) {
		return false
	}
	if (opts.traceId) return false
	if (opts.search) return false
	// MV stores DeploymentEnv / ServiceNamespace as top-level columns; the
	// `contains` substring match is only supported via positionCaseInsensitive on
	// the raw map column.
	if (opts.matchModes?.deploymentEnv === "contains") return false
	if (opts.matchModes?.serviceNamespace === "contains") return false
	return true
}

function mvEnvironmentCondition(
	$: ColumnAccessor<typeof LogsAggregatesHourly.columns>,
	opts: LogsQueryOpts,
): CH.Condition | undefined {
	if (!opts.environments?.length) return undefined
	return CH.inList($.DeploymentEnv, opts.environments)
}

function mvNamespaceCondition(
	$: ColumnAccessor<typeof LogsAggregatesHourly.columns>,
	opts: LogsQueryOpts,
): CH.Condition | undefined {
	if (!opts.namespaces?.length) return undefined
	return CH.inList($.ServiceNamespace, opts.namespaces)
}

export function logsTimeseriesQuery(opts: LogsTimeseriesOpts): CHQuery<ColumnDefs, LogsTimeseriesOutput, {}> {
	const groupByService = opts.groupBy?.includes("service")
	const groupBySeverity = opts.groupBy?.includes("severity")

	if (canUseLogsAggregatesHourly(opts, opts.bucketSeconds)) {
		// MV path: read pre-aggregated hourly buckets. The upper bound is
		// `Hour < toStartOfHour(endTime)` so a partial trailing hour (whose full
		// hour-bucket on the MV would otherwise overcount vs. raw's
		// `Timestamp <= endTime`) is excluded. The leading partial hour is
		// already trimmed downstream by `firstFullBucketIso` /
		// `trimSparseLeadingBuckets`, keeping behavior symmetric across edges.
		const mv = from(LogsAggregatesHourly)
			.select(($) => ({
				bucket: CH.toStartOfInterval($.Hour, param.int("bucketSeconds")),
				groupName: buildLogsGroupNameExpr($, groupByService, groupBySeverity),
				count: CH.sum($.Count),
			}))
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				$.Hour.gte(param.dateTime("startTime")),
				// `param.dateTime("endTime")` substitutes as a quoted string literal;
				// `toStartOfHour` only accepts Date/DateTime, so wrap with `toDateTime`.
				$.Hour.lt(CH.toStartOfHour(CH.toDateTime(param.dateTime("endTime")))),
				CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
				CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
				mvEnvironmentCondition($, opts),
				mvNamespaceCondition($, opts),
			])
			.groupBy("bucket", "groupName")
			.orderBy(["bucket", "asc"], ["groupName", "asc"])
		return finalizeTimeseries(mv, LOGS_TS_COLUMNS, "count", opts) as unknown as CHQuery<
			ColumnDefs,
			LogsTimeseriesOutput,
			{}
		>
	}

	const raw = from(Logs)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			groupName: buildLogsGroupNameExpr($, groupByService, groupBySeverity),
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			// TimestampTime is the partition/index key; this filter unlocks
			// partition pruning. Timestamp filter retained for sub-second accuracy.
			$.TimestampTime.gte(param.dateTime("startTime")),
			$.TimestampTime.lte(param.dateTime("endTime")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
			environmentCondition($, opts),
			namespaceCondition($, opts),
		])
		.groupBy("bucket", "groupName")
		.orderBy(["bucket", "asc"], ["groupName", "asc"])
	return finalizeTimeseries(raw, LOGS_TS_COLUMNS, "count", opts) as unknown as CHQuery<
		ColumnDefs,
		LogsTimeseriesOutput,
		{}
	>
}

function buildLogsGroupNameExpr(
	$: { ServiceName: CH.Expr<string>; SeverityText: CH.Expr<string> },
	groupByService?: boolean,
	groupBySeverity?: boolean,
): CH.Expr<string> {
	if (!groupByService && !groupBySeverity) {
		return CH.lit("all")
	}

	const parts: CH.Expr<string>[] = []
	if (groupByService) parts.push(CH.toString_($.ServiceName))
	if (groupBySeverity) parts.push(CH.toString_($.SeverityText))

	if (parts.length === 1) {
		return CH.coalesce(CH.nullIf(parts[0]!, ""), CH.lit("all"))
	}

	// Multi-part: filter empty strings before joining with separator
	const filtered = CH.arrayFilter("x -> x != ''", CH.arrayOf(...parts))
	return CH.coalesce(CH.nullIf(CH.arrayStringConcat(filtered, " \u00b7 "), ""), CH.lit("all"))
}

// ---------------------------------------------------------------------------
// Breakdown query
// ---------------------------------------------------------------------------

export interface LogsBreakdownOpts extends LogsQueryOpts {
	groupBy: "service" | "severity"
	limit?: number
}

export interface LogsBreakdownOutput {
	readonly name: string
	readonly count: number
}

function logsBreakdownName(
	$: { ServiceName: CH.Expr<string>; SeverityText: CH.Expr<string> },
	groupBy: LogsBreakdownOpts["groupBy"],
): CH.Expr<string> {
	return groupBy === "severity" ? $.SeverityText : $.ServiceName
}

export function logsBreakdownQuery(opts: LogsBreakdownOpts): CHQuery<ColumnDefs, LogsBreakdownOutput, {}> {
	if (!canUseLogsAggregateInterior(opts)) {
		const raw = from(Logs)
			.select(($) => ({
				name: logsBreakdownName($, opts.groupBy),
				count: CH.count(),
			}))
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				...rawLogsTimeRange($),
				CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
				CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
				environmentCondition($, opts),
				namespaceCondition($, opts),
			])
			.groupBy("name")
			.orderBy(["count", "desc"])
			.limit(opts.limit ?? 10)
			.format("JSON")
		return raw as unknown as CHQuery<ColumnDefs, LogsBreakdownOutput, {}>
	}

	const rawEdges = from(Logs)
		.select(($) => ({
			name: logsBreakdownName($, opts.groupBy),
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			...rawLogsTimeRange($),
			rawLogEdgeCondition(),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
			environmentCondition($, opts),
			namespaceCondition($, opts),
		])
		.groupBy("name")

	const mvInterior = from(LogsAggregatesHourly)
		.select(($) => ({
			name: logsBreakdownName($, opts.groupBy),
			count: CH.sum($.Count),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(CH.rawExpr<string>(FIRST_FULL_HOUR)),
			$.Hour.lt(CH.rawExpr<string>(END_HOUR)),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
			mvEnvironmentCondition($, opts),
			mvNamespaceCondition($, opts),
		])
		.groupBy("name")

	const combined = fromUnion(unionAll(rawEdges, mvInterior), "breakdown")
		.select(($) => ({
			name: $.name,
			count: CH.sum($.count),
		}))
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(opts.limit ?? 10)
		.format("JSON")
	return combined as unknown as CHQuery<ColumnDefs, LogsBreakdownOutput, {}>
}

// ---------------------------------------------------------------------------
// Count query
// ---------------------------------------------------------------------------

export interface LogsCountOutput {
	readonly total: number
}

export function logsCountQuery(opts: LogsQueryOpts): CHQuery<ColumnDefs, LogsCountOutput, {}> {
	if (!canUseLogsAggregateInterior(opts)) {
		const raw = from(Logs)
			.select(() => ({
				total: CH.count(),
			}))
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				...rawLogsTimeRange($),
				CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
				CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
				CH.when(opts.traceId, (v: string) => $.TraceId.eq(v)),
				CH.when(opts.spanId, (v: string) => $.SpanId.eq(v)),
				CH.when(opts.search, (v: string) => $.Body.ilike(`%${v}%`)),
				environmentCondition($, opts),
				namespaceCondition($, opts),
			])
			.format("JSON")
		return raw as unknown as CHQuery<ColumnDefs, LogsCountOutput, {}>
	}

	const rawEdges = from(Logs)
		.select(() => ({
			total: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			...rawLogsTimeRange($),
			rawLogEdgeCondition(),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
			environmentCondition($, opts),
			namespaceCondition($, opts),
		])

	const mvInterior = from(LogsAggregatesHourly)
		.select(($) => ({
			total: CH.sum($.Count),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(CH.rawExpr<string>(FIRST_FULL_HOUR)),
			$.Hour.lt(CH.rawExpr<string>(END_HOUR)),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
			mvEnvironmentCondition($, opts),
			mvNamespaceCondition($, opts),
		])

	const combined = fromUnion(unionAll(rawEdges, mvInterior), "counts")
		.select(($) => ({
			total: CH.sum($.total),
		}))
		.format("JSON")
	return combined as unknown as CHQuery<ColumnDefs, LogsCountOutput, {}>
}

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

export interface LogsListOpts extends LogsQueryOpts {
	minSeverity?: number
	cursor?: string
	limit?: number
	offset?: number
	cursorIdentity?: {
		timestamp: string
		serviceName: string
		traceId: string
		spanId: string
		recordIdentity: string
	}
}

export interface LogsListOutput {
	readonly timestamp: string
	readonly severityText: string
	readonly severityNumber: number
	readonly serviceName: string
	readonly body: string
	readonly traceId: string
	readonly spanId: string
	readonly recordIdentity: string
	readonly logAttributes: string
	readonly resourceAttributes: string
}

/**
 * Two-stage list query. The `logs` sort key is
 * `(OrgId, ServiceName, TimestampTime, Timestamp)` — `ServiceName` sits between
 * `OrgId` and the timestamps, so `ORDER BY Timestamp DESC` is not a sort-key
 * prefix and ClickHouse cannot read-in-order. A single-stage query therefore
 * scans the whole window and materializes the heavy `Body` / attribute-map
 * columns for every matching row *before* `LIMIT` discards all but N, which
 * OOMs on busy orgs.
 *
 * Stage 1 reads only `Timestamp` to find the cutoff (the Nth-newest matching
 * timestamp). Stage 2 gates on `Timestamp >= cutoff`, so the heavy columns are
 * materialized only for the small slice of rows at/after the cutoff. The outer
 * `LIMIT` trims any ties at the cutoff timestamp.
 */
export function logsListQuery(opts: LogsListOpts) {
	const limit = opts.limit ?? 50
	const offset = opts.offset ?? 0

	const baseWhere = ($: ColumnAccessor<typeof Logs.columns>): Array<CH.Condition | undefined> => [
		$.OrgId.eq(param.string("orgId")),
		$.TimestampTime.gte(param.dateTime("startTime")),
		$.TimestampTime.lte(param.dateTime("endTime")),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
		CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
		CH.when(opts.minSeverity, (v: number) => $.SeverityNumber.gte(v)),
		CH.when(opts.traceId, (v: string) => $.TraceId.eq(v)),
		CH.when(opts.spanId, (v: string) => $.SpanId.eq(v)),
		CH.when(opts.cursor, (v: string) => $.Timestamp.lt(v)),
		opts.cursorIdentity
			? $.Timestamp.lt(opts.cursorIdentity.timestamp).or(
					$.Timestamp.eq(opts.cursorIdentity.timestamp).and(
						$.ServiceName.gt(opts.cursorIdentity.serviceName).or(
							$.ServiceName.eq(opts.cursorIdentity.serviceName).and(
								$.TraceId.gt(opts.cursorIdentity.traceId).or(
								$.TraceId.eq(opts.cursorIdentity.traceId).and(
									$.SpanId.gt(opts.cursorIdentity.spanId).or(
										$.SpanId.eq(opts.cursorIdentity.spanId).and(
											logRecordIdentity($).gt(opts.cursorIdentity.recordIdentity),
										),
									),
								),
								),
							),
						),
					),
				)
			: undefined,
		CH.when(opts.search, (v: string) => $.Body.ilike(`%${v}%`)),
		environmentCondition($, opts),
		namespaceCondition($, opts),
	]

	// Stage 1: cheap scan — only `Timestamp` is read. Compiled with placeholders
	// intact ({} params) so the outer `CH.compile()` substitutes them once.
	const cutoffInner = from(Logs)
		.select(($) => ({ ts: $.Timestamp }))
		.where(baseWhere)
		.orderBy(["ts", "desc"])
		.limit(limit + offset)
	const cutoffSql = compileCH(cutoffInner, {}, { skipFormat: true }).sql
	const cutoff = CH.rawExpr<string>(`(SELECT min(ts) FROM (${cutoffSql}))`)

	// Stage 2: heavy columns read only for rows at/after the cutoff timestamp.
	let query = from(Logs)
		.select(($) => ({
			timestamp: $.Timestamp,
			severityText: $.SeverityText,
			severityNumber: $.SeverityNumber,
			serviceName: $.ServiceName,
			body: $.Body,
			traceId: $.TraceId,
			spanId: $.SpanId,
			recordIdentity: logRecordIdentity($),
			logAttributes: CH.toJSONString($.LogAttributes),
			resourceAttributes: CH.toJSONString($.ResourceAttributes),
		}))
		.where(($) => [...baseWhere($), $.Timestamp.gte(cutoff)])
		.orderBy(
			["timestamp", "desc"],
			["serviceName", "asc"],
			["traceId", "asc"],
			["spanId", "asc"],
			["recordIdentity", "asc"],
		)
		.limit(limit)
		.format("JSON")

	if (offset > 0) query = query.offset(offset)
	return query
}

// ---------------------------------------------------------------------------
// Single log lookup (exact-match by composite key)
//
// Logs have no native primary id; the public identity combines the indexed
// timestamp with a deterministic hash of the complete stored record. Used by
// the shareable `/logs/$logId` detail page.
// ---------------------------------------------------------------------------

export interface LogByKeyOpts {
	serviceName?: string
	traceId?: string
	spanId?: string
	recordIdentity?: string
}

export function getLogByKeyQuery(opts: LogByKeyOpts) {
	return from(Logs)
		.select(($) => ({
			timestamp: $.Timestamp,
			severityText: $.SeverityText,
			severityNumber: $.SeverityNumber,
			serviceName: $.ServiceName,
			body: $.Body,
			traceId: $.TraceId,
			spanId: $.SpanId,
			recordIdentity: logRecordIdentity($),
			logAttributes: CH.toJSONString($.LogAttributes),
			resourceAttributes: CH.toJSONString($.ResourceAttributes),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			// TimestampTime is the partition/index key; bounding it unlocks
			// partition pruning. Timestamp.eq pins the exact sub-second row.
			$.TimestampTime.gte(param.dateTime("startTime")),
			$.TimestampTime.lte(param.dateTime("endTime")),
			$.Timestamp.eq(param.dateTime("timestamp")),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			CH.when(opts.traceId, (v: string) => $.TraceId.eq(v)),
			CH.when(opts.spanId, (v: string) => $.SpanId.eq(v)),
			CH.when(opts.recordIdentity, (v: string) => logRecordIdentity($).eq(v)),
		])
		.limit(1)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Error rate by service
// ---------------------------------------------------------------------------

export interface ErrorRateByServiceOutput {
	readonly serviceName: string
	readonly totalLogs: number
	readonly errorLogs: number
	readonly errorRate: number
}

export function errorRateByServiceQuery() {
	const rawEdges = from(Logs)
		.select(($) => ({
			serviceName: $.ServiceName,
			bucketTotalLogs: CH.count(),
			bucketErrorLogs: CH.countIf(CH.inList($.SeverityText, ["ERROR", "FATAL"])),
			errorRate: CH.lit(0),
		}))
		.where(($) => [$.OrgId.eq(param.string("orgId")), ...rawLogsTimeRange($), rawLogEdgeCondition()])
		.groupBy("serviceName")

	const mvInterior = from(LogsAggregatesHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			bucketTotalLogs: CH.sum($.Count),
			bucketErrorLogs: CH.sumIf($.Count, CH.inList($.SeverityText, ["ERROR", "FATAL"])),
			errorRate: CH.lit(0),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(CH.rawExpr<string>(FIRST_FULL_HOUR)),
			$.Hour.lt(CH.rawExpr<string>(END_HOUR)),
		])
		.groupBy("serviceName")

	return fromUnion(unionAll(rawEdges, mvInterior), "rates")
		.select(($) => ({
			serviceName: $.serviceName,
			totalLogs: CH.sum($.bucketTotalLogs),
			errorLogs: CH.sum($.bucketErrorLogs),
			errorRate: CH.round_(CH.sum($.bucketErrorLogs).div(CH.sum($.bucketTotalLogs)), 6),
		}))
		.groupBy("serviceName")
		.orderBy(["errorRate", "desc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Logs facets (UNION ALL — severity + service facets)
// ---------------------------------------------------------------------------

export interface LogsFacetsOutput {
	readonly severityText: string
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly namespace: string
	readonly count: number
	readonly facetType: string
}

export type LogsFacetDimension = "severity" | "service" | "deploymentEnv" | "namespace"

export function logsFacetsQuery(
	opts: LogsQueryOpts,
	facet?: LogsFacetDimension,
): CHUnionQuery<LogsFacetsOutput> {
	// Facets only filter on dimensions the hourly MV carries (service, severity,
	// deployment env), so route to `logs_aggregates_hourly` and collapse three
	// full raw-`logs` scans into three cheap pre-aggregated reads. The lone
	// exception is the `contains` env match mode, which needs a substring scan on
	// the raw map column — fall back to raw `logs` there (mirrors the
	// `canUseLogsAggregatesHourly` guard used by the timeseries query).
	if (opts.matchModes?.deploymentEnv === "contains" || opts.matchModes?.serviceNamespace === "contains") {
		return logsFacetsQueryFromRaw(opts, facet)
	}
	return logsFacetsQueryFromMv(opts, facet)
}

function logsFacetsQueryFromMv(
	opts: LogsQueryOpts,
	facet?: LogsFacetDimension,
): CHUnionQuery<LogsFacetsOutput> {
	const baseWhere = (
		$: ColumnAccessor<typeof LogsAggregatesHourly.columns>,
	): Array<CH.Condition | undefined> => [
		$.OrgId.eq(param.string("orgId")),
		$.Hour.gte(param.dateTime("startTime")),
		$.Hour.lte(param.dateTime("endTime")),
		CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
		opts.environments?.length ? CH.inList($.DeploymentEnv, opts.environments) : undefined,
		mvNamespaceCondition($, opts),
	]

	const severityQuery = from(LogsAggregatesHourly)
		.select(($) => ({
			severityText: $.SeverityText,
			serviceName: CH.lit(""),
			deploymentEnv: CH.lit(""),
			namespace: CH.lit(""),
			count: CH.sum($.Count),
			facetType: CH.lit("severity"),
		}))
		.where(baseWhere)
		.groupBy("severityText")

	const serviceQuery = from(LogsAggregatesHourly)
		.select(($) => ({
			severityText: CH.lit(""),
			serviceName: $.ServiceName,
			deploymentEnv: CH.lit(""),
			namespace: CH.lit(""),
			count: CH.sum($.Count),
			facetType: CH.lit("service"),
		}))
		.where(baseWhere)
		.groupBy("serviceName")

	const envQuery = from(LogsAggregatesHourly)
		.select(($) => ({
			severityText: CH.lit(""),
			serviceName: CH.lit(""),
			deploymentEnv: $.DeploymentEnv,
			namespace: CH.lit(""),
			count: CH.sum($.Count),
			facetType: CH.lit("deploymentEnv"),
		}))
		.where(($) => [...baseWhere($), $.DeploymentEnv.neq("")])
		.groupBy("deploymentEnv")

	const namespaceQuery = from(LogsAggregatesHourly)
		.select(($) => ({
			severityText: CH.lit(""),
			serviceName: CH.lit(""),
			deploymentEnv: CH.lit(""),
			namespace: $.ServiceNamespace,
			count: CH.sum($.Count),
			facetType: CH.lit("namespace"),
		}))
		.where(($) => [...baseWhere($), $.ServiceNamespace.neq("")])
		.groupBy("namespace")

	const byFacet = {
		severity: severityQuery,
		service: serviceQuery,
		deploymentEnv: envQuery,
		namespace: namespaceQuery,
	}
	const branches = facet ? [byFacet[facet]] : [severityQuery, serviceQuery, envQuery, namespaceQuery]
	return unionAll(...branches)
		.orderBy(["count", "desc"])
		.limit(500)
		.format("JSON")
}

function logsFacetsQueryFromRaw(
	opts: LogsQueryOpts,
	facet?: LogsFacetDimension,
): CHUnionQuery<LogsFacetsOutput> {
	const baseWhere = ($: ColumnAccessor<typeof Logs.columns>): Array<CH.Condition | undefined> => [
		$.OrgId.eq(param.string("orgId")),
		$.TimestampTime.gte(param.dateTime("startTime")),
		$.TimestampTime.lte(param.dateTime("endTime")),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
		CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
		environmentCondition($, opts),
		namespaceCondition($, opts),
	]

	const severityQuery = from(Logs)
		.select(($) => ({
			severityText: $.SeverityText,
			serviceName: CH.lit(""),
			deploymentEnv: CH.lit(""),
			namespace: CH.lit(""),
			count: CH.count(),
			facetType: CH.lit("severity"),
		}))
		.where(baseWhere)
		.groupBy("severityText")

	const serviceQuery = from(Logs)
		.select(($) => ({
			severityText: CH.lit(""),
			serviceName: $.ServiceName,
			deploymentEnv: CH.lit(""),
			namespace: CH.lit(""),
			count: CH.count(),
			facetType: CH.lit("service"),
		}))
		.where(baseWhere)
		.groupBy("serviceName")

	const envQuery = from(Logs)
		.select(($) => ({
			severityText: CH.lit(""),
			serviceName: CH.lit(""),
			deploymentEnv: $.ResourceAttributes.get("deployment.environment"),
			namespace: CH.lit(""),
			count: CH.count(),
			facetType: CH.lit("deploymentEnv"),
		}))
		.where(($) => [...baseWhere($), $.ResourceAttributes.get("deployment.environment").neq("")])
		.groupBy("deploymentEnv")

	const namespaceQuery = from(Logs)
		.select(($) => ({
			severityText: CH.lit(""),
			serviceName: CH.lit(""),
			deploymentEnv: CH.lit(""),
			namespace: $.ResourceAttributes.get("service.namespace"),
			count: CH.count(),
			facetType: CH.lit("namespace"),
		}))
		.where(($) => [...baseWhere($), $.ResourceAttributes.get("service.namespace").neq("")])
		.groupBy("namespace")

	const byFacet = {
		severity: severityQuery,
		service: serviceQuery,
		deploymentEnv: envQuery,
		namespace: namespaceQuery,
	}
	const branches = facet ? [byFacet[facet]] : [severityQuery, serviceQuery, envQuery, namespaceQuery]
	return unionAll(...branches)
		.orderBy(["count", "desc"])
		.limit(500)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Typed Error Queries
//
// DSL-based query definitions for error aggregation and timeseries.
// ---------------------------------------------------------------------------

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from, fromQuery, type CHQuery, type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import type { ColumnDefs } from "@maple-dev/clickhouse-builder/types"
import { unionAll, type CHUnionQuery } from "@maple-dev/clickhouse-builder"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	ErrorEvents,
	ErrorEventsByTime,
	ServiceUsage,
	TraceDetailSpans,
	TraceListMv,
	Traces,
} from "../tables"
import { buildProjectedMapExpr } from "./query-helpers"
import { httpDisplaySpanName } from "../../traces-shared"

function errorEventsTableForRecentScan(opts: {
	fingerprintHashes?: readonly string[]
}): typeof ErrorEvents | typeof ErrorEventsByTime {
	// Fingerprint-filtered lookups align with error_events' key
	// (OrgId, FingerprintHash, Timestamp). Broad recent-window scans align with
	// error_events_by_time's key (OrgId, Timestamp, FingerprintHash).
	return opts.fingerprintHashes?.length ? ErrorEvents : ErrorEventsByTime
}

const fingerprintHashLiteral = (hash: string) => CH.toUInt64(CH.lit(hash))
const fingerprintHashEq = (expr: CH.Expr<number>, hash: string) => expr.eq(fingerprintHashLiteral(hash))
const fingerprintHashIn = (expr: CH.Expr<number>, hashes: readonly string[]) =>
	CH.inExprList(expr, hashes.map(fingerprintHashLiteral))

// ---------------------------------------------------------------------------
// Errors by type
//
// Top Errors groups the canonical `error_events` rows by the ingest-computed
// `FingerprintHash` (the same identity the Issues system uses) and labels them
// with the stored `ErrorLabel`. The error identity is the stable fingerprint
// hash (string), not a query-time heuristic — see materializations.ts /
// fingerprint.ts for how the hash + label are derived.
// ---------------------------------------------------------------------------

export interface ErrorsByTypeOpts {
	rootOnly?: boolean
	services?: readonly string[]
	deploymentEnvs?: readonly string[]
	fingerprintHashes?: readonly string[]
	limit?: number
}

export interface ErrorsByTypeOutput {
	readonly fingerprintHash: string
	readonly errorLabel: string
	readonly sampleMessage: string
	readonly count: number
	readonly affectedServicesCount: number
	readonly firstSeen: string
	readonly lastSeen: string
}

export function errorsByTypeQuery(opts: ErrorsByTypeOpts) {
	return from(errorEventsTableForRecentScan(opts))
		.select(($) => ({
			fingerprintHash: CH.toString_($.FingerprintHash),
			errorLabel: CH.any_($.ErrorLabel),
			sampleMessage: CH.any_($.StatusMessage),
			count: CH.count(),
			affectedServicesCount: CH.uniq($.ServiceName),
			firstSeen: CH.min_($.Timestamp),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
			opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
			opts.deploymentEnvs?.length ? CH.inList($.DeploymentEnv, opts.deploymentEnvs) : undefined,
			opts.fingerprintHashes?.length
				? fingerprintHashIn($.FingerprintHash, opts.fingerprintHashes)
				: undefined,
		])
		.groupBy("fingerprintHash")
		.orderBy(["count", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Errors timeseries
// ---------------------------------------------------------------------------

export interface ErrorsTimeseriesOpts {
	fingerprintHash: string
	services?: readonly string[]
}

export interface ErrorsTimeseriesOutput {
	readonly bucket: string
	readonly count: number
}

export function errorsTimeseriesQuery(opts: ErrorsTimeseriesOpts) {
	return from(ErrorEvents)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			fingerprintHashEq($.FingerprintHash, opts.fingerprintHash),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
		])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Span hierarchy
// ---------------------------------------------------------------------------

/**
 * Span attribute keys the waterfall / timeline / flow views actually read
 * (via `getHttpInfo` + `getCacheInfo`). The hierarchy query projects only
 * these instead of the full `SpanAttributes` map — selecting the full map for
 * every span in a wide trace materializes hundreds of MB of JSON and blows the
 * query memory limit. The full map is loaded lazily per-span by `spanDetailQuery`.
 */
const TREE_SPAN_ATTR_KEYS = [
	"http.method",
	"http.request.method",
	"http.route",
	"url.full",
	"http.url",
	"server.address",
	"net.peer.name",
	"url.path",
	"http.target",
	"http.status_code",
	"http.response.status_code",
	"cache.system",
	"cache.result",
	"cache.name",
	"cache.operation",
	"cache.lookup_performed",
	// Generic OpenTelemetry database-client spans — the `db.system.name` signal
	// (with the legacy `db.system` fallback) lets the trace views detect a DB
	// span and render its summary badge without waiting for the per-span lazy
	// detail fetch. The full `db.*` field set (namespace, operation, rows,
	// server, …) is loaded lazily by `spanDetailQuery` for the detail panel.
	"db.system.name",
	"db.system",
	// Cloudflare Workers Observability — read by `getCloudflareInfo` to mark
	// Worker spans and render the edge-location + outcome badges in the tree
	// views. The full set (ray id, cpu/wall time, script version, geo city) is
	// lazy-loaded per-span by `spanDetailQuery` for the detail panel.
	"cloud.platform",
	"cloudflare.colo",
	"faas.invoked_region",
	"cloudflare.outcome",
] as const

/**
 * Resource attribute keys the trace-detail header reads (deployment env + commit).
 * Everything else in `ResourceAttributes` is loaded lazily by `spanDetailQuery`.
 */
const TREE_RESOURCE_ATTR_KEYS = ["deployment.environment", "deployment.commit_sha"] as const

/**
 * Hard cap on spans returned for one trace. A waterfall with more than a few
 * thousand rows is unrenderable, and pathological traces (hundreds of thousands
 * of spans) otherwise produce a response large enough to stall the API. The cap
 * keeps the earliest spans (ORDER BY StartTime ASC) so the root and its subtree
 * stay connected.
 */
const SPAN_HIERARCHY_MAX_SPANS = 5_000

export interface SpanHierarchyOpts {
	traceId: string
	spanId?: string
	/**
	 * When true, the generated SQL adds `Timestamp BETWEEN startTime AND endTime`
	 * filters using parameter placeholders. Callers must then pass `startTime`
	 * and `endTime` to `compile()`. Without this, ClickHouse cannot prune
	 * partitions and scans the full retention window for the trace ID.
	 */
	narrowByTime?: boolean
}

export interface SpanHierarchyOutput {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly spanName: string
	readonly serviceName: string
	readonly spanKind: string
	readonly durationMs: number
	readonly startTime: string
	readonly statusCode: string
	readonly statusMessage: string
	readonly spanAttributes: string
	readonly resourceAttributes: string
	readonly relationship: string
}

export function spanHierarchyQuery(opts: SpanHierarchyOpts) {
	return (
		from(TraceDetailSpans)
			.select(($) => {
				// HTTP span name rewriting: "http.server GET" + route → "GET /api/users".
				// Shared with the materialized view and the trace-list span-name filter.
				const httpRewriteExpr = httpDisplaySpanName(
					$.SpanName,
					$.SpanAttributes.get("http.route"),
					$.SpanAttributes.get("url.path"),
				)

				const relationshipExpr = opts.spanId
					? CH.if_($.SpanId.eq(opts.spanId), CH.lit("target"), CH.lit("related"))
					: CH.lit("related")

				return {
					traceId: $.TraceId,
					spanId: $.SpanId,
					parentSpanId: $.ParentSpanId,
					spanName: httpRewriteExpr,
					serviceName: $.ServiceName,
					spanKind: $.SpanKind,
					durationMs: $.Duration.div(1000000),
					startTime: $.Timestamp,
					statusCode: $.StatusCode,
					statusMessage: $.StatusMessage,
					// Trimmed maps — only the keys the tree views render. Full maps are
					// fetched per-span on demand via spanDetailQuery.
					spanAttributes: CH.toJSONString(
						buildProjectedMapExpr(TREE_SPAN_ATTR_KEYS, "SpanAttributes"),
					),
					resourceAttributes: CH.toJSONString(
						buildProjectedMapExpr(TREE_RESOURCE_ATTR_KEYS, "ResourceAttributes"),
					),
					relationship: relationshipExpr,
				}
			})
			.where(($) => [
				$.TraceId.eq(opts.traceId),
				$.OrgId.eq(param.string("orgId")),
				CH.whenTrue(!!opts.narrowByTime, () => $.Timestamp.gte(param.dateTime("startTime"))),
				CH.whenTrue(!!opts.narrowByTime, () => $.Timestamp.lte(param.dateTime("endTime"))),
			])
			// ORDER BY + LIMIT bounds pathological traces — the earliest spans keep
			// the root subtree connected. buildSpanTree (web) re-sorts children anyway.
			.orderBy(["startTime", "asc"])
			.limit(SPAN_HIERARCHY_MAX_SPANS)
			.format("JSON")
	)
}

// ---------------------------------------------------------------------------
// Span detail — full attributes for a single span
// ---------------------------------------------------------------------------

export interface SpanDetailOpts {
	traceId: string
	spanId: string
	/**
	 * When true, adds `Timestamp BETWEEN startTime AND endTime` filters so
	 * ClickHouse can prune partitions. Callers must then pass `startTime` /
	 * `endTime` to `compile()`.
	 */
	narrowByTime?: boolean
}

export interface SpanDetailOutput {
	readonly traceId: string
	readonly spanId: string
	readonly spanAttributes: string
	readonly resourceAttributes: string
}

/**
 * Point lookup for one span's full attribute maps. The sorting key
 * `(OrgId, TraceId, SpanId)` makes this an O(log N) lookup. Used by the trace
 * detail panel to lazily load the attributes the trimmed `spanHierarchyQuery`
 * intentionally omits.
 */
export function spanDetailQuery(opts: SpanDetailOpts) {
	return from(TraceDetailSpans)
		.select(($) => ({
			traceId: $.TraceId,
			spanId: $.SpanId,
			spanAttributes: CH.toJSONString($.SpanAttributes),
			resourceAttributes: CH.toJSONString($.ResourceAttributes),
		}))
		.where(($) => [
			$.TraceId.eq(opts.traceId),
			$.SpanId.eq(opts.spanId),
			$.OrgId.eq(param.string("orgId")),
			CH.whenTrue(!!opts.narrowByTime, () => $.Timestamp.gte(param.dateTime("startTime"))),
			CH.whenTrue(!!opts.narrowByTime, () => $.Timestamp.lte(param.dateTime("endTime"))),
		])
		.limit(1)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Trace timestamp probe — resolve any one span timestamp for a trace
// ---------------------------------------------------------------------------

export interface TraceTimeProbeOutput {
	readonly timestamp: string
}

/**
 * Cheap timestamp resolver for a trace. `trace_detail_spans` is partitioned by
 * `toDate(Timestamp)`, so a trace lookup with no time predicate must seek across
 * every daily partition. When the caller has no timestamp (direct URL, shared
 * link, AI surface), this probe resolves one: selecting only `Timestamp`, with
 * no `ORDER BY` and `LIMIT 1`, ClickHouse reads ~one granule per partition and
 * stops — far cheaper than the full `spanHierarchyQuery` projection. The caller
 * then derives a ±1h window so the real query can prune partitions.
 */
export function traceTimeProbeQuery(opts: { traceId: string }) {
	return from(TraceDetailSpans)
		.select(($) => ({ timestamp: $.Timestamp }))
		.where(($) => [$.TraceId.eq(opts.traceId), $.OrgId.eq(param.string("orgId"))])
		.limit(1)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Traces duration stats
// ---------------------------------------------------------------------------

export interface TracesDurationStatsOpts {
	serviceName?: string
	spanName?: string
	hasError?: boolean
	minDurationMs?: number
	maxDurationMs?: number
	httpMethod?: string
	httpStatusCode?: string
	deploymentEnv?: string
	namespace?: string
	matchModes?: {
		serviceName?: "contains"
		spanName?: "contains"
		deploymentEnv?: "contains"
		serviceNamespace?: "contains"
	}
}

export interface TracesDurationStatsOutput {
	readonly minDurationMs: number
	readonly maxDurationMs: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
}

export function tracesDurationStatsQuery(opts: TracesDurationStatsOpts) {
	const mm = opts.matchModes

	return from(TraceListMv)
		.select(($) => ({
			minDurationMs: CH.min_($.Duration).div(1000000),
			maxDurationMs: CH.max_($.Duration).div(1000000),
			p50DurationMs: CH.quantile(0.5)($.Duration).div(1000000),
			p95DurationMs: CH.quantile(0.95)($.Duration).div(1000000),
		}))
		.where(($) => [
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
			CH.whenTrue(!!opts.hasError, () => $.HasError.eq(1)),
			CH.when(opts.minDurationMs, (v: number) => $.Duration.gte(v * 1000000)),
			CH.when(opts.maxDurationMs, (v: number) => $.Duration.lte(v * 1000000)),
			CH.when(opts.httpMethod, (v: string) => $.HttpMethod.eq(v)),
			CH.when(opts.httpStatusCode, (v: string) => $.HttpStatusCode.eq(v)),
			CH.when(opts.deploymentEnv, (v: string) =>
				mm?.deploymentEnv === "contains"
					? CH.positionCaseInsensitive($.DeploymentEnv, CH.lit(v)).gt(0)
					: $.DeploymentEnv.eq(v),
			),
			CH.when(opts.namespace, (v: string) =>
				mm?.serviceNamespace === "contains"
					? CH.positionCaseInsensitive($.ServiceNamespace, CH.lit(v)).gt(0)
					: $.ServiceNamespace.eq(v),
			),
		])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Traces facets (UNION ALL — 6 facet dimensions on trace_list_mv)
// ---------------------------------------------------------------------------

export interface TracesFacetsOpts {
	serviceName?: string
	spanName?: string
	hasError?: boolean
	minDurationMs?: number
	maxDurationMs?: number
	httpMethod?: string
	httpStatusCode?: string
	deploymentEnv?: string
	namespace?: string
	matchModes?: {
		serviceName?: "contains"
		spanName?: "contains"
		deploymentEnv?: "contains"
		serviceNamespace?: "contains"
	}
	attributeFilterKey?: string
	attributeFilterValue?: string
	attributeFilterValueMatchMode?: "contains"
	resourceFilterKey?: string
	resourceFilterValue?: string
	resourceFilterValueMatchMode?: "contains"
}

export interface TracesFacetsOutput {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

export function tracesFacetsQuery(opts: TracesFacetsOpts): CHUnionQuery<TracesFacetsOutput> {
	const baseWhere = ($: ColumnAccessor<typeof TraceListMv.columns>): Array<CH.Condition | undefined> => {
		const conditions: Array<CH.Condition | undefined> = [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		]

		if (opts.serviceName) {
			conditions.push(
				opts.matchModes?.serviceName === "contains"
					? CH.positionCaseInsensitive($.ServiceName, CH.lit(opts.serviceName)).gt(0)
					: $.ServiceName.eq(opts.serviceName),
			)
		}
		if (opts.spanName) {
			conditions.push(
				opts.matchModes?.spanName === "contains"
					? CH.positionCaseInsensitive($.SpanName, CH.lit(opts.spanName)).gt(0)
					: $.SpanName.eq(opts.spanName),
			)
		}
		if (opts.hasError) conditions.push($.HasError.eq(1))
		if (opts.minDurationMs != null) conditions.push($.Duration.gte(opts.minDurationMs * 1000000))
		if (opts.maxDurationMs != null) conditions.push($.Duration.lte(opts.maxDurationMs * 1000000))
		if (opts.httpMethod) conditions.push($.HttpMethod.eq(opts.httpMethod))
		if (opts.httpStatusCode) conditions.push($.HttpStatusCode.eq(opts.httpStatusCode))
		if (opts.deploymentEnv) {
			conditions.push(
				opts.matchModes?.deploymentEnv === "contains"
					? CH.positionCaseInsensitive($.DeploymentEnv, CH.lit(opts.deploymentEnv)).gt(0)
					: $.DeploymentEnv.eq(opts.deploymentEnv),
			)
		}
		if (opts.namespace) {
			conditions.push(
				opts.matchModes?.serviceNamespace === "contains"
					? CH.positionCaseInsensitive($.ServiceNamespace, CH.lit(opts.namespace)).gt(0)
					: $.ServiceNamespace.eq(opts.namespace),
			)
		}

		// Attribute filter EXISTS subqueries (correlated — references outer TraceId)
		if (opts.attributeFilterKey) {
			const attrCol = CH.mapGet(
				CH.dynamicColumn<Record<string, string>>("t_attr.SpanAttributes"),
				opts.attributeFilterKey,
			)
			const matchCond =
				opts.attributeFilterValueMatchMode === "contains"
					? CH.positionCaseInsensitive(attrCol, CH.lit(opts.attributeFilterValue ?? "")).gt(0)
					: attrCol.eq(opts.attributeFilterValue ?? "")
			const innerSql = compileCH(
				from(Traces, "t_attr")
					.select(() => ({ _: CH.lit(1) }))
					.where(() => [
						CH.dynamicColumn("t_attr.TraceId").eq(CH.outerRef("TraceId")),
						CH.dynamicColumn("t_attr.OrgId").eq(param.string("orgId")),
						CH.dynamicColumn<string>("t_attr.Timestamp").gte(param.dateTime("startTime")),
						CH.dynamicColumn<string>("t_attr.Timestamp").lte(param.dateTime("endTime")),
						matchCond,
					]),
				{},
				{ skipFormat: true },
			)
			conditions.push(CH.exists(innerSql.sql))
		}
		if (opts.resourceFilterKey) {
			const resCol = CH.mapGet(
				CH.dynamicColumn<Record<string, string>>("t_res.ResourceAttributes"),
				opts.resourceFilterKey,
			)
			const matchCond =
				opts.resourceFilterValueMatchMode === "contains"
					? CH.positionCaseInsensitive(resCol, CH.lit(opts.resourceFilterValue ?? "")).gt(0)
					: resCol.eq(opts.resourceFilterValue ?? "")
			const innerSql = compileCH(
				from(Traces, "t_res")
					.select(() => ({ _: CH.lit(1) }))
					.where(() => [
						CH.dynamicColumn("t_res.TraceId").eq(CH.outerRef("TraceId")),
						CH.dynamicColumn("t_res.OrgId").eq(param.string("orgId")),
						CH.dynamicColumn<string>("t_res.Timestamp").gte(param.dateTime("startTime")),
						CH.dynamicColumn<string>("t_res.Timestamp").lte(param.dateTime("endTime")),
						matchCond,
					]),
				{},
				{ skipFormat: true },
			)
			conditions.push(CH.exists(innerSql.sql))
		}

		return conditions
	}

	const makeFacetQuery = (
		colName: string,
		facetType: string,
		extraWhere?: ($: ColumnAccessor<typeof TraceListMv.columns>) => CH.Condition,
		limit = 50,
	) =>
		from(TraceListMv)
			.select((_$) => ({
				name: CH.dynamicColumn<string>(colName),
				count: CH.count(),
				facetType: CH.lit(facetType),
			}))
			.where(($) => [...baseWhere($), extraWhere?.($)])
			.groupBy("name")
			.orderBy(["count", "desc"])
			.limit(limit)

	return unionAll(
		makeFacetQuery("ServiceName", "service"),
		makeFacetQuery("SpanName", "spanName", ($) => $.SpanName.neq(""), 20),
		makeFacetQuery("HttpMethod", "httpMethod", ($) => $.HttpMethod.neq(""), 20),
		makeFacetQuery("HttpStatusCode", "httpStatus", ($) => $.HttpStatusCode.neq(""), 20),
		makeFacetQuery("DeploymentEnv", "deploymentEnv", ($) => $.DeploymentEnv.neq(""), 20),
		makeFacetQuery("ServiceNamespace", "serviceNamespace", ($) => $.ServiceNamespace.neq(""), 20),
		from(TraceListMv)
			.select(() => ({
				name: CH.lit("error"),
				count: CH.count(),
				facetType: CH.lit("errorCount"),
			}))
			.where(($) => [...baseWhere($), $.HasError.eq(1)]),
	).format("JSON")
}

// ---------------------------------------------------------------------------
// Errors facets (UNION ALL — service + environment + error_type facets)
// ---------------------------------------------------------------------------

export interface ErrorsFacetsOpts {
	rootOnly?: boolean
	services?: readonly string[]
	deploymentEnvs?: readonly string[]
	fingerprintHashes?: readonly string[]
}

export interface ErrorsFacetsOutput {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

export function errorsFacetsQuery(opts: ErrorsFacetsOpts): CHUnionQuery<ErrorsFacetsOutput> {
	const table = errorEventsTableForRecentScan(opts)
	const baseWhere = ($: ColumnAccessor<typeof table.columns>): Array<CH.Condition | undefined> => [
		$.OrgId.eq(param.string("orgId")),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
		CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
		opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
		opts.deploymentEnvs?.length ? CH.inList($.DeploymentEnv, opts.deploymentEnvs) : undefined,
		opts.fingerprintHashes?.length
			? fingerprintHashIn($.FingerprintHash, opts.fingerprintHashes)
			: undefined,
	]

	const serviceQuery = from(table)
		.select(($) => ({
			name: $.ServiceName,
			count: CH.count(),
			facetType: CH.lit("service"),
		}))
		.where(baseWhere)
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(100)

	const envQuery = from(table)
		.select(($) => ({
			name: $.DeploymentEnv,
			count: CH.count(),
			facetType: CH.lit("environment"),
		}))
		.where(($) => [...baseWhere($), $.DeploymentEnv.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(100)

	// error_type facet groups by the human-readable ErrorLabel (display facet).
	const errorTypeQuery = from(table)
		.select(($) => ({
			name: $.ErrorLabel,
			count: CH.count(),
			facetType: CH.lit("error_type"),
		}))
		.where(baseWhere)
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)

	return unionAll(serviceQuery, envQuery, errorTypeQuery).format("JSON")
}

// ---------------------------------------------------------------------------
// Errors summary (CROSS JOIN between error_spans and service_usage)
// ---------------------------------------------------------------------------

export interface ErrorsSummaryOpts {
	rootOnly?: boolean
	services?: readonly string[]
	deploymentEnvs?: readonly string[]
	fingerprintHashes?: readonly string[]
}

export interface ErrorsSummaryOutput {
	readonly totalErrors: number
	readonly totalSpans: number
	readonly errorRate: number
	readonly affectedServicesCount: number
	readonly affectedTracesCount: number
}

export function errorsSummaryQuery(opts: ErrorsSummaryOpts) {
	const errorSub = from(errorEventsTableForRecentScan(opts))
		.select(($) => ({
			totalErrors: CH.count(),
			affectedServicesCount: CH.uniq($.ServiceName),
			affectedTracesCount: CH.uniq($.TraceId),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
			opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
			opts.deploymentEnvs?.length ? CH.inList($.DeploymentEnv, opts.deploymentEnvs) : undefined,
			opts.fingerprintHashes?.length
				? fingerprintHashIn($.FingerprintHash, opts.fingerprintHashes)
				: undefined,
		])

	const buildResult = <JCols extends ColumnDefs, JJoins extends Record<string, ColumnDefs>>(
		usageSub: CHQuery<JCols, { totalSpans: number }, JJoins>,
	) =>
		fromQuery(errorSub, "e")
			.crossJoinQuery(usageSub, "s")
			.select(($) => ({
				totalErrors: $.totalErrors,
				totalSpans: $.s.totalSpans,
				errorRate: CH.if_(
					$.s.totalSpans.gt(0),
					CH.round_($.totalErrors.div($.s.totalSpans), 6),
					CH.lit(0),
				),
				affectedServicesCount: $.affectedServicesCount,
				affectedTracesCount: $.affectedTracesCount,
			}))
			.format("JSON")

	if (opts.rootOnly) {
		return buildResult(
			from(TraceListMv)
				.select(() => ({
					totalSpans: CH.count(),
				}))
				.where(($) => [
					$.OrgId.eq(param.string("orgId")),
					$.Timestamp.gte(param.dateTime("startTime")),
					$.Timestamp.lte(param.dateTime("endTime")),
					opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
					opts.deploymentEnvs?.length ? CH.inList($.DeploymentEnv, opts.deploymentEnvs) : undefined,
				]),
		)
	}

	if (opts.deploymentEnvs?.length) {
		const deploymentEnvs = opts.deploymentEnvs
		return buildResult(
			from(Traces)
				.select(() => ({
					totalSpans: CH.count(),
				}))
				.where(($) => [
					$.OrgId.eq(param.string("orgId")),
					$.Timestamp.gte(param.dateTime("startTime")),
					$.Timestamp.lte(param.dateTime("endTime")),
					opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
					CH.inList($.ResourceAttributes.get("deployment.environment"), deploymentEnvs),
				]),
		)
	}

	return buildResult(
		from(ServiceUsage)
			.select(($) => ({
				totalSpans: CH.sum($.TraceCount),
			}))
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				$.Hour.gte(param.dateTime("startTime")),
				$.Hour.lte(param.dateTime("endTime")),
				opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
			]),
	)
}

// ---------------------------------------------------------------------------
// Error Issues — fingerprint-grouped aggregate from error_events
// ---------------------------------------------------------------------------

export interface ErrorIssuesOpts {
	services?: readonly string[]
	deploymentEnvs?: readonly string[]
	fingerprintHashes?: readonly string[]
	exceptionTypes?: readonly string[]
	limit?: number
}

export interface ErrorIssuesOutput {
	readonly fingerprintHash: string
	readonly serviceName: string
	readonly exceptionType: string
	readonly exceptionMessage: string
	readonly errorLabel: string
	readonly topFrame: string
	readonly count: number
	readonly affectedServicesCount: number
	readonly firstSeen: string
	readonly lastSeen: string
}

export function errorIssuesQuery(opts: ErrorIssuesOpts) {
	// Broad issue scans use the time-ordered sibling so ClickHouse prunes by
	// (OrgId, Timestamp). When the caller narrows to known fingerprints, switch
	// back to the FingerprintHash-ordered table.
	return from(errorEventsTableForRecentScan(opts))
		.select(($) => ({
			fingerprintHash: CH.toString_($.FingerprintHash),
			serviceName: CH.any_($.ServiceName),
			exceptionType: CH.any_($.ExceptionType),
			exceptionMessage: CH.any_($.ExceptionMessage),
			errorLabel: CH.any_($.ErrorLabel),
			topFrame: CH.any_($.TopFrame),
			count: CH.count(),
			affectedServicesCount: CH.uniq($.ServiceName),
			firstSeen: CH.min_($.Timestamp),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
			opts.deploymentEnvs?.length ? CH.inList($.DeploymentEnv, opts.deploymentEnvs) : undefined,
			opts.fingerprintHashes?.length
				? fingerprintHashIn($.FingerprintHash, opts.fingerprintHashes)
				: undefined,
			opts.exceptionTypes?.length ? CH.inList($.ExceptionType, opts.exceptionTypes) : undefined,
		])
		.groupBy("fingerprintHash")
		.orderBy(["count", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Error Issue timeseries — per-fingerprint occurrence bucket
// ---------------------------------------------------------------------------

export interface ErrorIssueTimeseriesOutput {
	readonly bucket: string
	readonly count: number
}

export function errorIssueTimeseriesQuery() {
	return from(ErrorEvents)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.FingerprintHash.eq(CH.toUInt64(param.string("fingerprintHash"))),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Error Issue sample traces — most recent occurrences for one issue
// ---------------------------------------------------------------------------

export interface ErrorIssueSampleTracesOutput {
	readonly traceId: string
	readonly spanId: string
	readonly serviceName: string
	readonly timestamp: string
	readonly exceptionMessage: string
	readonly durationMicros: number
}

export function errorIssueSampleTracesQuery(opts: { limit?: number }) {
	return from(ErrorEvents)
		.select(($) => ({
			traceId: $.TraceId,
			spanId: $.SpanId,
			serviceName: $.ServiceName,
			timestamp: $.Timestamp,
			exceptionMessage: $.ExceptionMessage,
			durationMicros: CH.intDiv($.Duration, 1000),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.FingerprintHash.eq(CH.toUInt64(param.string("fingerprintHash"))),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.orderBy(["timestamp", "desc"])
		.limit(opts.limit ?? 25)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Error detail traces (INNER JOIN with error subquery)
// ---------------------------------------------------------------------------

export interface ErrorDetailTracesOpts {
	fingerprintHash: string
	rootOnly?: boolean
	services?: readonly string[]
	limit?: number
}

export interface ErrorDetailTracesOutput {
	readonly traceId: string
	readonly startTime: string
	readonly durationMicros: number
	readonly spanCount: number
	readonly services: readonly string[]
	readonly rootSpanName: string
	readonly errorMessage: string
}

export function errorDetailTracesQuery(opts: ErrorDetailTracesOpts) {
	const limit = opts.limit ?? 10

	// Subquery: find distinct matching error TraceIds. Order by the most
	// recent Timestamp per trace so the LIMIT selects the N most recently
	// errored traces — ordering by TraceId would return arbitrary ID-sorted
	// rows that omit the most recent matches when the result is truncated.
	const errorSub = from(ErrorEvents)
		.select(($) => ({
			TraceId: $.TraceId,
			lastErrorSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			fingerprintHashEq($.FingerprintHash, opts.fingerprintHash),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
			opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
		])
		.groupBy("TraceId")
		.orderBy(["lastErrorSeen", "desc"])
		.limit(limit)

	const errorSubSql = compileCH(errorSub, {}, { skipFormat: true }).sql

	// Outer query: fetch all spans for the matching traces. Use an IN-filtered
	// small subquery instead of an INNER JOIN so ClickHouse can apply the
	// trace-detail projection's (OrgId, TraceId, SpanId) sort key while reading
	// `trace_detail_spans`.
	return from(TraceDetailSpans)
		.select(($) => ({
			traceId: $.TraceId,
			startTime: CH.min_($.Timestamp),
			durationMicros: CH.intDiv(CH.max_($.Duration), 1000),
			spanCount: CH.count(),
			services: CH.groupUniqArray($.ServiceName),
			rootSpanName: CH.anyIf($.SpanName, $.ParentSpanId.eq("")),
			errorMessage: CH.any_($.StatusMessage),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			CH.inSubquery($.TraceId, `SELECT TraceId FROM (${errorSubSql})`),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.groupBy("traceId")
		.orderBy(["startTime", "desc"])
		.format("JSON")
}

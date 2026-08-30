// Typed Service Map Queries
//
// `*Query` exports return a `CHQuery` for the caller to compile; `*SQL` exports
// compile it themselves and attach a row schema. Both go through the DSL, so
// every query's tenant scope is derived from its predicates rather than
// asserted — see `serviceMapEdgeJoinQuery` for why that distinction earned its
// own paragraph.

import {
	DB_QUERY_KEY_SQL,
	DB_QUERY_LABEL_SQL,
	DB_STATEMENT_SQL,
	HYPERDRIVE_DB_NAMESPACE,
	OPAQUE_DB_NAMESPACE_RE,
	presentableStatementSql,
} from "@maple/domain/tinybird/db-query-shape-sql"
import { deploymentEnvExpr, messagingDestinationExpr } from "@maple/domain/tinybird/semconv-renames"
import { Schema, Effect } from "effect"
import { compile, type CompiledQuery, type CompiledQueryRowSchema } from "@maple-dev/clickhouse-builder"
import { defineCondFn, defineFn } from "@maple-dev/clickhouse-builder"
import * as CH from "@maple-dev/clickhouse-builder/expr"
// From the root, not `/expr`: this overload takes a `CHQuery`, so the subquery
// keeps its params, table names and column types checked.
import { inSubquery } from "@maple-dev/clickhouse-builder"
import { param } from "@maple-dev/clickhouse-builder"
import { from, fromQuery, fromUnion } from "@maple-dev/clickhouse-builder"
import {
	ServiceAddressResolutionsHourly,
	ServiceExternalEdgesHourly,
	ServiceMapChildren,
	ServiceMapDbEdgesHourly,
	ServiceMapDbQuerySignaturesHourly,
	ServiceMapEdgesHourly,
	ServiceMapSpans,
	ServicePlatformsHourly,
	type StringMap,
	Traces,
} from "../tables"
import { unionAll } from "@maple-dev/clickhouse-builder"
import { edgeCondition, interiorConditions } from "./rollup-splice"
import { CHNumber, CHNumberOrZero } from "../schema"
import * as T from "@maple-dev/clickhouse-builder/types"
import type { QueryBuilderError } from "@maple-dev/clickhouse-builder"

// Local CH function declarations used by the live topology-join branch's
// sample-weighting math. Kept here (not promoted to ch/functions/) because
// they're niche and only this builder uses them; promote later if reused.
const _toFloat64 = defineFn<[CH.Expr<unknown>], number>("toFloat64", T.float64)
const _matchRegex = defineCondFn<[CH.Expr<string>, string]>("match")

// Service dependencies

export interface ServiceDependenciesOpts {
	deploymentEnv?: string
}

export interface ServiceDependenciesOutput {
	readonly sourceService: string
	readonly targetService: string
	readonly callCount: number
	readonly errorCount: number
	readonly avgDurationMs: number
	/**
	 * The window's slowest call, NOT a percentile — and unlike the database and
	 * external edges, this one has no `p95DurationMs` beside it.
	 *
	 * `service_map_edges_hourly` is filled by the scheduled rollup shipping rows
	 * through the Events API as JSON, and Tinybird rejects AggregateFunction
	 * columns in a datasource carrying JSONPaths (see `serviceMapEdgesHourlyIngest`).
	 * A t-digest is not JSON-serializable and the forwarding view cannot rebuild
	 * one from a sum and a max, so a real p95 here needs the rollup to stop going
	 * through that bridge — a larger change than migration 0022 was.
	 *
	 * It renders nowhere on the map: service nodes take their p95 from
	 * `serviceOverview`, which is a real merged tDigest. This value reaches only
	 * the MCP table and the chat renderer, both of which label it "Max Duration".
	 */
	readonly maxDurationMs: number
	readonly estimatedSpanCount: number
}

const ServiceDependenciesOutputSchema: CompiledQueryRowSchema<ServiceDependenciesOutput> = Schema.Struct({
	sourceService: Schema.String,
	targetService: Schema.String,
	callCount: CHNumber,
	errorCount: CHNumber,
	avgDurationMs: CHNumberOrZero,
	maxDurationMs: CHNumber,
	estimatedSpanCount: CHNumber,
})

/** The `th:` TraceState marker for a consistent-probability sampling decision. */
const SAMPLED_TRACE_STATE_RE = "th:[0-9a-f]+"

/**
 * Sample-weight expression: `1 / (1 - acceptanceProbability)` for spans carrying
 * a `th:` TraceState threshold, else `1.0` (unsampled).
 *
 * The bit math stays raw — `reinterpretAsUInt64`/`unhex`/`rightPad`/`pow`/
 * `reverse` aren't worth promoting to first-class DSL helpers for one call site.
 */
const sampleWeightExpr = (traceState: CH.Expr<string>) =>
	CH.multiIf(
		[
			[
				_matchRegex(traceState, SAMPLED_TRACE_STATE_RE),
				CH.rawExpr(
					"1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001)",
					T.float64,
				),
			],
		],
		CH.rawExpr("1.0", T.float64),
	)

/**
 * The parent(Client/Producer) ⋈ child(Server/Consumer) span join that every
 * service-map edge builder is a projection of.
 *
 * Returns the joined query with `p` as the main source and `c` as the joined
 * alias, before any SELECT — callers pick the output shape. Both sides filter
 * `OrgId`, so anything built on this derives `tenantScope: "single-tenant"` without the
 * outer query having to repeat the predicate.
 *
 * `parentServiceName` is pushed into the parent subquery rather than the outer
 * WHERE, so ClickHouse skips the full Client/Producer scan and shrinks the
 * join's left side to one service's outbound spans. The rollup omits it to
 * cover every service.
 */
function serviceMapEdgeJoinSource(opts: {
	rangeStart: CH.Expr<string>
	rangeEnd: CH.Expr<string>
	deploymentEnv?: string
	parentServiceName?: string
	/**
	 * Restrict both sides to the two PARTIAL hours at the ends of the range —
	 * the read path's live branch, complementing whatever the hourly rollup
	 * already sealed. The rollup's own caller leaves this off: it aggregates one
	 * whole hour, which has no partial ends.
	 *
	 * Applied to parent and child alike, so an edge is counted only when both
	 * spans fall in the same slice. That is already how the rollup defines an
	 * hourly edge, so the live branch and the sealed buckets agree.
	 */
	edgeHoursOnly?: boolean
}) {
	const envFilter = (deploymentEnv: CH.Expr<string>) =>
		opts.deploymentEnv ? deploymentEnv.eq(opts.deploymentEnv) : undefined
	const edgeOnly = opts.edgeHoursOnly ? edgeCondition("Timestamp") : undefined

	const parentSpans = from(ServiceMapSpans)
		.select(($) => ({
			OrgId: $.OrgId,
			Timestamp: $.Timestamp,
			TraceId: $.TraceId,
			SpanId: $.SpanId,
			ServiceName: $.ServiceName,
			DeploymentEnv: $.DeploymentEnv,
		}))
		.where(($) => [
			$.SpanKind.in_("Client", "Producer"),
			$.Timestamp.gte(opts.rangeStart),
			$.Timestamp.lt(opts.rangeEnd),
			$.OrgId.eq(param.string("orgId")),
			envFilter($.DeploymentEnv),
			edgeOnly,
			opts.parentServiceName ? $.ServiceName.eq(opts.parentServiceName) : undefined,
		])

	const childSpans = from(ServiceMapChildren)
		.select(($) => ({
			TraceId: $.TraceId,
			ParentSpanId: $.ParentSpanId,
			ServiceName: $.ServiceName,
			Duration: $.Duration,
			StatusCode: $.StatusCode,
			TraceState: $.TraceState,
		}))
		.where(($) => [
			$.Timestamp.gte(opts.rangeStart),
			$.Timestamp.lt(opts.rangeEnd),
			$.OrgId.eq(param.string("orgId")),
			envFilter($.DeploymentEnv),
			edgeOnly,
		])

	// In a join the main subquery's columns auto-qualify with its alias
	// (`p.ServiceName`); joined columns are reached via `$.c.Column`.
	return fromQuery(parentSpans, "p").innerJoinQuery(childSpans, "c", (p, c) =>
		p.SpanId.eq(c.ParentSpanId).and(p.TraceId.eq(c.TraceId)),
	)
}

/**
 * Service-to-service edges for `[rangeStart, rangeEnd)`, projected with the
 * exact column shape of the `service_map_edges_hourly` table so the rollup can
 * `ingest` the rows unchanged.
 *
 * The downstream service name is recovered by joining each Client/Producer span
 * to its child Server/Consumer span: modern OTEL instrumentation no longer
 * emits `peer.service` (only `server.address`, a hostname), so the parent→child
 * span join is the only reliable source of the *logical* downstream service. A
 * materialized view cannot express a cross-span join, which is why
 * `service_map_edges_hourly` is filled by the scheduled
 * `ServiceMapRollupService` rather than an MV.
 *
 * `SampleRateSum` is computed inline from the child span's `th:` TraceState
 * threshold because `service_map_children` carries no `SampleRate` column.
 *
 * This used to be a SQL-string builder taking an optional `orgId` that degraded
 * to an empty filter for a backfill script — i.e. a join across every tenant's
 * spans, wrapped by both callers in `rawCompiledQuery({ tenantScope: "single-tenant" })`
 * so an omitted org id would have been positively ASSERTED as scoped and sailed
 * through the executor's gate. The org filter is now structural: it comes from
 * `param.string("orgId")` inside the join source, and the scope is derived. A
 * cross-org backfill needs its own explicitly-named entry point.
 */
export function serviceMapEdgeJoinQuery(opts: {
	rangeStart: CH.Expr<string>
	rangeEnd: CH.Expr<string>
	deploymentEnv?: string
	parentServiceName?: string
}) {
	return serviceMapEdgeJoinSource(opts)
		.select(($) => ({
			OrgId: $.OrgId,
			Hour: CH.toStartOfHour($.Timestamp),
			SourceService: $.ServiceName,
			TargetService: $.c.ServiceName,
			DeploymentEnv: $.DeploymentEnv,
			CallCount: CH.count(),
			ErrorCount: CH.countIf($.c.StatusCode.eq("Error")),
			DurationSumMs: CH.sum($.c.Duration.div(1000000)),
			MaxDurationMs: CH.max_($.c.Duration.div(1000000)),
			SampledSpanCount: CH.countIf(_matchRegex($.c.TraceState, SAMPLED_TRACE_STATE_RE)),
			UnsampledSpanCount: CH.countIf(CH.not(_matchRegex($.c.TraceState, SAMPLED_TRACE_STATE_RE))),
			SampleRateSum: CH.sum(sampleWeightExpr($.c.TraceState)),
		}))
		.where(($) => [$.ServiceName.neq($.c.ServiceName)])
		.groupBy("OrgId", "Hour", "SourceService", "TargetService", "DeploymentEnv")
}

/**
 * Org-wide service dependencies — every edge, for the global services map.
 *
 * Same builder as the service-scoped variant with the `serviceName` filter
 * dropped; see {@link serviceDependenciesQueryBase} for the branch structure.
 */
export function serviceDependenciesSQL(
	opts: ServiceDependenciesOpts,
	params: { orgId: string; startTime: string; endTime: string },
): Effect.Effect<CompiledQuery<ServiceDependenciesOutput>, QueryBuilderError> {
	return compile(
		serviceDependenciesQueryBase({ deploymentEnv: opts.deploymentEnv }),
		{
			orgId: params.orgId,
			startTime: params.startTime,
			endTime: params.endTime,
		},
		{ rowSchema: ServiceDependenciesOutputSchema },
	)
}

// Service ↔ service dependencies — scoped to one source service
//
// The service-detail page's Dependencies tab only needs outbound edges for the
// currently-displayed service. The org-wide variant above is kept for the
// global Services map (which renders every edge). This variant pushes the
// `SourceService` filter into both branches so:
//   - the hourly branch reads only rows tagged with this service (cheap), and
//   - the live topology JOIN's left side (Client/Producer spans) shrinks to a
//     single service's outbound spans instead of every span in the org.
// Output shape matches `ServiceDependenciesOutput` so callers can reuse the
// same row-transform code.

export interface ServiceDependenciesForServiceOpts {
	serviceName: string
	deploymentEnv?: string
}

/**
 * Service dependency edges: hourly MV branch (sealed buckets) UNION ALL a live
 * topology JOIN per partial hour, re-aggregated through `fromUnion()` so the
 * outer SELECT computes properly-weighted averages across both sources.
 *
 * Omit `serviceName` for the org-wide global services map; pass it for the
 * service-detail page, which pushes the filter into both branches so the hourly
 * branch reads only rows tagged with that service and the join's left side
 * shrinks to one service's outbound spans.
 *
 * Returns a `CHQuery`; the caller passes `{orgId, startTime, endTime}` to
 * `CH.compile(q, params)`.
 *
 * ## Why the inner branches use `bucket*` aliases
 *
 * The outer SELECT's `sum(...) AS callCount` must not collide with an inner
 * `sum(CallCount) AS callCount`. ClickHouse's UNION-ALL + GROUP-BY optimizer
 * otherwise rewrites the outer as `sum(sum(CallCount))` and rejects the query
 * with "found inside another aggregate function". The disjoint alias sets are
 * load-bearing, not stylistic — `service-map.test.ts` asserts it.
 *
 * `bucketDurationSumMs` is carried separately from `bucketCallCount` so the
 * outer computes `sum(durations) / sum(calls)` rather than `avg(avgDurationMs)`
 * — averaging averages would ignore each branch's relative call count.
 *
 * Only complete interior hours come from the hourly rollup; the two partial
 * hours at the ends are read from raw spans. Both predicates come from
 * `./rollup-splice`, so the tiers tile the window exactly once by construction
 * rather than by two hand-written inequalities agreeing. A window inside a
 * single hour has an empty interior and is served entirely by the raw branch.
 */
export function serviceDependenciesQueryBase(opts: { serviceName?: string; deploymentEnv?: string }) {
	const envFilterMv = (deploymentEnv: CH.Expr<string>) =>
		opts.deploymentEnv ? deploymentEnv.eq(opts.deploymentEnv) : undefined

	const startDateTime = CH.toDateTime(param.dateTimeString("startTime"))
	const endDateTime = CH.toDateTime(param.dateTimeString("endTime"))

	// Hourly branch — only sealed, complete buckets inside the requested window.
	const hourlyBranch = from(ServiceMapEdgesHourly)
		.select(($) => ({
			sourceService: $.SourceService,
			targetService: $.TargetService,
			bucketCallCount: CH.sum($.CallCount),
			bucketErrorCount: CH.sum($.ErrorCount),
			bucketDurationSumMs: CH.sum($.DurationSumMs),
			bucketMaxDurationMs: CH.max_($.MaxDurationMs),
			// Historical buckets pre-date the SampleRateSum column (it was added
			// later) — fall back to CallCount for those rows so they count as
			// unsampled (degraded but safe).
			bucketEstimatedSpanCount: CH.sum(
				CH.if_($.SampleRateSum.gt(0), $.SampleRateSum, _toFloat64($.CallCount)),
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			opts.serviceName ? $.SourceService.eq(opts.serviceName) : undefined,
			...interiorConditions($.Hour),
			envFilterMv($.DeploymentEnv),
		])
		.groupBy("sourceService", "targetService")

	// Raw topology JOIN for the two partial hours the rollup has not sealed into
	// `service_map_edges_hourly`. Shares its join source with the rollup's own
	// builder so the two stay in lockstep, then re-aggregates dropping `Hour`
	// into the `bucket*` shape.
	//
	// One branch over the whole window rather than a start-edge and an end-edge
	// branch: `edgeHoursOnly` is the exact complement of the hourly interior, so
	// a single pass covers both ends. That also runs the join once instead of
	// twice, and stops dropping the rare pair whose parent lands in the leading
	// partial hour and whose child lands in the trailing one.
	const liveJoinBranch = () =>
		serviceMapEdgeJoinSource({
			rangeStart: startDateTime,
			rangeEnd: endDateTime,
			deploymentEnv: opts.deploymentEnv,
			parentServiceName: opts.serviceName,
			edgeHoursOnly: true,
		})
			.select(($) => ({
				sourceService: $.ServiceName,
				targetService: $.c.ServiceName,
				bucketCallCount: CH.count(),
				bucketErrorCount: CH.countIf($.c.StatusCode.eq("Error")),
				bucketDurationSumMs: CH.sum($.c.Duration.div(1000000)),
				bucketMaxDurationMs: CH.max_($.c.Duration.div(1000000)),
				bucketEstimatedSpanCount: CH.sum(sampleWeightExpr($.c.TraceState)),
			}))
			.where(($) => [$.ServiceName.neq($.c.ServiceName)])
			.groupBy("sourceService", "targetService")

	// Outer wrap: re-aggregate across both branches so avg duration uses
	// branch-summed numerators/denominators (avoids averaging averages). With
	// no further joins, columns from the union are accessed bare.
	return fromUnion(unionAll(hourlyBranch, liveJoinBranch()), "edges")
		.select(($) => ({
			sourceService: $.sourceService,
			targetService: $.targetService,
			callCount: CH.sum($.bucketCallCount),
			errorCount: CH.sum($.bucketErrorCount),
			avgDurationMs: CH.sum($.bucketDurationSumMs).div(CH.nullIf(CH.sum($.bucketCallCount), CH.lit(0))),
			maxDurationMs: CH.max_($.bucketMaxDurationMs),
			estimatedSpanCount: CH.sum($.bucketEstimatedSpanCount),
		}))
		.groupBy("sourceService", "targetService")
		.orderBy(["callCount", "desc"])
		.limit(200)
		.format("JSON")
}

/**
 * Outbound dependency edges for one service — the service-detail page's
 * "Services" panel. See {@link serviceDependenciesQueryBase}.
 */
export function serviceDependenciesForServiceQuery(opts: ServiceDependenciesForServiceOpts) {
	return serviceDependenciesQueryBase(opts)
}

// Service ↔ database edges
//
// Surfaces DB calls (Client/Producer spans with `db.system.name` set) as a separate
// dependency relation so the service map can reify databases as nodes.
// One row per (sourceService, dbSystem).
//
// Reads pre-aggregated hourly buckets from `service_map_db_edges_hourly`
// (populated by `service_map_db_edges_hourly_mv`), and unions in the trailing
// hour from raw `traces` so the most recent in-flight bucket is included even
// before the MV finalizes it. Mirrors the dual-source pattern used by
// `serviceDependenciesSQL` for `service_map_edges_hourly`.

export interface ServiceDbEdgesOpts {
	deploymentEnv?: string
}

export interface ServiceDbEdgesOutput {
	readonly sourceService: string
	readonly dbSystem: string
	readonly dbNamespace: string
	readonly callCount: number
	readonly errorCount: number
	readonly avgDurationMs: number
	/**
	 * The window's slowest call. Kept beside `p95DurationMs` rather than replaced:
	 * it is the only latency figure available for buckets sealed before migration
	 * 0022, and it is a genuinely useful outlier signal in its own right. Present
	 * it AS a max wherever it is shown.
	 */
	readonly maxDurationMs: number
	/**
	 * Sample-weighted p95 in ms, merged from the edge rollup's t-digest.
	 *
	 * 0 when the window has no digest to merge — buckets sealed before migration
	 * 0022 hold an empty state and are not backfilled. Callers fall back to
	 * `maxDurationMs` and must present it AS a max; substituting one for the other
	 * under a "p95" label is the bug this pair replaced.
	 */
	readonly p95DurationMs: number
	readonly estimatedSpanCount: number
}

const ServiceDbEdgesOutputSchema: CompiledQueryRowSchema<ServiceDbEdgesOutput> = Schema.Struct({
	sourceService: Schema.String,
	dbSystem: Schema.String,
	dbNamespace: Schema.String,
	callCount: CHNumber,
	errorCount: CHNumber,
	avgDurationMs: CHNumberOrZero,
	maxDurationMs: CHNumber,
	p95DurationMs: CHNumberOrZero,
	estimatedSpanCount: CHNumber,
})

export function serviceDbEdgesSQL(
	opts: ServiceDbEdgesOpts,
	params: { orgId: string; startTime: string; endTime: string },
): Effect.Effect<CompiledQuery<ServiceDbEdgesOutput>, QueryBuilderError> {
	return compile(serviceDbEdgesQueryBase(opts), params, {
		rowSchema: ServiceDbEdgesOutputSchema,
	})
}

/**
 * The edge rollups' sample-weighted t-digest, and its raw-branch twin.
 *
 * Byte-identical to the state `service_map_db_query_shapes_hourly_mv` writes, so
 * a database node and the detail panel that opens on top of it finalize the same
 * statistic over the same spans and cannot disagree. The strings stay raw: the
 * DSL has no notion of ClickHouse's `-State` / `-Merge` combinators, and the
 * sealed and live branches must agree on the type exactly to UNION-merge.
 */
const EDGE_TDIGEST_MERGE_STATE_EXPR = "quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles)"
const EDGE_TDIGEST_RAW_STATE_EXPR =
	"quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0)))"
const EDGE_DURATION_STATE = T.aggregateState("quantilesTDigestWeighted(0.5, 0.95)", "UInt64", "UInt32")

/**
 * Finalize the merged edge digest to milliseconds, or 0 when there is nothing to
 * merge.
 *
 * Zero is a real answer here rather than a null: buckets sealed before migration
 * 0022 hold an empty state, and the UI is expected to fall back to
 * `maxDurationMs` — shown as a max — for those windows. Reporting a fabricated
 * quantile off an empty digest is precisely the failure this replaced.
 */
const edgeP95Expr = CH.rawExpr(
	"if(sum(bucketCallCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bucketDurationQuantiles), 2) / 1000000, 0)",
	T.float64,
)

// Shared DSL expressions for identifying the database a Client/Producer span
// talks to, mirroring the write-side `DB_SYSTEM_ATTR_SQL` /
// `DB_NAMESPACE_ATTR_SQL` fragments so raw-branch keys merge with the MV's.
const dbSystemExpr = ($: { SpanAttributes: CH.ColumnRef<"SpanAttributes", StringMap> }) =>
	CH.coalesce(CH.nullIf($.SpanAttributes.get("db.system.name"), ""), $.SpanAttributes.get("db.system"))
const dbNamespaceCoalesce = ($: { SpanAttributes: CH.ColumnRef<"SpanAttributes", StringMap> }) =>
	CH.coalesce(
		CH.nullIf($.SpanAttributes.get("db.namespace"), ""),
		CH.nullIf($.SpanAttributes.get("db.name"), ""),
		CH.nullIf($.SpanAttributes.get("server.address"), ""),
		$.SpanAttributes.get("net.peer.name"),
	)

// Collapse an *opaque* database namespace (a Cloudflare Hyperdrive config ID, or a
// `*.hyperdrive.local` host) to the `HYPERDRIVE_DB_NAMESPACE` sentinel so all of an
// org's per-binding/per-env Hyperdrive hashes merge into one map node the UI brands
// as "Hyperdrive". Idempotent (the sentinel doesn't match the pattern) so it is safe
// to apply on already-collapsed sealed rows. Compiles byte-identically to the write
// side's `DB_NAMESPACE_ATTR_SQL` when the argument is `dbNamespaceCoalesce`.
const collapseHyperdriveNs = (ns: CH.Expr<string>): CH.Expr<string> =>
	CH.if_(_matchRegex(ns, OPAQUE_DB_NAMESPACE_RE), CH.lit(HYPERDRIVE_DB_NAMESPACE), ns)

const dbNamespaceExpr = ($: { SpanAttributes: CH.ColumnRef<"SpanAttributes", StringMap> }) =>
	collapseHyperdriveNs(dbNamespaceCoalesce($))

/**
 * Shared builder behind `serviceDbEdgesSQL` (org-wide) and
 * `serviceDbEdgesForServiceQuery` (service-scoped) — identical dual-source
 * shape, the scoped variant just adds a `ServiceName = ?` filter to both
 * branches.
 *
 * Inner branches expose `bucket*` aliases so the outer `sum(...) AS callCount`
 * can't collide with an inner `sum(CallCount) AS callCount` — same fix as
 * `serviceDependenciesSQL` for the same nested-aggregate optimizer error.
 * Historical buckets that pre-date the SampleRateSum column have it set to
 * 0, so we fall back to CallCount per-row (treats those buckets as
 * unsampled — degraded but safe).
 */
function serviceDbEdgesQueryBase(opts: { serviceName?: string; deploymentEnv?: string }) {
	// Hourly branch — sealed buckets from service_map_db_edges_hourly_mv.
	const hourlyBranch = from(ServiceMapDbEdgesHourly)
		.select(($) => ({
			sourceService: $.ServiceName,
			dbSystem: $.DbSystem,
			// Collapse pre-migration sealed rows that still carry the raw Hyperdrive
			// hex namespace, so they merge with the recent branch's collapsed value.
			dbNamespace: collapseHyperdriveNs($.DbNamespace),
			bucketCallCount: CH.sum($.CallCount),
			bucketErrorCount: CH.sum($.ErrorCount),
			bucketDurationSumMs: CH.sum($.DurationSumMs),
			bucketMaxDurationMs: CH.max_($.MaxDurationMs),
			bucketEstimatedSpanCount: CH.sum(
				CH.if_($.SampleRateSum.gt(0), $.SampleRateSum, _toFloat64($.CallCount)),
			),
			bucketDurationQuantiles: CH.rawExpr(EDGE_TDIGEST_MERGE_STATE_EXPR, EDGE_DURATION_STATE),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			opts.serviceName ? $.ServiceName.eq(opts.serviceName) : undefined,
			...interiorConditions($.Hour),
			$.DbSystem.neq(""),
			opts.deploymentEnv ? $.DeploymentEnv.eq(opts.deploymentEnv) : undefined,
		])
		.groupBy("sourceService", "dbSystem", "dbNamespace")

	// Raw branch for the two PARTIAL hours at the ends of the window — the exact
	// complement of the hourly interior above (`edgeCondition` is defined as that
	// complement). Reads per-row `SampleRate` directly so no inline weight math is
	// needed, and carries `bucketDurationSumMs` separately so the outer can do a
	// properly-weighted average.
	//
	// This used to read only the trailing in-progress hour while the hourly branch
	// started at `toStartOfHour(startTime)`, so every request whose start was not
	// hour-aligned counted the whole leading hour — including spans BEFORE the
	// window. `snapRangeForCache` floors a 12h window to a 5-minute grid, so the
	// start was essentially never aligned and the inflation was always on.
	const recentBranch = from(Traces)
		.select(($) => ({
			sourceService: $.ServiceName,
			dbSystem: dbSystemExpr($),
			dbNamespace: dbNamespaceExpr($),
			bucketCallCount: CH.count(),
			bucketErrorCount: CH.countIf($.StatusCode.eq("Error")),
			bucketDurationSumMs: CH.sum($.Duration.div(1000000)),
			bucketMaxDurationMs: CH.max_($.Duration.div(1000000)),
			bucketEstimatedSpanCount: CH.sum($.SampleRate),
			bucketDurationQuantiles: CH.rawExpr(EDGE_TDIGEST_RAW_STATE_EXPR, EDGE_DURATION_STATE),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			// Scoped to a service (implies non-empty) or, org-wide, require a named
			// service — the hourly MV already filters `ServiceName != ''` at write
			// time, so this keeps the raw in-progress-hour branch consistent and
			// avoids phantom edges from unnamed spans.
			opts.serviceName ? $.ServiceName.eq(opts.serviceName) : $.ServiceName.neq(""),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
			edgeCondition("Timestamp"),
			$.SpanKind.in_("Client", "Producer"),
			dbSystemExpr($).neq(""),
			opts.deploymentEnv ? deploymentEnvExpr($.ResourceAttributes).eq(opts.deploymentEnv) : undefined,
		])
		.groupBy("sourceService", "dbSystem", "dbNamespace")

	return fromUnion(unionAll(hourlyBranch, recentBranch), "edges")
		.select(($) => ({
			sourceService: $.sourceService,
			dbSystem: $.dbSystem,
			dbNamespace: $.dbNamespace,
			callCount: CH.sum($.bucketCallCount),
			errorCount: CH.sum($.bucketErrorCount),
			avgDurationMs: CH.sum($.bucketDurationSumMs).div(CH.nullIf(CH.sum($.bucketCallCount), CH.lit(0))),
			maxDurationMs: CH.max_($.bucketMaxDurationMs),
			p95DurationMs: edgeP95Expr,
			estimatedSpanCount: CH.sum($.bucketEstimatedSpanCount),
		}))
		.groupBy("sourceService", "dbSystem", "dbNamespace")
		.orderBy(["callCount", "desc"])
		.limit(200)
		.format("JSON")
}

// Service ↔ database edges — scoped to one source service
//
// Same shape as `serviceDbEdgesSQL` but pre-filters both branches by
// `ServiceName = ?`. Mirrors the `serviceExternalEdgesSQL` pattern (which is
// already service-scoped).

export interface ServiceDbEdgesForServiceOpts {
	serviceName: string
	deploymentEnv?: string
}

/**
 * Typesafe-DSL builder for the service-detail page's "Databases" dependency
 * panel. Same dual-source pattern as `serviceDependenciesForServiceQuery` —
 * hourly MV + raw-traces fallback — but no topology JOIN (DB system is
 * already on the parent span as `db.system.name`).
 */
export function serviceDbEdgesForServiceQuery(opts: ServiceDbEdgesForServiceOpts) {
	return serviceDbEdgesQueryBase(opts)
}

// Service-map database query summaries
//
// Selected database drill-down ("Query Activity" + "Top Query Shapes"). Reads
// the `service_map_db_query_shapes_hourly` rollup for sealed hours and UNIONs
// raw `traces` for the in-progress hour — same dual-source pattern as
// `serviceDbEdgesSQL` — so the panel keeps true sample-weighted P50/P95 (via a
// t-digest state) without scanning raw spans + fingerprinting over the whole
// window. The query SHAPE (label + normalized key) is derived by the SQL
// fragments in `@maple/domain/tinybird/db-query-shape-sql`, shared byte-for-byte
// with the rollup MV so a shape's key is stable across the sealed/live boundary.

export interface ServiceDbQuerySummaryParams {
	readonly orgId: string
	readonly dbSystem: string
	/**
	 * Scope to one database identity (`DbNamespace`). `undefined` = unscoped
	 * (all databases of the system); `""` = the legacy/unknown node (spans that
	 * carry no identifying attribute + pre-migration rollup rows).
	 */
	readonly dbNamespace?: string
	readonly startTime: string
	readonly endTime: string
	readonly sourceService?: string
	readonly deploymentEnv?: string
	readonly bucketSeconds?: number
	readonly topN?: number
}

export interface ServiceDbQuerySummaryOutput {
	readonly queryCount: number
	readonly estimatedQueryCount: number
	readonly errorCount: number
	readonly estimatedErrorCount: number
	readonly errorRate: number
	readonly avgDurationMs: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
	readonly activeServiceCount: number
}

const ServiceDbQuerySummaryOutputSchema: CompiledQueryRowSchema<ServiceDbQuerySummaryOutput> = Schema.Struct({
	queryCount: CHNumber,
	estimatedQueryCount: CHNumber,
	errorCount: CHNumber,
	estimatedErrorCount: CHNumber,
	errorRate: CHNumber,
	avgDurationMs: CHNumberOrZero,
	p50DurationMs: CHNumber,
	p95DurationMs: CHNumber,
	activeServiceCount: CHNumber,
})

export interface ServiceDbQueryTimeseriesOutput {
	readonly bucket: string
	readonly queryCount: number
	readonly estimatedQueryCount: number
	readonly errorCount: number
	readonly errorRate: number
	readonly avgDurationMs: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
}

const ServiceDbQueryTimeseriesOutputSchema: CompiledQueryRowSchema<ServiceDbQueryTimeseriesOutput> =
	Schema.Struct({
		bucket: Schema.String,
		queryCount: CHNumber,
		estimatedQueryCount: CHNumber,
		errorCount: CHNumber,
		errorRate: CHNumber,
		avgDurationMs: CHNumberOrZero,
		p50DurationMs: CHNumber,
		p95DurationMs: CHNumber,
	})

export interface ServiceDbTopQueryOutput {
	readonly queryKey: string
	readonly queryLabel: string
	readonly sampleStatement: string
	readonly sampleService: string
	readonly serviceCount: number
	readonly queryCount: number
	readonly estimatedQueryCount: number
	readonly errorCount: number
	readonly errorRate: number
	readonly avgDurationMs: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
	readonly lastSeen: string
}

const ServiceDbTopQueryOutputSchema: CompiledQueryRowSchema<ServiceDbTopQueryOutput> = Schema.Struct({
	queryKey: Schema.String,
	queryLabel: Schema.String,
	sampleStatement: Schema.String,
	sampleService: Schema.String,
	serviceCount: CHNumber,
	queryCount: CHNumber,
	estimatedQueryCount: CHNumber,
	errorCount: CHNumber,
	errorRate: CHNumber,
	avgDurationMs: CHNumberOrZero,
	p50DurationMs: CHNumber,
	p95DurationMs: CHNumber,
	lastSeen: Schema.String,
})

// Finalized sample-weighted quantiles over raw rows — used by the sub-hour
// timeseries path (which can't be served by the hourly rollup).
const DB_DURATION_QUANTILES_EXPR =
	"quantilesTDigestWeighted(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0)))"
// The matching t-digest STATE over raw rows — its output type is identical to
// the rollup's stored `DurationQuantiles`, so the two UNION-merge cleanly.
const DB_DURATION_TDIGEST_STATE_EXPR =
	"quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0)))"

const clampBucketSeconds = (value: number | undefined): number => {
	if (!Number.isFinite(value)) return 3600
	const rounded = Math.round(value ?? 3600)
	return Math.min(24 * 60 * 60, Math.max(60, rounded))
}

const clampTopN = (value: number | undefined): number => {
	if (!Number.isFinite(value)) return 10
	const rounded = Math.round(value ?? 10)
	return Math.min(50, Math.max(1, rounded))
}

// Filters for the sealed hourly-rollup branch (service_map_db_query_shapes_hourly).
// Covers only complete hours: [startHour, endHour) — the in-progress hour comes
// from the raw branch below.
const signaturesHourlyFilters = (
	$: {
		OrgId: CH.Expr<string>
		Hour: CH.Expr<string>
		DbSystem: CH.Expr<string>
		DbNamespace: CH.Expr<string>
		ServiceName: CH.Expr<string>
		DeploymentEnv: CH.Expr<string>
	},
	params: ServiceDbQuerySummaryParams,
) => [
	$.OrgId.eq(param.string("orgId")),
	...interiorConditions($.Hour),
	$.DbSystem.eq(params.dbSystem),
	// `undefined` = unscoped; `''` is a real value (the legacy/unknown node).
	// Collapse sealed hex → sentinel so a `dbNamespace: "hyperdrive"` filter also
	// matches pre-migration rows that still carry the raw Hyperdrive config ID.
	params.dbNamespace !== undefined ? collapseHyperdriveNs($.DbNamespace).eq(params.dbNamespace) : undefined,
	params.sourceService ? $.ServiceName.eq(params.sourceService) : undefined,
	params.deploymentEnv ? $.DeploymentEnv.eq(params.deploymentEnv) : undefined,
]

// Filters for the raw `traces` branch. `scope` selects the time window:
//  - "edge":       the two PARTIAL hours at the ends of the window, the exact
//                  complement of `signaturesHourlyFilters`' interior (UNION-ed
//                  with the sealed rollup branch)
//  - "fullWindow": the whole [start, end] window (sub-hour timeseries, which
//                  the hourly rollup can't express)
// DbSystem/DbNamespace equality goes through the shared write-side coalesce
// expressions so raw-hour rows land on the same identity as sealed ones.
const serviceDbRawFilters = (
	$: {
		OrgId: CH.Expr<string>
		Timestamp: CH.Expr<string>
		SpanKind: CH.Expr<string>
		ServiceName: CH.Expr<string>
		SpanAttributes: CH.ColumnRef<"SpanAttributes", StringMap>
		ResourceAttributes: CH.ColumnRef<"ResourceAttributes", StringMap>
	},
	params: ServiceDbQuerySummaryParams,
	scope: "edge" | "fullWindow",
) => [
	$.OrgId.eq(param.string("orgId")),
	$.Timestamp.gte(CH.toDateTime(param.dateTimeString("startTime"))),
	$.Timestamp.lte(CH.toDateTime(param.dateTimeString("endTime"))),
	scope === "edge" ? edgeCondition("Timestamp") : undefined,
	$.SpanKind.in_("Client", "Producer"),
	$.ServiceName.neq(""),
	dbSystemExpr($).eq(params.dbSystem),
	// Same undefined-vs-'' semantics as `shapesHourlyFilters`.
	params.dbNamespace !== undefined ? dbNamespaceExpr($).eq(params.dbNamespace) : undefined,
	params.sourceService ? $.ServiceName.eq(params.sourceService) : undefined,
	params.deploymentEnv ? deploymentEnvExpr($.ResourceAttributes).eq(params.deploymentEnv) : undefined,
]

// Aggregate-state expressions shared by the summary/timeseries/top-queries
// builders. These stay raw: the DSL has no notion of ClickHouse `-State` /
// `-Merge` combinators, and the strings must match the rollup's stored state
// type exactly.
const UNIQ_SERVICE_STATE_EXPR = "uniqState(toString(ServiceName))"
const TDIGEST_MERGE_STATE_EXPR = "quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles)"

/** The two aggregate-state types the sealed and recent branches must agree on —
 *  opaque values an outer `-Merge` reads, never rows anyone decodes. */
const UNIQ_SERVICE_STATE = T.aggregateState("uniq", "String")
const DB_DURATION_STATE = T.aggregateState("quantilesTDigestWeighted(0.5, 0.95)", "UInt64", "UInt32")
const mergedQuantileExpr = (index: 1 | 2) =>
	CH.rawExpr(
		`if(sum(bCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bQ), ${index}) / 1000000, 0)`,
		T.float64,
	)

export function serviceDbQuerySummarySQL(
	params: ServiceDbQuerySummaryParams,
): Effect.Effect<CompiledQuery<ServiceDbQuerySummaryOutput>, QueryBuilderError> {
	// Sealed hours from the rollup; ServiceName/DurationQuantiles re-aggregated at
	// read time (the table is queried without FINAL).
	const sealed = from(ServiceMapDbQuerySignaturesHourly)
		.select(($) => ({
			bCount: CH.sum($.CallCount),
			bEst: CH.sum($.EstimatedCount),
			bErr: CH.sum($.ErrorCount),
			bEstErr: CH.sum($.EstimatedErrorCount),
			bWDur: CH.sum($.WeightedDurationSumMs),
			bSvc: CH.rawExpr(UNIQ_SERVICE_STATE_EXPR, UNIQ_SERVICE_STATE),
			bQ: CH.rawExpr(TDIGEST_MERGE_STATE_EXPR, DB_DURATION_STATE),
		}))
		.where(($) => signaturesHourlyFilters($, params))
	const recent = from(Traces)
		.select(($) => ({
			bCount: CH.count(),
			bEst: CH.sum($.SampleRate),
			bErr: CH.countIf($.StatusCode.eq("Error")),
			bEstErr: CH.sumIf($.SampleRate, $.StatusCode.eq("Error")),
			bWDur: CH.sum(_toFloat64($.Duration).mul($.SampleRate).div(1000000)),
			bSvc: CH.rawExpr(UNIQ_SERVICE_STATE_EXPR, UNIQ_SERVICE_STATE),
			bQ: CH.rawExpr(DB_DURATION_TDIGEST_STATE_EXPR, DB_DURATION_STATE),
		}))
		.where(($) => serviceDbRawFilters($, params, "edge"))

	const query = fromUnion(unionAll(sealed, recent), "branches")
		.select(($) => ({
			queryCount: CH.sum($.bCount),
			estimatedQueryCount: CH.sum($.bEst),
			errorCount: CH.sum($.bErr),
			estimatedErrorCount: CH.sum($.bEstErr),
			errorRate: CH.if_(CH.sum($.bEst).gt(0), CH.sum($.bEstErr).div(CH.sum($.bEst)), CH.lit(0)),
			avgDurationMs: CH.if_(CH.sum($.bEst).gt(0), CH.sum($.bWDur).div(CH.sum($.bEst)), CH.lit(0)),
			p50DurationMs: mergedQuantileExpr(1),
			p95DurationMs: mergedQuantileExpr(2),
			activeServiceCount: CH.rawExpr("uniqMerge(bSvc)", T.uint64),
		}))
		.format("JSON")

	return compile(query, params, { rowSchema: ServiceDbQuerySummaryOutputSchema })
}

export function serviceDbQueryTimeseriesSQL(
	params: ServiceDbQuerySummaryParams,
): Effect.Effect<CompiledQuery<ServiceDbQueryTimeseriesOutput>, QueryBuilderError> {
	const bucketSeconds = clampBucketSeconds(params.bucketSeconds)

	// Sub-hour buckets (short windows — pickDbSummaryBucketSeconds gives 5/15 min
	// for ≤24h) can't be served by the hourly rollup, but those scans are cheap;
	// read raw `traces` directly for the full window.
	if (bucketSeconds < 3600) {
		const query = from(Traces)
			.select(($) => ({
				bucket: CH.toStartOfInterval(CH.toDateTime($.Timestamp), bucketSeconds),
				queryCount: CH.count(),
				estimatedQueryCount: CH.sum($.SampleRate),
				errorCount: CH.countIf($.StatusCode.eq("Error")),
				errorRate: CH.if_(
					CH.sum($.SampleRate).gt(0),
					CH.sumIf($.SampleRate, $.StatusCode.eq("Error")).div(CH.sum($.SampleRate)),
					CH.lit(0),
				),
				avgDurationMs: CH.if_(
					CH.sum($.SampleRate).gt(0),
					CH.sum(_toFloat64($.Duration).mul($.SampleRate)).div(CH.sum($.SampleRate)).div(1000000),
					CH.lit(0),
				),
				p50DurationMs: CH.rawExpr(
					`if(count() > 0, arrayElement(${DB_DURATION_QUANTILES_EXPR}, 1) / 1000000, 0)`,
					T.float64,
				),
				p95DurationMs: CH.rawExpr(
					`if(count() > 0, arrayElement(${DB_DURATION_QUANTILES_EXPR}, 2) / 1000000, 0)`,
					T.float64,
				),
			}))
			.where(($) => serviceDbRawFilters($, params, "fullWindow"))
			.groupBy("bucket")
			.orderBy(["bucket", "asc"])
			.limit(2000)
			.format("JSON")
		return compile(query, params, { rowSchema: ServiceDbQueryTimeseriesOutputSchema })
	}

	// Hour-aligned buckets (≥1h — pickDbSummaryBucketSeconds gives 1h/6h for >24h):
	// sealed rollup hours UNION the in-progress hour from raw traces.
	const sealed = from(ServiceMapDbQuerySignaturesHourly)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Hour, bucketSeconds),
			bCount: CH.sum($.CallCount),
			bEst: CH.sum($.EstimatedCount),
			bErr: CH.sum($.ErrorCount),
			bEstErr: CH.sum($.EstimatedErrorCount),
			bWDur: CH.sum($.WeightedDurationSumMs),
			bQ: CH.rawExpr(TDIGEST_MERGE_STATE_EXPR, DB_DURATION_STATE),
		}))
		.where(($) => signaturesHourlyFilters($, params))
		.groupBy("bucket")
	const recent = from(Traces)
		.select(($) => ({
			bucket: CH.toStartOfInterval(CH.toDateTime($.Timestamp), bucketSeconds),
			bCount: CH.count(),
			bEst: CH.sum($.SampleRate),
			bErr: CH.countIf($.StatusCode.eq("Error")),
			bEstErr: CH.sumIf($.SampleRate, $.StatusCode.eq("Error")),
			bWDur: CH.sum(_toFloat64($.Duration).mul($.SampleRate).div(1000000)),
			bQ: CH.rawExpr(DB_DURATION_TDIGEST_STATE_EXPR, DB_DURATION_STATE),
		}))
		.where(($) => serviceDbRawFilters($, params, "edge"))
		.groupBy("bucket")

	const query = fromUnion(unionAll(sealed, recent), "buckets")
		.select(($) => ({
			bucket: $.bucket,
			queryCount: CH.sum($.bCount),
			estimatedQueryCount: CH.sum($.bEst),
			errorCount: CH.sum($.bErr),
			errorRate: CH.if_(CH.sum($.bEst).gt(0), CH.sum($.bEstErr).div(CH.sum($.bEst)), CH.lit(0)),
			avgDurationMs: CH.if_(CH.sum($.bEst).gt(0), CH.sum($.bWDur).div(CH.sum($.bEst)), CH.lit(0)),
			p50DurationMs: mergedQuantileExpr(1),
			p95DurationMs: mergedQuantileExpr(2),
		}))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(2000)
		.format("JSON")

	return compile(query, params, { rowSchema: ServiceDbQueryTimeseriesOutputSchema })
}

export function serviceDbTopQueriesSQL(
	params: ServiceDbQuerySummaryParams,
): Effect.Effect<CompiledQuery<ServiceDbTopQueryOutput>, QueryBuilderError> {
	const topN = clampTopN(params.topN)

	// Sealed rollup shapes — pre-computed QueryKey/QueryLabel, so no per-row
	// fingerprinting on this branch.
	const sealed = from(ServiceMapDbQuerySignaturesHourly)
		.select(($) => ({
			queryKey: $.QueryKey,
			bLabel: CH.any_($.QueryLabel),
			bStatement: CH.any_($.SampleStatement),
			bSampleService: CH.any_(CH.toString_($.ServiceName)),
			bServices: CH.rawExpr(UNIQ_SERVICE_STATE_EXPR, UNIQ_SERVICE_STATE),
			bCount: CH.sum($.CallCount),
			bEst: CH.sum($.EstimatedCount),
			bErr: CH.sum($.ErrorCount),
			bEstErr: CH.sum($.EstimatedErrorCount),
			bWDur: CH.sum($.WeightedDurationSumMs),
			bQ: CH.rawExpr(TDIGEST_MERGE_STATE_EXPR, DB_DURATION_STATE),
			bLastSeen: CH.max_($.Hour),
		}))
		.where(($) => signaturesHourlyFilters($, params))
		.groupBy("queryKey")
	// In-progress hour — derives QueryKey/QueryLabel from the SAME shared SQL the
	// rollup MV uses (raw exprs, no DSL equivalent), so a shape's key matches
	// across the sealed/live boundary.
	const recent = from(Traces)
		.select(($) => ({
			queryKey: CH.rawExpr(DB_QUERY_KEY_SQL, T.string),
			bLabel: CH.rawExpr(`any(substring(${DB_QUERY_LABEL_SQL}, 1, 220))`, T.string),
			bStatement: CH.rawExpr(`any(substring(${DB_STATEMENT_SQL}, 1, 1000))`, T.string),
			bSampleService: CH.any_(CH.toString_($.ServiceName)),
			bServices: CH.rawExpr(UNIQ_SERVICE_STATE_EXPR, UNIQ_SERVICE_STATE),
			bCount: CH.count(),
			bEst: CH.sum($.SampleRate),
			bErr: CH.countIf($.StatusCode.eq("Error")),
			bEstErr: CH.sumIf($.SampleRate, $.StatusCode.eq("Error")),
			bWDur: CH.sum(_toFloat64($.Duration).mul($.SampleRate).div(1000000)),
			bQ: CH.rawExpr(DB_DURATION_TDIGEST_STATE_EXPR, DB_DURATION_STATE),
			bLastSeen: CH.max_(CH.toDateTime($.Timestamp)),
		}))
		.where(($) => serviceDbRawFilters($, params, "edge"))
		.groupBy("queryKey")

	// Re-aggregate the two branches per shape.
	const merged = fromUnion(unionAll(sealed, recent), "shapes")
		.select(($) => ({
			queryKey: $.queryKey,
			fallbackLabel: CH.any_($.bLabel),
			sampleStatement: CH.anyIf($.bStatement, $.bStatement.neq("")),
			sampleService: CH.any_($.bSampleService),
			serviceCount: CH.rawExpr("uniqMerge(bServices)", T.uint64),
			queryCount: CH.sum($.bCount),
			estimatedQueryCount: CH.sum($.bEst),
			errorCount: CH.sum($.bErr),
			errorRate: CH.if_(CH.sum($.bEst).gt(0), CH.sum($.bEstErr).div(CH.sum($.bEst)), CH.lit(0)),
			avgDurationMs: CH.if_(CH.sum($.bEst).gt(0), CH.sum($.bWDur).div(CH.sum($.bEst)), CH.lit(0)),
			p50DurationMs: mergedQuantileExpr(1),
			p95DurationMs: mergedQuantileExpr(2),
			lastSeen: CH.max_($.bLastSeen),
		}))
		.groupBy("queryKey")

	// Outer wrapper derives the display label from the (literal-stripped) sample
	// statement when present, so co-located shapes — e.g. several different
	// queries that all carry the generic db.operation.name="execute" +
	// db.collection.name="subscriptions" — show their distinct SQL instead of one
	// indistinct "execute subscriptions" row. Falls back to the derived label for
	// shapes that carry no statement text (Redis ops, connection spans). Done at
	// read time off the rollup's stored SampleStatement, so this needs no MV change.
	const query = fromQuery(merged, "shape")
		.select(($) => ({
			queryKey: $.queryKey,
			queryLabel: CH.rawExpr(
				`if(sampleStatement != '', substring(${presentableStatementSql("sampleStatement")}, 1, 220), fallbackLabel)`,
				T.string,
			),
			sampleStatement: $.sampleStatement,
			sampleService: $.sampleService,
			serviceCount: $.serviceCount,
			queryCount: $.queryCount,
			estimatedQueryCount: $.estimatedQueryCount,
			errorCount: $.errorCount,
			errorRate: $.errorRate,
			avgDurationMs: $.avgDurationMs,
			p50DurationMs: $.p50DurationMs,
			p95DurationMs: $.p95DurationMs,
			lastSeen: $.lastSeen,
		}))
		.orderBy(["estimatedQueryCount", "desc"])
		.limit(topN)
		.format("JSON")

	return compile(query, params, { rowSchema: ServiceDbTopQueryOutputSchema })
}

// Service ↔ external target edges (http / messaging / rpc)
//
// Surfaces non-DB Client/Producer outbound calls — HTTP endpoints, message
// queues, RPC targets — as a unified inventory for the service-detail page's
// "Dependencies" tab. Mirrors the DB-edges pattern: hourly MV (sealed buckets)
// UNION ALL with raw-traces fallback (in-progress hour), then de-duplicated
// against `service_address_resolutions_hourly` so HTTP targets whose address
// resolves to a known internal service (in the same window) drop out — those
// already appear under "Services" via `serviceDependenciesSQL`.

export interface ServiceExternalEdgesOpts {
	deploymentEnv?: string
	serviceName: string
}

export interface ServiceExternalEdgesOutput {
	readonly sourceService: string
	readonly targetType: "http" | "messaging" | "rpc"
	readonly targetSystem: string
	readonly targetName: string
	readonly callCount: number
	readonly errorCount: number
	readonly avgDurationMs: number
	/**
	 * The window's slowest call. Kept beside `p95DurationMs` rather than replaced:
	 * it is the only latency figure available for buckets sealed before migration
	 * 0022, and it is a genuinely useful outlier signal in its own right. Present
	 * it AS a max wherever it is shown.
	 */
	readonly maxDurationMs: number
	/** See `ServiceDbEdgesOutput.p95DurationMs` — same state, same 0-means-absent. */
	readonly p95DurationMs: number
	readonly estimatedSpanCount: number
}

const ServiceExternalEdgesOutputSchema: CompiledQueryRowSchema<ServiceExternalEdgesOutput> = Schema.Struct({
	sourceService: Schema.String,
	targetType: Schema.Literals(["http", "messaging", "rpc"]),
	targetSystem: Schema.String,
	targetName: Schema.String,
	callCount: CHNumber,
	errorCount: CHNumber,
	avgDurationMs: CHNumberOrZero,
	maxDurationMs: CHNumber,
	p95DurationMs: CHNumberOrZero,
	estimatedSpanCount: CHNumber,
})

export function serviceExternalEdgesSQL(
	opts: ServiceExternalEdgesOpts,
	params: { orgId: string; startTime: string; endTime: string },
): Effect.Effect<CompiledQuery<ServiceExternalEdgesOutput>, QueryBuilderError> {
	const startHour = CH.toStartOfHour(CH.toDateTime(param.dateTimeString("startTime")))
	const endHour = CH.toStartOfHour(CH.toDateTime(param.dateTimeString("endTime")))

	// Hourly branch: sealed buckets from the MV-fed table. Carries `bucket*`
	// aliases so the outer aggregate can't collide with inner ones (same
	// nested-aggregate optimizer gotcha as `serviceDbEdgesSQL`).
	const hourlyEdges = from(ServiceExternalEdgesHourly)
		.select(($) => ({
			sourceService: $.ServiceName,
			targetType: $.TargetType,
			targetSystem: $.TargetSystem,
			targetName: $.TargetName,
			bucketCallCount: CH.sum($.CallCount),
			bucketErrorCount: CH.sum($.ErrorCount),
			bucketDurationSumMs: CH.sum($.DurationSumMs),
			bucketMaxDurationMs: CH.max_($.MaxDurationMs),
			bucketEstimatedSpanCount: CH.sum(
				CH.if_($.SampleRateSum.gt(0), $.SampleRateSum, _toFloat64($.CallCount)),
			),
			bucketDurationQuantiles: CH.rawExpr(EDGE_TDIGEST_MERGE_STATE_EXPR, EDGE_DURATION_STATE),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			...interiorConditions($.Hour),
			$.TargetName.neq(""),
			opts.deploymentEnv ? $.DeploymentEnv.eq(opts.deploymentEnv) : undefined,
		])
		.groupBy("sourceService", "targetType", "targetSystem", "targetName")

	// Recent branch: raw `traces` for the two PARTIAL hours at the ends of the
	// window — the exact complement of the hourly interior above. Mirrors the
	// `multiIf` precedence the MV uses (messaging > rpc > http) so both branches
	// produce identical row shapes for the same span.
	const recentEdges = from(Traces)
		.select(($) => {
			const attr = (key: string) => $.SpanAttributes.get(key)
			const destination = messagingDestinationExpr($.SpanAttributes)
			const isMessaging = destination.neq("").or(attr("messaging.system").neq(""))
			const isRpc = attr("rpc.service").neq("").or(attr("rpc.system").neq(""))
			return {
				sourceService: $.ServiceName,
				targetType: CH.multiIf(
					[
						[isMessaging, CH.lit("messaging")],
						[isRpc, CH.lit("rpc")],
					],
					CH.lit("http"),
				),
				targetSystem: CH.multiIf(
					[
						[isMessaging, attr("messaging.system")],
						[isRpc, attr("rpc.system")],
					],
					CH.lit(""),
				),
				targetName: CH.multiIf(
					[
						[isMessaging, CH.if_(destination.neq(""), destination, attr("messaging.system"))],
						[isRpc, CH.if_(attr("rpc.service").neq(""), attr("rpc.service"), attr("rpc.system"))],
					],
					CH.if_(
						attr("server.address").neq(""),
						attr("server.address"),
						CH.if_(attr("http.host").neq(""), attr("http.host"), attr("url.authority")),
					),
				),
				bucketCallCount: CH.count(),
				bucketErrorCount: CH.countIf($.StatusCode.eq("Error")),
				bucketDurationSumMs: CH.sum($.Duration.div(1000000)),
				bucketMaxDurationMs: CH.max_($.Duration.div(1000000)),
				bucketEstimatedSpanCount: CH.sum($.SampleRate),
				bucketDurationQuantiles: CH.rawExpr(EDGE_TDIGEST_RAW_STATE_EXPR, EDGE_DURATION_STATE),
			}
		})
		.where(($) => {
			const attr = (key: string) => $.SpanAttributes.get(key)
			return [
				$.OrgId.eq(param.string("orgId")),
				$.ServiceName.eq(opts.serviceName),
				$.Timestamp.gte(param.dateTimeString("startTime")),
				$.Timestamp.lte(param.dateTimeString("endTime")),
				edgeCondition("Timestamp"),
				CH.inList($.SpanKind, ["Client", "Producer"]),
				attr("db.system.name").eq(""),
				attr("server.address")
					.neq("")
					.or(attr("http.host").neq(""))
					.or(attr("url.authority").neq(""))
					.or(messagingDestinationExpr($.SpanAttributes).neq(""))
					.or(attr("messaging.system").neq(""))
					.or(attr("rpc.service").neq(""))
					.or(attr("rpc.system").neq("")),
				opts.deploymentEnv
					? deploymentEnvExpr($.ResourceAttributes).eq(opts.deploymentEnv)
					: undefined,
			]
		})
		.groupBy("sourceService", "targetType", "targetSystem", "targetName")
		// Deliberately HAVING, not WHERE: `targetName` is a computed output alias,
		// and although it happens to be a pure function of grouped columns today,
		// a future editor shouldn't have to re-derive that to know this is safe.
		.having(() => [CH.dynamicColumn<string>("targetName").neq("")])

	// Addresses this service was observed calling that resolve to a known
	// internal service in the same window. `GROUP BY` is the DSL's SELECT DISTINCT.
	const internalResolutions = from(ServiceAddressResolutionsHourly)
		.select(($) => ({ ParentServerAddress: $.ParentServerAddress }))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.SourceService.eq(opts.serviceName),
			$.Hour.gte(startHour),
			$.Hour.lt(endHour),
			$.ParentServerAddress.neq(""),
			opts.deploymentEnv ? $.DeploymentEnv.eq(opts.deploymentEnv) : undefined,
		])
		.groupBy("ParentServerAddress")

	// Internal-service overlap suppression: drop HTTP rows whose `targetName`
	// resolves to a known internal service in the same window — those already
	// appear under "Services" via `serviceDependenciesSQL`. Messaging and RPC
	// pass through unchanged (a queue or RPC service is never the same identity
	// as an internal service name).
	//
	// The outer query carries no `OrgId` predicate: its scope is derived from
	// both union branches being scoped. The anti-join subquery contributes
	// nothing to that — see `inSubquery`.
	const query = fromUnion(unionAll(hourlyEdges, recentEdges), "edges")
		.select(($) => ({
			sourceService: $.sourceService,
			targetType: $.targetType,
			targetSystem: $.targetSystem,
			targetName: $.targetName,
			callCount: CH.sum($.bucketCallCount),
			errorCount: CH.sum($.bucketErrorCount),
			avgDurationMs: CH.sum($.bucketDurationSumMs).div(CH.nullIf(CH.sum($.bucketCallCount), CH.lit(0))),
			maxDurationMs: CH.max_($.bucketMaxDurationMs),
			p95DurationMs: edgeP95Expr,
			estimatedSpanCount: CH.sum($.bucketEstimatedSpanCount),
		}))
		.where(($) => [CH.not($.targetType.eq("http").and(inSubquery($.targetName, internalResolutions)))])
		.groupBy("sourceService", "targetType", "targetSystem", "targetName")
		.orderBy(["callCount", "desc"])
		.limit(200)
		.format("JSON")

	return compile(query, params, { rowSchema: ServiceExternalEdgesOutputSchema })
}

// Service hosting platform
//
// Per-service rollup of the OTel resource attributes that identify where a
// service runs. The caller derives a single `Platform` label from these raw
// values (see apps/web/src/api/tinybird/service-map.ts).
//
// Reads from `service_platforms_hourly` (populated by
// `service_platforms_hourly_mv`). The MV uses SimpleAggregateFunction("max")
// on each attribute string, so empty strings sort first and any non-empty
// value wins on merge — exactly the "did any span in this window carry this
// attribute" semantics the platform classifier needs. `k8s.pod.name` /
// `k8s.deployment.name` are required for the kubernetes signal because
// `k8s.cluster.name` can leak onto in-transit spans via the otel-gateway.

export interface ServicePlatformsOpts {
	deploymentEnv?: string
}

export interface ServicePlatformsOutput {
	readonly serviceName: string
	readonly k8sCluster: string
	readonly k8sPodName: string
	readonly k8sDeploymentName: string
	readonly cloudPlatform: string
	readonly cloudProvider: string
	readonly faasName: string
	readonly mapleSdkType: string
	readonly processRuntimeName: string
}

export function servicePlatformsSQL(
	opts: ServicePlatformsOpts,
	params: { orgId: string; startTime: string; endTime: string },
): Effect.Effect<CompiledQuery<ServicePlatformsOutput>, QueryBuilderError> {
	const query = from(ServicePlatformsHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			// `max()` on a SimpleAggregateFunction(max, String) column merges
			// non-empty strings to win over empty ones — the "did any span in
			// this window carry this attribute" semantics the platform
			// classifier needs.
			k8sCluster: CH.max_($.K8sCluster),
			k8sPodName: CH.max_($.K8sPodName),
			k8sDeploymentName: CH.max_($.K8sDeploymentName),
			cloudPlatform: CH.max_($.CloudPlatform),
			cloudProvider: CH.max_($.CloudProvider),
			faasName: CH.max_($.FaasName),
			mapleSdkType: CH.max_($.MapleSdkType),
			processRuntimeName: CH.max_($.ProcessRuntimeName),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(CH.toStartOfHour(CH.toDateTime(param.dateTimeString("startTime")))),
			$.Hour.lte(param.dateTimeString("endTime")),
			$.ServiceName.neq(""),
			opts.deploymentEnv ? $.DeploymentEnv.eq(opts.deploymentEnv) : undefined,
		])
		.groupBy("serviceName")
		.limit(500)
		.format("JSON")

	return compile(query, {
		orgId: params.orgId,
		startTime: params.startTime,
		endTime: params.endTime,
	})
}

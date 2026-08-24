// Typed Services Queries
//
// DSL-based query definitions for service overview, releases, apdex, and usage.

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import {
	from,
	fromQuery,
	fromUnion,
	type CHQuery,
	type ColumnAccessor,
	type CompiledQueryRowSchema,
} from "@maple-dev/clickhouse-builder"
import { unionAll, type CHUnionQuery } from "@maple-dev/clickhouse-builder"
import type { ColumnDefs } from "@maple-dev/clickhouse-builder/types"
import {
	ServiceOverviewHourly,
	ServiceOverviewMinutely,
	ServiceOverviewSpans,
	ServiceUsage,
	TracesAggregatesHourly,
} from "../tables"
import { CHNumber } from "../schema"
import { apdexExprs, serviceOverviewWhereConditions, hourFloor, type FacetOutput } from "./query-helpers"
import { edgeCondition, hourGrain, interiorConditions, minuteGrain } from "./rollup-splice"

// Service overview

const SERVICE_RAW_DURATION_STATE = "quantilesTDigestState(0.5, 0.95, 0.99)(Duration)"
const SERVICE_ROLLUP_DURATION_STATE = "quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles)"

interface ServiceWindowFilters {
	readonly serviceName?: string
	readonly environments?: readonly string[]
	readonly namespaces?: readonly string[]
	readonly commitShas?: readonly string[]
}

/**
 * The bucket grain a service-history stream is reconstructed at.
 *
 * `"hour"` is the two-tier splice: raw partial boundary hours + the hourly
 * rollup's interior. Correct for any query that aggregates the whole window, and
 * for timeseries whose bucket is a whole multiple of an hour.
 *
 * `"minute"` adds the minutely rollup between them, so a sub-hour bucket does
 * not have to fall back to scanning raw spans for the entire window. Callers
 * that bucket the result with `toStartOfInterval` MUST use this grain whenever
 * `bucketSeconds` is not a multiple of 3600 — an hour-floored row landing in a
 * sub-hour bucket puts a whole hour of traffic on the bucket containing `:00`
 * and leaves the rest of the hour reading zero.
 */
export type OverviewGrain = "hour" | "minute"

export interface ServiceWindowTiers {
	readonly grain?: OverviewGrain
	/**
	 * Include the hourly tier. Must be `false` when the caller buckets the result
	 * with a `bucketSeconds` that is not a whole multiple of 3600 — an hourly row
	 * carries no sub-hour position, so `toStartOfInterval` would pile the whole
	 * hour onto the bucket containing `:00`.
	 */
	readonly includeHourly?: boolean
}

/**
 * Tier selection for a caller that buckets the stream by `bucketSeconds`.
 *
 * Returns `"raw"` for buckets finer than a minute: no rollup tier can place a
 * row inside a minute, so those callers must scan the entry-point projection
 * directly (and are bounded by its 30-day retention).
 */
export function serviceWindowTiersForBucket(bucketSeconds: number): ServiceWindowTiers | "raw" {
	if (bucketSeconds < 60 || bucketSeconds % 60 !== 0) return "raw"
	if (bucketSeconds % 3600 === 0) return { grain: "hour", includeHourly: true }
	return { grain: "minute", includeHourly: false }
}

const SERVICE_WINDOW_GROUP_KEYS = [
	"bBucket",
	"bServiceName",
	"bServiceNamespace",
	"bEnvironment",
	"bCommitSha",
] as const

/**
 * One logical service-history stream: exact raw rows for the two partial
 * boundary buckets, plus pre-aggregated states for every complete interior
 * bucket. The raw projection is intentionally retained for only 30 days; an old
 * partial first bucket can therefore be absent while all reconstructible full
 * buckets remain exact.
 *
 * The tiers tile the window exactly once. At `"minute"` grain, with the window
 * `10:30:30 → 14:15:30`: raw covers `[10:30:30, 10:31) ∪ [14:15, 14:15:30]`,
 * minutely covers `[10:31, 14:15) \ [11:00, 14:00)`, hourly covers
 * `[11:00, 14:00)`. Disjoint, and their union is the window — the same argument
 * `serviceOperationsSummaryQuery` rests on, using the same two helpers.
 */
function serviceOverviewWindows(filters: ServiceWindowFilters, tiers: ServiceWindowTiers = {}) {
	const grain = tiers.grain ?? "hour"
	const includeHourly = tiers.includeHourly ?? true
	const rollupFilters = <
		A extends {
			OrgId: CH.Expr<string>
			ServiceName: CH.Expr<string>
			DeploymentEnv: CH.Expr<string>
			ServiceNamespace: CH.Expr<string>
			CommitSha: CH.Expr<string>
		},
	>(
		$: A,
	) => [
		$.OrgId.eq(param.string("orgId")),
		CH.when(filters.serviceName, (value: string) => $.ServiceName.eq(value)),
		filters.environments?.length ? CH.inList($.DeploymentEnv, filters.environments) : undefined,
		filters.namespaces?.length ? CH.inList($.ServiceNamespace, filters.namespaces) : undefined,
		filters.commitShas?.length ? CH.inList($.CommitSha, filters.commitShas) : undefined,
	]

	const rawEdges = from(ServiceOverviewSpans)
		.select(($) => ({
			bBucket: grain === "minute" ? CH.toStartOfMinute($.Timestamp) : CH.toStartOfHour($.Timestamp),
			bServiceName: $.ServiceName,
			bServiceNamespace: $.ServiceNamespace,
			bEnvironment: $.DeploymentEnv,
			bCommitSha: $.CommitSha,
			bSpanCount: CH.count(),
			bEstimatedSpanCount: CH.sum($.SampleRate),
			bErrorCount: CH.countIf($.StatusCode.eq("Error")),
			bEstimatedErrorCount: CH.sumIf($.SampleRate, $.StatusCode.eq("Error")),
			bDurationSum: CH.sum(CH.rawExpr<number>("toFloat64(Duration)")),
			bDurationQuantiles: CH.rawExpr<string>(SERVICE_RAW_DURATION_STATE),
			bFirstSeen: CH.min_($.Timestamp),
			bApdexSatisfiedCount: CH.countIf($.StatusCode.neq("Error").and($.Duration.lt(500_000_000))),
			bApdexToleratingCount: CH.countIf(
				$.StatusCode.neq("Error").and($.Duration.gte(500_000_000)).and($.Duration.lt(2_000_000_000)),
			),
		}))
		.where(($) => [
			...serviceOverviewWhereConditions($, filters),
			grain === "minute" ? edgeCondition("Timestamp", minuteGrain) : edgeCondition("Timestamp"),
		])
		.groupBy(...SERVICE_WINDOW_GROUP_KEYS)

	const hourlyInterior = from(ServiceOverviewHourly)
		.select(($) => ({
			bBucket: $.Hour,
			bServiceName: $.ServiceName,
			bServiceNamespace: $.ServiceNamespace,
			bEnvironment: $.DeploymentEnv,
			bCommitSha: $.CommitSha,
			bSpanCount: CH.sum($.SpanCount),
			bEstimatedSpanCount: CH.sum($.EstimatedSpanCount),
			bErrorCount: CH.sum($.ErrorCount),
			bEstimatedErrorCount: CH.sum($.EstimatedErrorCount),
			bDurationSum: CH.sum($.DurationSum),
			bDurationQuantiles: CH.rawExpr<string>(SERVICE_ROLLUP_DURATION_STATE),
			bFirstSeen: CH.min_($.FirstSeen),
			bApdexSatisfiedCount: CH.sum($.ApdexSatisfiedCount),
			bApdexToleratingCount: CH.sum($.ApdexToleratingCount),
		}))
		.where(($) => [...rollupFilters($), ...interiorConditions($.Hour)])
		.groupBy(...SERVICE_WINDOW_GROUP_KEYS)

	if (grain === "hour") {
		if (!includeHourly) {
			throw new Error("serviceOverviewWindows: hour grain requires the hourly tier")
		}
		return fromUnion(unionAll(rawEdges, hourlyInterior), "service_windows")
	}

	// With the hourly tier present, this reads only the sub-hour remainder at each
	// end of the hourly interior — `edgeCondition("Minute", hourGrain)` is exactly
	// the complement of the hourly branch's predicate, so the two never overlap.
	// Without it, the minute tier covers the whole interior on its own, and the
	// window is bounded by this table's 90-day retention rather than the hourly
	// table's year.
	const minutelyInterior = from(ServiceOverviewMinutely)
		.select(($) => ({
			bBucket: $.Minute,
			bServiceName: $.ServiceName,
			bServiceNamespace: $.ServiceNamespace,
			bEnvironment: $.DeploymentEnv,
			bCommitSha: $.CommitSha,
			bSpanCount: CH.sum($.SpanCount),
			bEstimatedSpanCount: CH.sum($.EstimatedSpanCount),
			bErrorCount: CH.sum($.ErrorCount),
			bEstimatedErrorCount: CH.sum($.EstimatedErrorCount),
			bDurationSum: CH.sum($.DurationSum),
			bDurationQuantiles: CH.rawExpr<string>(SERVICE_ROLLUP_DURATION_STATE),
			bFirstSeen: CH.min_($.FirstSeen),
			bApdexSatisfiedCount: CH.sum($.ApdexSatisfiedCount),
			bApdexToleratingCount: CH.sum($.ApdexToleratingCount),
		}))
		.where(($) => [
			...rollupFilters($),
			...interiorConditions($.Minute, minuteGrain),
			includeHourly ? edgeCondition("Minute", hourGrain) : undefined,
		])
		.groupBy(...SERVICE_WINDOW_GROUP_KEYS)

	return includeHourly
		? fromUnion(unionAll(rawEdges, minutelyInterior, hourlyInterior), "service_windows")
		: fromUnion(unionAll(rawEdges, minutelyInterior), "service_windows")
}

export interface ServiceOverviewOpts {
	environments?: readonly string[]
	namespaces?: readonly string[]
	commitShas?: readonly string[]
	serviceName?: string
	limit?: number
}

/**
 * One commit's slice of a (service, environment) row: `[sha, spanCount,
 * errorCount, firstSeen]`.
 *
 * A positional tuple because that is how ClickHouse serializes `tuple(...)` in
 * `FORMAT JSON` — a nested array, not an object.
 */
export type ServiceCommitTuple = readonly [
	commitSha: string,
	spanCount: number,
	errorCount: number,
	firstSeen: string,
]

export interface ServiceOverviewOutput {
	readonly serviceName: string
	readonly serviceNamespace: string
	readonly environment: string
	readonly throughput: number
	readonly errorCount: number
	readonly estimatedErrorCount: number
	readonly spanCount: number
	readonly p50LatencyMs: number
	readonly p95LatencyMs: number
	readonly p99LatencyMs: number
	readonly estimatedSpanCount: number
	readonly firstSeen: string
	/** Sorted by span count descending, capped at {@link SERVICE_OVERVIEW_COMMIT_CAP}. */
	readonly commits: readonly ServiceCommitTuple[]
}

export const serviceOverviewRowSchema = Schema.Struct({
	serviceName: Schema.String,
	serviceNamespace: Schema.String,
	environment: Schema.String,
	throughput: CHNumber,
	errorCount: CHNumber,
	estimatedErrorCount: CHNumber,
	spanCount: CHNumber,
	p50LatencyMs: CHNumber,
	p95LatencyMs: CHNumber,
	p99LatencyMs: CHNumber,
	estimatedSpanCount: CHNumber,
	firstSeen: Schema.String,
	// `CHNumber`, never `Schema.Number`: the counts are UInt64, and a
	// gateway/readonly cluster that refuses `output_format_json_quote_64bit_integers=0`
	// returns them as quoted strings.
	commits: Schema.Array(Schema.Tuple([Schema.String, CHNumber, CHNumber, Schema.String])),
}) satisfies CompiledQueryRowSchema<ServiceOverviewOutput>

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
	return serviceOverviewWindows({
		serviceName: opts.serviceName,
		environments: opts.deploymentEnvironment === undefined ? undefined : [opts.deploymentEnvironment],
		namespaces: opts.serviceNamespace === undefined ? undefined : [opts.serviceNamespace],
	})
		.select(($) => ({
			serviceName: $.bServiceName,
			serviceNamespaces: CH.rawExpr<readonly string[]>(
				"arraySort(arrayFilter(x -> x != '', arrayDistinct(groupArray(bServiceNamespace))))",
			),
			deploymentEnvironments: CH.rawExpr<readonly string[]>(
				"arraySort(arrayFilter(x -> x != '', arrayDistinct(groupArray(bEnvironment))))",
			),
			spanCount: CH.sum($.bSpanCount),
			errorCount: CH.sum($.bErrorCount),
			estimatedErrorCount: CH.sum($.bEstimatedErrorCount),
			estimatedSpanCount: CH.sum($.bEstimatedSpanCount),
			p50LatencyMs: CH.rawExpr<number>(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000",
			),
			p95LatencyMs: CH.rawExpr<number>(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000",
			),
			p99LatencyMs: CH.rawExpr<number>(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000",
			),
		}))
		.groupBy("serviceName")
		.orderBy(["estimatedSpanCount", "desc"], ["serviceName", "asc"])
		.limit(opts.limit ?? 20)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

/**
 * At most this many commits per (service, environment) row.
 *
 * Not optional. A service with a high deploy frequency can accumulate thousands
 * of distinct SHAs inside a long window, and an uncapped `groupArray` would put
 * every one of them in a single row of the services-list response.
 */
const SERVICE_OVERVIEW_COMMIT_CAP = 20

/**
 * Services-list overview, collapsed to the grain the UI actually renders.
 *
 * Two levels rather than one. The inner level keeps the commit dimension so the
 * per-commit breakdown survives; the outer level collapses namespace variants
 * and commits into one row per (service, environment) — the identity the web app
 * routes and filters by.
 *
 * The collapse is done here rather than in the browser for two reasons:
 *
 *  - **Quantiles.** The client used to take a span-count-weighted MEAN of the
 *    per-commit p50/p95/p99. A weighted mean of quantiles is not a quantile;
 *    with one namespace carrying 10x the spans and 10x the latency it is not
 *    even close. The tDigest states are right here, so merge them.
 *  - **Truncation.** The old `LIMIT 100` applied to
 *    (service, namespace, env, sha) rows, so a handful of frequently-deployed
 *    services could consume the whole budget and silently drop other services
 *    off the list entirely. The limit now applies to the rendered grain.
 */
export function serviceOverviewQuery(opts: ServiceOverviewOpts) {
	const commitRows = serviceOverviewWindows(opts)
		.select(($) => ({
			cServiceName: $.bServiceName,
			cServiceNamespace: $.bServiceNamespace,
			cEnvironment: $.bEnvironment,
			cCommitSha: $.bCommitSha,
			cSpanCount: CH.sum($.bSpanCount),
			cErrorCount: CH.sum($.bErrorCount),
			cEstimatedErrorCount: CH.sum($.bEstimatedErrorCount),
			// Per-span weighted sum: each row's `SampleRate` is 1.0 for unsampled
			// rows or `1 / acceptanceProbability` for spans carrying a `th:` value.
			// Replaces the broken `sampledSpanCount * dominantWeight` approximation.
			cEstimatedSpanCount: CH.sum($.bEstimatedSpanCount),
			// Carried as an unfinalized state so the outer level can merge it. A
			// finalized quantile here could only be averaged, which is the bug.
			cDurationQuantiles: CH.rawExpr<string>(
				"quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles)",
			),
			// Earliest span per (service, env, commit) inside the window — the
			// list page derives deploy age / errors-since-deploy from this, so it
			// is window-clamped by construction.
			cFirstSeen: CH.min_($.bFirstSeen),
		}))
		.groupBy("cServiceName", "cServiceNamespace", "cEnvironment", "cCommitSha")

	return fromQuery(commitRows, "service_commit_rows")
		.select(($) => ({
			serviceName: $.cServiceName,
			environment: $.cEnvironment,
			// The dominant namespace, in SQL. Namespace is display metadata rather
			// than part of the routing identity, and the metrics beside it now cover
			// every namespace variant of this service.
			serviceNamespace: CH.rawExpr<string>("argMax(cServiceNamespace, cEstimatedSpanCount)"),
			throughput: CH.sum($.cSpanCount),
			errorCount: CH.sum($.cErrorCount),
			estimatedErrorCount: CH.sum($.cEstimatedErrorCount),
			spanCount: CH.sum($.cSpanCount),
			p50LatencyMs: CH.rawExpr<number>(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000",
			),
			p95LatencyMs: CH.rawExpr<number>(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000",
			),
			p99LatencyMs: CH.rawExpr<number>(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000",
			),
			estimatedSpanCount: CH.sum($.cEstimatedSpanCount),
			firstSeen: CH.min_($.cFirstSeen),
			// Sorted by span count descending and capped, so the caller can treat
			// element 1 as the dominant commit without re-sorting. `arrayReverseSort`
			// rather than `arraySort(x -> -x.2)`: the counts are UInt64 and negating
			// an unsigned integer wraps instead of ordering.
			commits: CH.rawExpr<readonly (readonly [string, number, number, string])[]>(
				`arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, ${SERVICE_OVERVIEW_COMMIT_CAP})`,
			),
		}))
		.groupBy("serviceName", "environment")
		.orderBy(["throughput", "desc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}

// Service health snapshot

export interface ServiceHealthSnapshotOpts {
	environments?: readonly string[]
	limit?: number
}

export interface ServiceHealthSnapshotOutput {
	readonly serviceName: string
	readonly environment: string
	readonly requestCount: number
	readonly errorCount: number
	readonly p95LatencyMs: number
}

/**
 * Fast metrics snapshot for the main overview's service-health section.
 *
 * This deliberately reads the generalized hourly aggregate rather than
 * `service_overview_spans`: the dashboard only needs service + environment
 * golden signals, so scanning raw entry-point rows (and then a second raw
 * seven-day baseline) is wasted work. Quantile states are merged here, which
 * also avoids the mathematically-invalid weighted average of per-commit p95s
 * used by the richer service catalog response.
 *
 * Hour bounds are floored because the aggregate is hour-grain. The main
 * overview uses multi-hour presets; including both boundary hours is the
 * least-surprising approximation and keeps the current partial hour visible.
 */
export function serviceHealthSnapshotQuery(opts: ServiceHealthSnapshotOpts) {
	return from(TracesAggregatesHourly)
		.select(($) => ({
			serviceName: $.ServiceName,
			environment: $.DeploymentEnv,
			requestCount: CH.rawExpr<number>("sum(WeightedCount)"),
			errorCount: CH.rawExpr<number>("sum(WeightedErrorCount)"),
			p95LatencyMs: CH.rawExpr<number>(
				"arrayElement(quantilesTDigestWeightedMerge(0.95)(DurationQuantiles), 1) / 1000000",
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.IsEntryPoint.eq(1),
			$.Hour.gte(hourFloor("startTime")),
			$.Hour.lte(hourFloor("endTime")),
			opts.environments?.length ? CH.inList($.DeploymentEnv, opts.environments) : undefined,
		])
		.groupBy("serviceName", "environment")
		.orderBy(["requestCount", "desc"], ["serviceName", "asc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}

/** BYO ClickHouse string-number coercion for the snapshot response. */
export const serviceHealthSnapshotRowSchema: CompiledQueryRowSchema<ServiceHealthSnapshotOutput> =
	Schema.Struct({
		serviceName: Schema.String,
		environment: Schema.String,
		requestCount: CHNumber,
		errorCount: CHNumber,
		p95LatencyMs: CHNumber,
	})

// Service health baseline

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
	return serviceOverviewWindows(opts)
		.select(($) => ({
			serviceName: $.bServiceName,
			serviceNamespace: $.bServiceNamespace,
			environment: $.bEnvironment,
			baselineP95LatencyMs: CH.rawExpr<number>(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000",
			),
			baselineSpanCount: CH.sum($.bSpanCount),
		}))
		.groupBy("serviceName", "serviceNamespace", "environment")
		.orderBy(["baselineSpanCount", "desc"])
		.limit(200)
		.format("JSON")
}

// Service releases timeline

export interface ServiceReleasesTimelineOpts {
	serviceName: string
	/**
	 * The bucket width the result is grouped into. Needed at build time, not just
	 * as a compile parameter: it selects which rollup tiers can answer, because a
	 * tier coarser than the bucket has no position inside it.
	 */
	bucketSeconds: number
}

export interface ServiceReleasesTimelineOutput {
	readonly bucket: string
	readonly commitSha: string
	readonly count: number
	readonly errorCount: number
}

export const serviceReleasesTimelineRowSchema: CompiledQueryRowSchema<ServiceReleasesTimelineOutput> =
	Schema.Struct({
		bucket: Schema.String,
		commitSha: Schema.String,
		count: CHNumber,
		errorCount: CHNumber,
	})

/**
 * Sub-minute buckets, which no rollup tier can place a row inside. Scans the
 * entry-point projection directly and is therefore bounded by its 30-day
 * retention rather than the hourly rollup's year.
 */
function serviceReleasesTimelineRawQuery(
	opts: ServiceReleasesTimelineOpts,
): CHQuery<ColumnDefs, ServiceReleasesTimelineOutput, {}> {
	return from(ServiceOverviewSpans)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			commitSha: $.CommitSha,
			count: CH.count(),
			errorCount: CH.countIf($.StatusCode.eq("Error")),
		}))
		.where(($) => [
			...serviceOverviewWhereConditions($, { serviceName: opts.serviceName }),
			$.CommitSha.neq(""),
		])
		.groupBy("bucket", "commitSha")
		.orderBy(["bucket", "asc"])
		.limit(1000)
		.format("JSON") as CHQuery<ColumnDefs, ServiceReleasesTimelineOutput, {}>
}

export function serviceReleasesTimelineQuery(
	opts: ServiceReleasesTimelineOpts,
): CHQuery<ColumnDefs, ServiceReleasesTimelineOutput, {}> {
	// Sub-hour buckets (the default here is 300s) cannot read the hourly tier: an
	// hour-floored row carries no position inside the hour, so `toStartOfInterval`
	// would put every interior hour on the bucket containing `:00` and leave the
	// rest of that hour reading zero.
	const tiers = serviceWindowTiersForBucket(opts.bucketSeconds)
	if (tiers === "raw") return serviceReleasesTimelineRawQuery(opts)

	return serviceOverviewWindows({ serviceName: opts.serviceName }, tiers)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.bBucket, param.int("bucketSeconds")),
			commitSha: $.bCommitSha,
			count: CH.sum($.bSpanCount),
			errorCount: CH.sum($.bErrorCount),
		}))
		.where(($) => [$.bCommitSha.neq("")])
		.groupBy("bucket", "commitSha")
		.orderBy(["bucket", "asc"])
		.limit(1000)
		.format("JSON") as CHQuery<ColumnDefs, ServiceReleasesTimelineOutput, {}>
}

// Service environments
//
// Distinct non-empty deployment environments reported in the window, for one
// service or for the whole organization. Backs the service-detail environment
// switcher and the mobile app's global environment picker, replacing an
// all-services overview scan that fetched every service's rows just to extract
// one service's environments. Time-windowed — and service-scoped when a service
// is named — so ClickHouse prunes the date partitions and, where it can, the
// service too.
//
// Deriving the organization-wide list from a page of `serviceCatalogQuery`
// instead would be wrong rather than merely slower: that listing is capped by
// its own `limit`, so an environment that only appears on the hundredth service
// would never be discovered.
//
// The empty environment is dropped on purpose. The DSL reads `''` as "no
// filter", so offering it as a choice would hand the caller back every
// environment under a label claiming otherwise.

export interface ServiceEnvironmentsOpts {
	/** Omitted for the organization-wide list. */
	serviceName?: string
}

export interface ServiceEnvironmentsOutput {
	readonly environment: string
}

export function serviceEnvironmentsQuery(opts: ServiceEnvironmentsOpts = {}) {
	return serviceOverviewWindows({ serviceName: opts.serviceName })
		.select(($) => ({
			environment: $.bEnvironment,
		}))
		.where(($) => [$.bEnvironment.neq("")])
		.groupBy("environment")
		.orderBy(["environment", "asc"])
		.limit(100)
		.format("JSON")
}

// Service Apdex time series

export interface ServiceApdexTimeseriesOpts {
	serviceName: string
	apdexThresholdMs?: number
	/**
	 * The bucket width the result is grouped into. Needed at build time, not just
	 * as a compile parameter: it selects which rollup tiers can answer, because a
	 * tier coarser than the bucket has no position inside it.
	 */
	bucketSeconds: number
}

export interface ServiceApdexTimeseriesOutput {
	readonly bucket: string
	readonly totalCount: number
	readonly satisfiedCount: number
	readonly toleratingCount: number
	readonly apdexScore: number
}

export const serviceApdexTimeseriesRowSchema: CompiledQueryRowSchema<ServiceApdexTimeseriesOutput> =
	Schema.Struct({
		bucket: Schema.String,
		totalCount: CHNumber,
		satisfiedCount: CHNumber,
		toleratingCount: CHNumber,
		apdexScore: CHNumber,
	})

export function serviceApdexTimeseriesQuery(
	opts: ServiceApdexTimeseriesOpts,
): CHQuery<ColumnDefs, ServiceApdexTimeseriesOutput, {}> {
	const thresholdMs = opts.apdexThresholdMs ?? 500

	// Sub-hour buckets (the default here is 60s) cannot read the hourly tier: an
	// hour-floored row carries no position inside the hour, so `toStartOfInterval`
	// would put every interior hour on the bucket containing `:00` and leave the
	// rest of that hour reading zero.
	const tiers = serviceWindowTiersForBucket(opts.bucketSeconds)

	if (thresholdMs === 500 && tiers !== "raw") {
		return serviceOverviewWindows({ serviceName: opts.serviceName }, tiers)
			.select(($) => {
				const total = CH.sum($.bSpanCount)
				const satisfied = CH.sum($.bApdexSatisfiedCount)
				const tolerating = CH.sum($.bApdexToleratingCount)
				return {
					bucket: CH.toStartOfInterval($.bBucket, param.int("bucketSeconds")),
					totalCount: total,
					satisfiedCount: satisfied,
					toleratingCount: tolerating,
					apdexScore: CH.if_(
						total.gt(0),
						CH.round_(satisfied.div(total).add(tolerating.mul(0.5).div(total)), 4),
						CH.lit(0),
					),
				}
			})
			.groupBy("bucket")
			.orderBy(["bucket", "asc"])
			.format("JSON") as CHQuery<ColumnDefs, ServiceApdexTimeseriesOutput, {}>
	}

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
		.format("JSON") as CHQuery<ColumnDefs, ServiceApdexTimeseriesOutput, {}>
}

// Service usage

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

export const serviceUsageRowSchema = Schema.Struct({
	serviceName: Schema.String,
	totalLogCount: CHNumber,
	totalLogSizeBytes: CHNumber,
	totalTraceCount: CHNumber,
	totalTraceSizeBytes: CHNumber,
	totalSumMetricCount: CHNumber,
	totalSumMetricSizeBytes: CHNumber,
	totalGaugeMetricCount: CHNumber,
	totalGaugeMetricSizeBytes: CHNumber,
	totalHistogramMetricCount: CHNumber,
	totalHistogramMetricSizeBytes: CHNumber,
	totalExpHistogramMetricCount: CHNumber,
	totalExpHistogramMetricSizeBytes: CHNumber,
	totalSizeBytes: CHNumber,
}) satisfies CompiledQueryRowSchema<ServiceUsageOutput>

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

// Services facets (UNION ALL — environment + commit_sha facets)

export type ServicesFacetsOutput = FacetOutput

// NOTE: kept as a 4-way UNION ALL on purpose. A single-scan rewrite (ARRAY JOIN
// of (facetType, value) pairs, or GROUP BY GROUPING SETS) reads ~3× fewer rows
// but benchmarked 2–4× SLOWER in wall-clock on the deployed warehouse: ClickHouse
// runs the UNION branches in parallel and each is a cheap LowCardinality GROUP BY,
// whereas the array/tuple/lambda CPU + row replication of the single-scan forms
// dominates. The I/O saving doesn't translate to latency here.
export function servicesFacetsQuery(): CHUnionQuery<ServicesFacetsOutput> {
	const envQuery = serviceOverviewWindows({})
		.select(($) => ({
			name: $.bEnvironment,
			count: CH.sum($.bSpanCount),
			facetType: CH.lit("environment"),
		}))
		.where(($) => [$.bEnvironment.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)

	const namespaceQuery = serviceOverviewWindows({})
		.select(($) => ({
			name: $.bServiceNamespace,
			count: CH.sum($.bSpanCount),
			facetType: CH.lit("namespace"),
		}))
		.where(($) => [$.bServiceNamespace.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)

	const commitQuery = serviceOverviewWindows({})
		.select(($) => ({
			name: $.bCommitSha,
			count: CH.sum($.bSpanCount),
			facetType: CH.lit("commit_sha"),
		}))
		.where(($) => [$.bCommitSha.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)

	const serviceQuery = serviceOverviewWindows({})
		.select(($) => ({
			name: $.bServiceName,
			count: CH.sum($.bSpanCount),
			facetType: CH.lit("service"),
		}))
		.where(($) => [$.bServiceName.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)

	return unionAll(envQuery, namespaceQuery, commitQuery, serviceQuery).format("JSON")
}

// Cloudflare zone breakdowns + filter facets
//
// One generic pair of queries (totals + timeseries) serves every breakdown
// dimension, driven by the {@link BREAKDOWNS} table. Adding a dimension is a
// row here plus a poller metric — not a new endpoint, handler, client fn and
// atom each time.
//
// Row shape is uniform across dimensions: dimensions with no errors/bytes
// metric emit literal 0 for those columns, so the response schema and the UI
// table stay generic.

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import {
	from,
	param,
	unionAll,
	type CHUnionQuery,
	type CompiledQueryRowSchema,
} from "@maple-dev/clickhouse-builder"
import { CHNumber } from "@maple/query-engine/ch/schema"
import { MetricsSum } from "@maple/query-engine/ch/tables"
import { ISO_Z_FORMAT, isoBucket } from "@maple/query-engine/ch/format"
import {
	CF_ATTR,
	CF_FILTERABLE,
	CF_METRIC,
	cloudflareFilterConditions,
	cloudflareHostAttr,
	type CfFilterKey,
	type CloudflareFilterOpts,
	type CloudflareMetricsAccessor,
} from "./cloudflare-infra-filters"

export type CloudflareBreakdownDimension =
	| "path"
	| "host"
	| "country"
	| "method"
	| "protocol"
	| "deviceType"
	| "cacheStatus"
	| "statusClass"

interface BreakdownSpec {
	/** Metric carrying request counts for this dimension. */
	readonly requestsMetric: string
	/** Optional companions; absent → the column is a literal 0 so the row shape is uniform. */
	readonly errorsMetric?: string
	readonly bytesMetric?: string
	/**
	 * How 5xx is counted when there is no dedicated errors metric: the main cube carries
	 * `http.status_class`, so errors are a `sumIf` on the same rows.
	 */
	readonly errorsFromStatusClass?: boolean
	readonly filterKey: CfFilterKey
}

const BREAKDOWNS: Record<CloudflareBreakdownDimension, BreakdownSpec> = {
	path: {
		requestsMetric: CF_METRIC.requestsByPath,
		errorsMetric: CF_METRIC.errorsByPath,
		bytesMetric: CF_METRIC.bytesByPath,
		filterKey: "path",
	},
	country: {
		requestsMetric: CF_METRIC.requestsByCountry,
		bytesMetric: CF_METRIC.bytesByCountry,
		filterKey: "country",
	},
	// Method, protocol and device share one series — the dimension only changes which attribute
	// becomes the key, which is exactly what makes them mutually filterable.
	method: { requestsMetric: CF_METRIC.requestsByClient, filterKey: "method" },
	protocol: { requestsMetric: CF_METRIC.requestsByClient, filterKey: "protocol" },
	deviceType: { requestsMetric: CF_METRIC.requestsByClient, filterKey: "deviceType" },
	// The main cube dimensions: errors come from the status class on the same rows.
	host: {
		requestsMetric: CF_METRIC.requests,
		bytesMetric: CF_METRIC.bytes,
		errorsFromStatusClass: true,
		filterKey: "host",
	},
	cacheStatus: {
		requestsMetric: CF_METRIC.requests,
		bytesMetric: CF_METRIC.bytes,
		errorsFromStatusClass: true,
		filterKey: "cacheStatus",
	},
	statusClass: {
		requestsMetric: CF_METRIC.requests,
		bytesMetric: CF_METRIC.bytes,
		errorsFromStatusClass: true,
		filterKey: "statusClass",
	},
} satisfies Record<CloudflareBreakdownDimension, BreakdownSpec>

export const CLOUDFLARE_BREAKDOWN_DIMENSIONS = Object.keys(
	BREAKDOWNS,
) as ReadonlyArray<CloudflareBreakdownDimension>

/**
 * Series cap for the stacked chart above the breakdown table. High-cardinality dimensions (paths on
 * a zone that attracts scanner traffic) can carry thousands of distinct keys inside one window;
 * plotting them all means thousands of `<Area>` elements and a legend longer than the page. The
 * chart's job is "which handful carries the traffic, and how did that shift" — six answers that.
 */
export const CLOUDFLARE_BREAKDOWN_SERIES_LIMIT = 6

/**
 * Bucket key the tail folds into once {@link CLOUDFLARE_BREAKDOWN_SERIES_LIMIT} is exceeded. Folded,
 * not dropped, so the stack still totals to the zone's attributed traffic.
 *
 * Deliberately the same literal the poller already writes for its own per-window tail
 * (`mapping.ts`): both mean "everything not listed individually", and giving them separate keys put
 * two indistinguishable `other` series next to each other in the legend.
 */
export const CLOUDFLARE_BREAKDOWN_OTHER_KEY = "other"

/** Metric families a breakdown reads — the handler feeds these to `cloudflareIgnoredFiltersFor`. */
export const cloudflareBreakdownMetrics = (
	dimension: CloudflareBreakdownDimension,
): ReadonlyArray<string> => {
	const spec = BREAKDOWNS[dimension]
	return [spec.requestsMetric, spec.errorsMetric, spec.bytesMetric].filter(
		(name): name is string => name !== undefined,
	)
}

/** The attribute a dimension groups by — `host` goes through the transitional coalesce. */
const keyExpr = ($: CloudflareMetricsAccessor, dimension: CloudflareBreakdownDimension) =>
	dimension === "host" ? cloudflareHostAttr($) : $.Attributes.get(CF_ATTR[BREAKDOWNS[dimension].filterKey])

const measures = ($: CloudflareMetricsAccessor, spec: BreakdownSpec) => ({
	requests: CH.sumIf($.Value, $.MetricName.eq(spec.requestsMetric)),
	errors5xx: spec.errorsMetric
		? CH.sumIf($.Value, $.MetricName.eq(spec.errorsMetric))
		: spec.errorsFromStatusClass
			? CH.sumIf(
					$.Value,
					$.MetricName.eq(spec.requestsMetric).and($.Attributes.get(CF_ATTR.statusClass).eq("5xx")),
				)
			: CH.lit(0),
	bytes: spec.bytesMetric ? CH.sumIf($.Value, $.MetricName.eq(spec.bytesMetric)) : CH.lit(0),
})

export interface CloudflareZoneBreakdownTotalsOutput {
	/** The dimension value (poller-capped: top N per window, tail folded into "other"). */
	readonly key: string
	readonly requests: number
	readonly errors5xx: number
	readonly bytes: number
}

export interface CloudflareZoneBreakdownTimeseriesOutput {
	/** Bucket start, ISO-8601 UTC. */
	readonly bucket: string
	readonly key: string
	readonly requests: number
}

export interface CloudflareZoneBreakdownCoverageOutput {
	/**
	 * Earliest datapoint for this breakdown inside the window, ISO-8601 UTC, or "" when the metric
	 * has no rows at all. Distinguishes "no traffic" from "not collected yet" — these metrics only
	 * exist from the poller's first tick forward, so a historical window is legitimately empty.
	 */
	readonly coverageStart: string
	/** Requests attributed to a returned key — compare against the zone total for coverage. */
	readonly attributedRequests: number
}

export const cloudflareZoneBreakdownTotalsRowSchema: CompiledQueryRowSchema<CloudflareZoneBreakdownTotalsOutput> =
	Schema.Struct({
		key: Schema.String,
		requests: CHNumber,
		errors5xx: CHNumber,
		bytes: CHNumber,
	})

export const cloudflareZoneBreakdownTimeseriesRowSchema: CompiledQueryRowSchema<CloudflareZoneBreakdownTimeseriesOutput> =
	Schema.Struct({
		bucket: Schema.String,
		key: Schema.String,
		requests: CHNumber,
	})

export const cloudflareZoneBreakdownCoverageRowSchema: CompiledQueryRowSchema<CloudflareZoneBreakdownCoverageOutput> =
	Schema.Struct({
		coverageStart: Schema.String,
		attributedRequests: CHNumber,
	})

const breakdownConditions = (
	$: CloudflareMetricsAccessor,
	dimension: CloudflareBreakdownDimension,
	opts: CloudflareFilterOpts,
) => {
	const spec = BREAKDOWNS[dimension]
	return cloudflareFilterConditions($, opts, CF_FILTERABLE[spec.requestsMetric] ?? [])
}

/** Ranked totals per dimension value for one zone. */
export function cloudflareZoneBreakdownTotalsSQL(
	dimension: CloudflareBreakdownDimension,
	opts: CloudflareFilterOpts = {},
	limit = 100,
) {
	const spec = BREAKDOWNS[dimension]
	return from(MetricsSum)
		.select(($) => ({ key: keyExpr($, dimension), ...measures($, spec) }))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.MetricName.in_(...cloudflareBreakdownMetrics(dimension)),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			...breakdownConditions($, dimension, opts),
		])
		.groupBy("key")
		.orderBy(["requests", "desc"])
		.limit(limit)
		.format("JSON")
}

/**
 * Bucketed request counts per dimension value, for the stacked chart above the table.
 *
 * `topKeys` bounds the series count: keys outside it collapse into
 * {@link CLOUDFLARE_BREAKDOWN_OTHER_KEY} inside the GROUP BY, so the result is at most
 * `buckets × (topKeys.length + 1)` rows however many distinct paths the zone actually saw. The
 * caller gets these from the totals query, which is already ranked by requests. Passing none keeps
 * the unbounded grouping — only safe for the fixed-vocabulary dimensions.
 */
export function cloudflareZoneBreakdownTimeseriesSQL(
	dimension: CloudflareBreakdownDimension,
	opts: CloudflareFilterOpts = {},
	topKeys: ReadonlyArray<string> = [],
) {
	const spec = BREAKDOWNS[dimension]
	const seriesKey = ($: CloudflareMetricsAccessor) => {
		const key = keyExpr($, dimension)
		if (topKeys.length === 0) return key
		return CH.if_(key.in_(...topKeys), key, CH.lit(CLOUDFLARE_BREAKDOWN_OTHER_KEY))
	}
	return from(MetricsSum)
		.select(($) => ({
			bucket: isoBucket($.TimeUnix),
			key: seriesKey($),
			requests: CH.sum($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.MetricName.eq(spec.requestsMetric),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			...breakdownConditions($, dimension, opts),
		])
		.groupBy("bucket", "key")
		.orderBy(["bucket", "asc"], ["key", "asc"])
		.format("JSON")
}

/**
 * When this breakdown's data starts inside the window, and how much traffic it accounts for.
 * Deliberately unfiltered by the caller's dimension filters: coverage is a property of what the
 * poller collected, not of what the user is currently looking at.
 */
export function cloudflareZoneBreakdownCoverageSQL(dimension: CloudflareBreakdownDimension) {
	const spec = BREAKDOWNS[dimension]
	return from(MetricsSum)
		.select(($) => ({
			coverageStart: CH.formatDateTime(CH.min_($.TimeUnix), ISO_Z_FORMAT),
			attributedRequests: CH.sum($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.MetricName.eq(spec.requestsMetric),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.format("JSON")
}

// Filter facets

export interface CloudflareZoneFacetsOutput {
	readonly name: string
	/**
	 * Request weight. Arrives as a JSON string on BYO-ClickHouse; this query is compiled without a
	 * `rowSchema`, so the handler coerces with `Number(...)` — same as `podFacets`.
	 */
	readonly count: number
	readonly facetType: string
}

/**
 * One facet branch.
 *
 * `count` is request *weight* (sum of Value), not `uniq()` of an entity id — there is no entity to
 * count here, and ranking options by traffic is what makes the list usable.
 *
 * The facet self-excludes its own key, so picking one host still shows the other hosts (narrowed by
 * whatever else is selected). `podFacetsQuery` does not self-exclude, which is why selecting a pod
 * there hides its siblings — don't copy that.
 */
const makeCfFacet = (
	opts: CloudflareFilterOpts,
	metricName: string,
	key: CfFilterKey,
	facetType: string,
	perFacetLimit: number,
) =>
	from(MetricsSum)
		.select(($) => ({
			name: key === "host" ? cloudflareHostAttr($) : $.Attributes.get(CF_ATTR[key]),
			count: CH.sum($.Value),
			facetType: CH.lit(facetType),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.MetricName.eq(metricName),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			(key === "host" ? cloudflareHostAttr($) : $.Attributes.get(CF_ATTR[key])).neq(""),
			...cloudflareFilterConditions($, opts, CF_FILTERABLE[metricName] ?? [], key),
		])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(perFacetLimit)

export function cloudflareZoneFacetsQuery(
	opts: CloudflareFilterOpts = {},
): CHUnionQuery<CloudflareZoneFacetsOutput> {
	return unionAll(
		makeCfFacet(opts, CF_METRIC.requests, "host", "host", 100),
		makeCfFacet(opts, CF_METRIC.requests, "cacheStatus", "cacheStatus", 20),
		makeCfFacet(opts, CF_METRIC.requests, "statusClass", "statusClass", 10),
		makeCfFacet(opts, CF_METRIC.requestsByPath, "path", "path", 200),
		makeCfFacet(opts, CF_METRIC.requestsByCountry, "country", "country", 100),
		makeCfFacet(opts, CF_METRIC.requestsByClient, "method", "method", 20),
		makeCfFacet(opts, CF_METRIC.requestsByClient, "protocol", "protocol", 10),
		makeCfFacet(opts, CF_METRIC.requestsByClient, "deviceType", "deviceType", 10),
	).format("JSON")
}

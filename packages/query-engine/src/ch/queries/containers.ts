// Typed Container Queries (Docker)
//
// Container-centric aggregations over metrics emitted by the OTel contrib
// docker_stats receiver. Identity carried on ResourceAttributes:
//   container.name, container.id, container.image.name, container.runtime,
//   host.name (from the resourcedetection processor, not the receiver),
//   compose.project / compose.service (mapped from com.docker.compose.* labels
//   by the agent config).
// Headline metrics:
//   container.cpu.utilization   gauge, PERCENT 0..100 (can exceed 100 on
//                               multi-core containers)
//   container.memory.percent    gauge, PERCENT 0..100 (vs limit, else host mem)
//   container.uptime            gauge, seconds
//   container.cpu.limit         gauge, cores (0 when no limit configured)
//
// Unlike the k8s `*_utilization` gauges (0..1), docker_stats percents are
// 0..100 — every projected percentage divides by 100 here so saturation
// thresholds and severity toning match the pod queries exactly.
//
// Rows from kubeletstats per-container metrics also carry `container.name`;
// they are excluded by requiring `k8s.pod.name = ''` (same trick as the node
// queries).

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from, fromQuery, type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import { unionAll, type CHUnionQuery } from "@maple-dev/clickhouse-builder"
import { MetricsGauge, MetricsSum } from "../tables"
import { deploymentEnvExpr } from "@maple/domain/tinybird/semconv-renames"
import { avgIfOrZero, facetAttrExpr, maxIfOrZero, type FacetOutput } from "./query-helpers"
import type { SortDirection } from "./infra"

const CONTAINER_METRIC_NAMES = [
	"container.cpu.utilization",
	"container.memory.percent",
	"container.uptime",
	"container.cpu.limit",
] as const

// Every container emits cpu.utilization; uptime/cpu.limit are opt-in and
// memory.percent is absent on Windows, so one always-on metric enumerates the
// full set at a fraction of the rows scanned (see POD_FACET_PROBE_METRIC).
const CONTAINER_FACET_PROBE_METRIC = "container.cpu.utilization" as const

// The summary aggregates only the two percent gauges (+ max(TimeUnix)), and it
// runs twice per page load (band + list denominator) — scanning uptime/limit
// rows there would be pure waste. cpu.utilization is always-on, so totals and
// lastSeen stay exact.
const CONTAINER_SUMMARY_METRIC_NAMES = ["container.cpu.utilization", "container.memory.percent"] as const

/** Ten collection intervals at the agent's 30s default. */
const STALE_CONTAINER_SECONDS = 300

export type ContainerSortKey = "saturation" | "cpuPct" | "memoryPct" | "containerName" | "lastSeen"

/**
 * No `unbounded` scope: docker_stats CPU% is host-relative and running without
 * limits is the norm in plain Docker, so the pod "burning CPU with nothing
 * capping it" semantics don't transfer.
 */
export type ContainerScope = "saturated" | "elevated" | "stale"

/** Containers with no limits report saturation 0 — sort those by raw CPU peak. */
const CONTAINER_SORT_TIEBREAK: ReadonlyArray<[ContainerSortKey | "cpuPctPeak", SortDirection]> = [
	["cpuPctPeak", "desc"],
	["containerName", "asc"],
]

export interface ListContainersOpts {
	search?: string
	containerNames?: ReadonlyArray<string>
	hostNames?: ReadonlyArray<string>
	images?: ReadonlyArray<string>
	composeProjects?: ReadonlyArray<string>
	composeServices?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
	excludedContainerNames?: ReadonlyArray<string>
	excludedHostNames?: ReadonlyArray<string>
	excludedImages?: ReadonlyArray<string>
	excludedComposeProjects?: ReadonlyArray<string>
	excludedComposeServices?: ReadonlyArray<string>
	excludedEnvironments?: ReadonlyArray<string>
	/** Defaults to `saturation` — see ContainerSortKey. */
	sortBy?: ContainerSortKey
	sortDir?: SortDirection
	/** One-click fleet scope from the summary band. */
	scope?: ContainerScope
	limit?: number
	offset?: number
}

export interface ListContainersOutput {
	readonly containerName: string
	readonly hostName: string
	readonly containerId: string
	readonly imageName: string
	readonly composeProject: string
	readonly composeService: string
	readonly runtime: string
	readonly environment: string
	readonly lastSeen: string
	// Window averages, 0..1 scale (see file header).
	readonly cpuPct: number
	readonly memoryPct: number
	// Window peaks — the list sorts and tones on these.
	readonly cpuPctPeak: number
	readonly memoryPctPeak: number
	/** Configured CPU limit in cores; 0 when none is set. */
	readonly cpuLimitCores: number
	readonly uptimeSeconds: number
	/** greatest(cpuPctPeak, memoryPctPeak). */
	readonly saturation: number
}

const containerBaseConditions = (
	$: ColumnAccessor<typeof MetricsGauge.columns>,
	metricNames: ReadonlyArray<string> = CONTAINER_METRIC_NAMES,
): Array<CH.Condition | undefined> => [
	$.OrgId.eq(param.string("orgId")),
	$.TimeUnix.gte(param.dateTimeString("startTime")),
	$.TimeUnix.lte(param.dateTimeString("endTime")),
	$.ResourceAttributes.get("container.name").neq(""),
	$.ResourceAttributes.get("k8s.pod.name").eq(""),
	$.MetricName.in_(...metricNames),
]

/**
 * Every container facet, paired with the resource-attribute key it filters on.
 * `attr: null` is the environment dimension, which coalesces both semconv
 * spellings (see POD_FACETS in infra.ts).
 */
const CONTAINER_FACETS = [
	{ include: "containerNames", exclude: "excludedContainerNames", attr: "container.name" },
	{ include: "hostNames", exclude: "excludedHostNames", attr: "host.name" },
	{ include: "images", exclude: "excludedImages", attr: "container.image.name" },
	{ include: "composeProjects", exclude: "excludedComposeProjects", attr: "compose.project" },
	{ include: "composeServices", exclude: "excludedComposeServices", attr: "compose.service" },
	{ include: "environments", exclude: "excludedEnvironments", attr: null },
] as const satisfies ReadonlyArray<{
	include: keyof ListContainersOpts
	exclude: keyof ListContainersOpts
	attr: string | null
}>

const containerFilterConditions = (
	$: ColumnAccessor<typeof MetricsGauge.columns>,
	opts: ListContainersOpts,
): Array<CH.Condition | undefined> => [
	CH.when(opts.search, (v: string) =>
		CH.positionCaseInsensitive($.ResourceAttributes.get("container.name"), CH.lit(v)).gt(0),
	),
	...CONTAINER_FACETS.flatMap(({ include, exclude, attr }) => {
		const expr = attr === null ? deploymentEnvExpr($.ResourceAttributes) : $.ResourceAttributes.get(attr)
		const included = opts[include] as ReadonlyArray<string> | undefined
		const excluded = opts[exclude] as ReadonlyArray<string> | undefined
		return [
			included?.length ? CH.inList(expr, included) : undefined,
			excluded?.length ? CH.notInList(expr, excluded) : undefined,
		]
	}),
]

export function listContainersQuery(opts: ListContainersOpts = {}) {
	const sortBy = opts.sortBy ?? "saturation"
	const sortDir = opts.sortDir ?? (sortBy === "containerName" ? "asc" : "desc")
	const orderBy: Array<[string, SortDirection]> = [
		[sortBy, sortDir],
		...CONTAINER_SORT_TIEBREAK.filter(([key]) => key !== sortBy),
	]

	const grouped = from(MetricsGauge)
		.select(($) => ({
			// Docker container names are unique per host only — `redis` on five
			// hosts must be five rows, so identity is (name, host).
			containerName: $.ResourceAttributes.get("container.name"),
			hostName: $.ResourceAttributes.get("host.name"),
			containerId: CH.any_($.ResourceAttributes.get("container.id")),
			imageName: CH.any_($.ResourceAttributes.get("container.image.name")),
			composeProject: CH.any_($.ResourceAttributes.get("compose.project")),
			composeService: CH.any_($.ResourceAttributes.get("compose.service")),
			runtime: CH.any_($.ResourceAttributes.get("container.runtime")),
			environment: CH.any_(deploymentEnvExpr($.ResourceAttributes)),
			lastSeen: CH.max_($.TimeUnix),
			cpuPct: avgIfOrZero($.Value, $.MetricName.eq("container.cpu.utilization")).div(100),
			memoryPct: avgIfOrZero($.Value, $.MetricName.eq("container.memory.percent")).div(100),
			cpuPctPeak: maxIfOrZero($.Value, $.MetricName.eq("container.cpu.utilization")).div(100),
			memoryPctPeak: maxIfOrZero($.Value, $.MetricName.eq("container.memory.percent")).div(100),
			cpuLimitCores: avgIfOrZero($.Value, $.MetricName.eq("container.cpu.limit")),
			uptimeSeconds: maxIfOrZero($.Value, $.MetricName.eq("container.uptime")),
			saturation: CH.greatest_(
				maxIfOrZero($.Value, $.MetricName.eq("container.cpu.utilization")).div(100),
				maxIfOrZero($.Value, $.MetricName.eq("container.memory.percent")).div(100),
			),
		}))
		.where(($) => [...containerBaseConditions($), ...containerFilterConditions($, opts)])
		.groupBy("containerName", "hostName")

	// Always wrapped, scope or not — same reasoning as listPodsQuery: sorting
	// and scoping both operate on aggregates, and one code path beats saving a
	// subquery ClickHouse flattens anyway.
	return fromQuery(grouped, "containers")
		.select(($) => ({
			containerName: $.containerName,
			hostName: $.hostName,
			containerId: $.containerId,
			imageName: $.imageName,
			composeProject: $.composeProject,
			composeService: $.composeService,
			runtime: $.runtime,
			environment: $.environment,
			lastSeen: $.lastSeen,
			cpuPct: $.cpuPct,
			memoryPct: $.memoryPct,
			cpuPctPeak: $.cpuPctPeak,
			memoryPctPeak: $.memoryPctPeak,
			cpuLimitCores: $.cpuLimitCores,
			uptimeSeconds: $.uptimeSeconds,
			saturation: $.saturation,
		}))
		.where(($) => [opts.scope ? containerScopeCondition($, opts.scope) : undefined])
		.orderBy(...(orderBy as Array<[never, SortDirection]>))
		.limit(opts.limit ?? 50)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

function containerScopeCondition(
	$: {
		saturation: CH.Expr<number>
		lastSeen: CH.Expr<string>
	},
	scope: ContainerScope,
): CH.Condition {
	switch (scope) {
		case "saturated":
			return $.saturation.gte(0.9)
		case "elevated":
			return $.saturation.gte(0.6).and($.saturation.lt(0.9))
		case "stale":
			return $.lastSeen.lt(CH.intervalSub(param.dateTimeString("endTime"), STALE_CONTAINER_SECONDS))
	}
}

// Container count + fleet-shape counts — the denominator behind "Top 50 of N"
// and the browse summary band. Runs over the same WHERE as the list so the
// band and the table agree; aggregates per container first so the counts are
// exact rather than HLL estimates (see listPodsSummaryQuery).

export interface ListContainersSummaryOutput {
	readonly totalContainers: number
	/** Peak of either percent ≥ 0.9 — matches severityLevel("crit") in the web app. */
	readonly saturatedContainers: number
	/** Peak of either percent in [0.6, 0.9). */
	readonly elevatedContainers: number
	/** Last scrape older than ten collection intervals (5 min at the 30s default). */
	readonly staleContainers: number
}

export function listContainersSummaryQuery(opts: ListContainersOpts = {}) {
	const perContainer = from(MetricsGauge)
		.select(($) => ({
			containerName: $.ResourceAttributes.get("container.name"),
			hostName: $.ResourceAttributes.get("host.name"),
			lastSeen: CH.max_($.TimeUnix),
			saturation: CH.greatest_(
				maxIfOrZero($.Value, $.MetricName.eq("container.cpu.utilization")).div(100),
				maxIfOrZero($.Value, $.MetricName.eq("container.memory.percent")).div(100),
			),
		}))
		.where(($) => [
			...containerBaseConditions($, CONTAINER_SUMMARY_METRIC_NAMES),
			...containerFilterConditions($, opts),
		])
		.groupBy("containerName", "hostName")

	return fromQuery(perContainer, "containers")
		.select(($) => ({
			totalContainers: CH.count(),
			saturatedContainers: CH.countIf($.saturation.gte(0.9)),
			elevatedContainers: CH.countIf($.saturation.gte(0.6).and($.saturation.lt(0.9))),
			staleContainers: CH.countIf(
				$.lastSeen.lt(CH.intervalSub(param.dateTimeString("endTime"), STALE_CONTAINER_SECONDS)),
			),
		}))
		.format("JSON")
}

export interface ContainerDetailSummaryOpts {
	containerName: string
	/** Optional narrowing — container names collide across hosts. */
	hostName?: string
}

export interface ContainerDetailSummaryOutput {
	readonly containerName: string
	readonly hostName: string
	readonly containerId: string
	readonly imageName: string
	readonly composeProject: string
	readonly composeService: string
	readonly runtime: string
	readonly firstSeen: string
	readonly lastSeen: string
	readonly cpuPct: number
	readonly memoryPct: number
	readonly cpuLimitCores: number
	readonly uptimeSeconds: number
}

export function containerDetailSummaryQuery(opts: ContainerDetailSummaryOpts) {
	return from(MetricsGauge)
		.select(($) => ({
			containerName: $.ResourceAttributes.get("container.name"),
			hostName: CH.any_($.ResourceAttributes.get("host.name")),
			containerId: CH.any_($.ResourceAttributes.get("container.id")),
			imageName: CH.any_($.ResourceAttributes.get("container.image.name")),
			composeProject: CH.any_($.ResourceAttributes.get("compose.project")),
			composeService: CH.any_($.ResourceAttributes.get("compose.service")),
			runtime: CH.any_($.ResourceAttributes.get("container.runtime")),
			firstSeen: CH.min_($.TimeUnix),
			lastSeen: CH.max_($.TimeUnix),
			cpuPct: avgIfOrZero($.Value, $.MetricName.eq("container.cpu.utilization")).div(100),
			memoryPct: avgIfOrZero($.Value, $.MetricName.eq("container.memory.percent")).div(100),
			cpuLimitCores: avgIfOrZero($.Value, $.MetricName.eq("container.cpu.limit")),
			uptimeSeconds: maxIfOrZero($.Value, $.MetricName.eq("container.uptime")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
			$.ResourceAttributes.get("container.name").eq(opts.containerName),
			CH.when(opts.hostName, (v: string) => $.ResourceAttributes.get("host.name").eq(v)),
			$.ResourceAttributes.get("k8s.pod.name").eq(""),
			$.MetricName.in_(...CONTAINER_METRIC_NAMES),
		])
		.groupBy("containerName")
		.format("JSON")
}

// Counter-side detail summary — the docker_stats sums that complement the
// gauge summary. The handler merges both into one detail response.

export interface ContainerCountersSummaryOpts {
	containerName: string
	hostName?: string
}

export interface ContainerCountersSummaryOutput {
	readonly memoryBytesAvg: number
	readonly memoryLimitBytes: number
	/** container.restarts is a cumulative counter — the window delta is max-min. */
	readonly restartsDelta: number
	readonly pidsAvg: number
}

export function containerCountersSummaryQuery(opts: ContainerCountersSummaryOpts) {
	// Grouped per host first: container names collide across hosts, and a
	// max−min over two hosts' independent cumulative counters fabricates a
	// restart delta out of their offset. Per-host deltas sum correctly even
	// when the caller omits `hostName`.
	const perHost = from(MetricsSum)
		.select(($) => ({
			hostName: $.ResourceAttributes.get("host.name"),
			memoryBytesAvg: avgIfOrZero($.Value, $.MetricName.eq("container.memory.usage.total")),
			memoryLimitBytes: maxIfOrZero($.Value, $.MetricName.eq("container.memory.usage.limit")),
			restartsDelta: CH.ifNotFinite(
				CH.maxIf($.Value, $.MetricName.eq("container.restarts")).sub(
					CH.minIf($.Value, $.MetricName.eq("container.restarts")),
				),
				0,
			),
			pidsAvg: avgIfOrZero($.Value, $.MetricName.eq("container.pids.count")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
			$.ResourceAttributes.get("container.name").eq(opts.containerName),
			CH.when(opts.hostName, (v: string) => $.ResourceAttributes.get("host.name").eq(v)),
			$.ResourceAttributes.get("k8s.pod.name").eq(""),
			$.MetricName.in_(
				"container.memory.usage.total",
				"container.memory.usage.limit",
				"container.restarts",
				"container.pids.count",
			),
		])
		.groupBy("hostName")

	return fromQuery(perHost, "hosts")
		.select(($) => ({
			memoryBytesAvg: CH.avg($.memoryBytesAvg),
			memoryLimitBytes: CH.max_($.memoryLimitBytes),
			restartsDelta: CH.sum($.restartsDelta),
			pidsAvg: CH.avg($.pidsAvg),
		}))
		.format("JSON")
}

// Container time-series — gauge metric for one container, optionally scaled
// (docker_stats percents are 0..100; the API divides by 100 so chart scales
// match the pod pages).

export interface ContainerGaugeTimeseriesOpts {
	containerName: string
	hostName?: string
	metricName: string
	/** Divide the averaged value — 100 for docker percent gauges. */
	divideBy?: number
}

export interface ContainerTimeseriesOutput {
	readonly bucket: string
	readonly attributeValue: string
	readonly avgValue: number
}

export function containerGaugeTimeseriesQuery(opts: ContainerGaugeTimeseriesOpts) {
	return from(MetricsGauge)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
			attributeValue: CH.lit(""),
			avgValue: opts.divideBy ? CH.avg($.Value).div(opts.divideBy) : CH.avg($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
			$.ResourceAttributes.get("container.name").eq(opts.containerName),
			CH.when(opts.hostName, (v: string) => $.ResourceAttributes.get("host.name").eq(v)),
			$.ResourceAttributes.get("k8s.pod.name").eq(""),
			$.MetricName.eq(opts.metricName),
		])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// Container sum time-series — metrics_sum families. Cumulative counters
// (network, block IO) surface bucketed sums — same crude caveat as
// hostNetworkTimeseriesQuery: the UI renders relative shape, not exact
// bytes/sec. Sampled non-monotonic sums (memory bytes) must set `average`
// instead: summing samples would inflate the chart by samples-per-bucket.

export interface ContainerSumTimeseriesOpts {
	containerName: string
	hostName?: string
	metricNames: ReadonlyArray<string>
	/**
	 * Series labeling: either derive the series from the metric name (network
	 * splits direction into rx/tx metrics) or group by a datapoint attribute
	 * (block IO's `operation`). Mutually exclusive; neither means one series.
	 */
	metricLabels?: ReadonlyArray<readonly [metricName: string, label: string]>
	groupByAttributeKey?: string
	/** Average samples per bucket — for sampled values, not cumulative counters. */
	average?: boolean
}

export function containerSumTimeseriesQuery(opts: ContainerSumTimeseriesOpts) {
	const labels = opts.metricLabels
	return from(MetricsSum)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
			attributeValue: labels?.length
				? CH.multiIf(
						labels.map(
							([metricName, label]) => [$.MetricName.eq(metricName), CH.lit(label)] as const,
						) as Array<[CH.Condition, CH.Expr<string>]>,
						CH.lit(""),
					)
				: opts.groupByAttributeKey
					? $.Attributes.get(opts.groupByAttributeKey)
					: CH.lit(""),
			sumValue: opts.average ? CH.avg($.Value) : CH.sum($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
			$.ResourceAttributes.get("container.name").eq(opts.containerName),
			CH.when(opts.hostName, (v: string) => $.ResourceAttributes.get("host.name").eq(v)),
			$.ResourceAttributes.get("k8s.pod.name").eq(""),
			$.MetricName.in_(...opts.metricNames),
		])
		.groupBy("bucket", "attributeValue")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// Container facets — distinct (name, count) pairs per ResourceAttribute key
// for the filter sidebar, filtered by the same opts as the list so counts
// reflect the current filtered set. Counts are uniq(container.id): a recreated
// container gets a new id but keeps its name, so id is the cardinality key.

export type ContainerFacetsOutput = FacetOutput

const makeContainerFacet = (
	opts: ListContainersOpts,
	attrKey: string,
	facetType: string,
	perFacetLimit: number,
) =>
	from(MetricsGauge)
		.select(($) => ({
			name: facetAttrExpr($.ResourceAttributes, attrKey),
			count: CH.uniq($.ResourceAttributes.get("container.id")),
			facetType: CH.lit(facetType),
		}))
		.where(($) => [
			...containerBaseConditions($, [CONTAINER_FACET_PROBE_METRIC]),
			...containerFilterConditions($, opts),
			facetAttrExpr($.ResourceAttributes, attrKey).neq(""),
		])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(perFacetLimit)

export function containerFacetsQuery(opts: ListContainersOpts = {}): CHUnionQuery<ContainerFacetsOutput> {
	return unionAll(
		makeContainerFacet(opts, "container.name", "container", 200),
		makeContainerFacet(opts, "host.name", "host", 100),
		makeContainerFacet(opts, "container.image.name", "image", 100),
		makeContainerFacet(opts, "compose.project", "composeProject", 100),
		makeContainerFacet(opts, "compose.service", "composeService", 100),
		makeContainerFacet(opts, "deployment.environment.name", "environment", 50),
	).format("JSON")
}

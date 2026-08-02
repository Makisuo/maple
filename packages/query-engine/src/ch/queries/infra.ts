// ---------------------------------------------------------------------------
// Typed Infrastructure Queries
//
// Host-centric aggregations built on top of OTel hostmetrics data that lands
// in metrics_gauge. Conventions (OTel semantic-conventions for hostmetrics):
//
//   - system.cpu.utilization           gauge, 0..1, attributes: cpu, state
//   - system.memory.utilization        gauge, 0..1, attributes: state
//   - system.filesystem.utilization    gauge, 0..1, attributes: device, mountpoint, state
//   - system.cpu.load_average.1m|5m|15m  gauge, absolute, no attributes
//   - system.network.io                sum,   bytes, attributes: device, direction
//
// Host identity is carried on the ResourceAttributes map under `host.name`.
// ---------------------------------------------------------------------------

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { Schema } from "effect"
import { from, fromQuery, type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import { unionAll, type CHUnionQuery, type CompiledQueryRowSchema } from "@maple-dev/clickhouse-builder"
import { MetricsGauge, MetricsSum } from "../tables"
import { CHNumber } from "../schema"

const HOSTMETRIC_NAMES = [
	"system.cpu.utilization",
	"system.memory.utilization",
	"system.filesystem.utilization",
	"system.cpu.load_average.15m",
] as const

// ---------------------------------------------------------------------------
// List hosts — one row per host.name with latest-window headline gauges
// ---------------------------------------------------------------------------

export interface ListHostsOpts {
	search?: string
	limit?: number
	offset?: number
}

export interface ListHostsOutput {
	readonly hostName: string
	readonly osType: string
	readonly hostArch: string
	readonly cloudProvider: string
	readonly lastSeen: string
	readonly cpuPct: number
	readonly memoryPct: number
	readonly diskPct: number
	readonly load15: number
}

export function listHostsQuery(opts: ListHostsOpts = {}) {
	return from(MetricsGauge)
		.select(($) => ({
			hostName: $.ResourceAttributes.get("host.name"),
			osType: CH.any_($.ResourceAttributes.get("os.type")),
			hostArch: CH.any_($.ResourceAttributes.get("host.arch")),
			cloudProvider: CH.any_($.ResourceAttributes.get("cloud.provider")),
			lastSeen: CH.max_($.TimeUnix),
			cpuPct: CH.avgIf(
				$.Value,
				$.MetricName.eq("system.cpu.utilization").and($.Attributes.get("state").neq("idle")),
			),
			memoryPct: CH.avgIf(
				$.Value,
				$.MetricName.eq("system.memory.utilization").and($.Attributes.get("state").eq("used")),
			),
			diskPct: CH.maxIf(
				$.Value,
				$.MetricName.eq("system.filesystem.utilization").and($.Attributes.get("state").eq("used")),
			),
			load15: CH.avgIf($.Value, $.MetricName.eq("system.cpu.load_average.15m")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.ResourceAttributes.get("host.name").neq(""),
			$.MetricName.in_(...HOSTMETRIC_NAMES),
			CH.when(opts.search, (v: string) =>
				CH.positionCaseInsensitive($.ResourceAttributes.get("host.name"), CH.lit(v)).gt(0),
			),
		])
		.groupBy("hostName")
		.orderBy(["lastSeen", "desc"])
		.limit(opts.limit ?? 200)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Host detail summary — single host, latest-window headline gauges + uptime
// ---------------------------------------------------------------------------

export interface HostDetailSummaryOpts {
	hostName: string
}

export interface HostDetailSummaryOutput {
	readonly hostName: string
	readonly osType: string
	readonly hostArch: string
	readonly cloudProvider: string
	readonly cloudRegion: string
	readonly firstSeen: string
	readonly lastSeen: string
	readonly cpuPct: number
	readonly memoryPct: number
	readonly diskPct: number
	readonly load15: number
}

export function hostDetailSummaryQuery(opts: HostDetailSummaryOpts) {
	return from(MetricsGauge)
		.select(($) => ({
			hostName: $.ResourceAttributes.get("host.name"),
			osType: CH.any_($.ResourceAttributes.get("os.type")),
			hostArch: CH.any_($.ResourceAttributes.get("host.arch")),
			cloudProvider: CH.any_($.ResourceAttributes.get("cloud.provider")),
			cloudRegion: CH.any_($.ResourceAttributes.get("cloud.region")),
			firstSeen: CH.min_($.TimeUnix),
			lastSeen: CH.max_($.TimeUnix),
			cpuPct: CH.avgIf(
				$.Value,
				$.MetricName.eq("system.cpu.utilization").and($.Attributes.get("state").neq("idle")),
			),
			memoryPct: CH.avgIf(
				$.Value,
				$.MetricName.eq("system.memory.utilization").and($.Attributes.get("state").eq("used")),
			),
			diskPct: CH.maxIf(
				$.Value,
				$.MetricName.eq("system.filesystem.utilization").and($.Attributes.get("state").eq("used")),
			),
			load15: CH.avgIf($.Value, $.MetricName.eq("system.cpu.load_average.15m")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.ResourceAttributes.get("host.name").eq(opts.hostName),
			$.MetricName.in_(...HOSTMETRIC_NAMES),
		])
		.groupBy("hostName")
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Host infra time-series — gauge metric broken down by a single attribute key
// (e.g. CPU by state, filesystem by mountpoint). Always filtered to one host.
// ---------------------------------------------------------------------------

export interface HostGaugeTimeseriesOpts {
	hostName: string
	metricName: string
	groupByAttributeKey?: string
}

export interface HostGaugeTimeseriesOutput {
	readonly bucket: string
	readonly attributeValue: string
	readonly avgValue: number
}

export function hostGaugeTimeseriesQuery(opts: HostGaugeTimeseriesOpts) {
	const q = from(MetricsGauge)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
			attributeValue: opts.groupByAttributeKey
				? $.Attributes.get(opts.groupByAttributeKey)
				: CH.lit(""),
			avgValue: CH.avg($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.ResourceAttributes.get("host.name").eq(opts.hostName),
			$.MetricName.eq(opts.metricName),
		])

	return (opts.groupByAttributeKey ? q.groupBy("bucket", "attributeValue") : q.groupBy("bucket"))
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Host network time-series — sum metric broken down by direction.
// Reports bytes/sec computed from the latest sample in each bucket divided by
// the bucket size. `system.network.io` is a cumulative counter; the UI layer
// is expected to render the derivative, but for the first cut we surface
// average bytes/sec using the gauge-style aggregation.
// ---------------------------------------------------------------------------

export interface HostNetworkTimeseriesOpts {
	hostName: string
}

export interface HostNetworkTimeseriesOutput {
	readonly bucket: string
	readonly attributeValue: string
	readonly sumValue: number
}

// ---------------------------------------------------------------------------
// Fleet utilization time-series — bucketed averages of CPU + memory across all
// hosts in the org, plus an active-host count per bucket. Powers the small
// sparklines on the overview KPI cards.
// ---------------------------------------------------------------------------

export interface FleetUtilizationTimeseriesOutput {
	readonly bucket: string
	readonly avgCpu: number
	readonly avgMemory: number
	readonly activeHosts: number
}

export function fleetUtilizationTimeseriesQuery() {
	return from(MetricsGauge)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
			avgCpu: CH.avgIf(
				$.Value,
				$.MetricName.eq("system.cpu.utilization").and($.Attributes.get("state").neq("idle")),
			),
			avgMemory: CH.avgIf(
				$.Value,
				$.MetricName.eq("system.memory.utilization").and($.Attributes.get("state").eq("used")),
			),
			activeHosts: CH.uniq($.ResourceAttributes.get("host.name")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.ResourceAttributes.get("host.name").neq(""),
			$.MetricName.in_("system.cpu.utilization", "system.memory.utilization"),
		])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

export function hostNetworkTimeseriesQuery(opts: HostNetworkTimeseriesOpts) {
	return from(MetricsSum)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
			attributeValue: $.Attributes.get("direction"),
			sumValue: CH.sum($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.ResourceAttributes.get("host.name").eq(opts.hostName),
			$.MetricName.eq("system.network.io"),
		])
		.groupBy("bucket", "attributeValue")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Kubernetes — pod aggregations over k8s.pod.* metrics emitted by the kubelet
// stats receiver. Identity carried on ResourceAttributes:
//   k8s.pod.name, k8s.pod.uid, k8s.namespace.name, k8s.node.name,
//   k8s.deployment.name | k8s.statefulset.name | k8s.daemonset.name,
//   k8s.pod.qos_class, k8s.pod.start_time
// Headline metrics:
//   k8s.pod.cpu.usage                 gauge, cores
//   k8s.pod.cpu_limit_utilization     gauge, 0..1
//   k8s.pod.cpu_request_utilization   gauge, 0..1
//   k8s.pod.memory_limit_utilization  gauge, 0..1
//   k8s.pod.memory_request_utilization gauge, 0..1
// ---------------------------------------------------------------------------

const POD_METRIC_NAMES = [
	"k8s.pod.cpu.usage",
	"k8s.pod.cpu_limit_utilization",
	"k8s.pod.cpu_request_utilization",
	"k8s.pod.memory_limit_utilization",
	"k8s.pod.memory_request_utilization",
] as const

// Facets only need distinct resource-attribute values + uniq(pod.uid); every pod
// emits cpu.usage, so one metric enumerates the same set at ~1/5 the rows scanned.
// (The *_utilization metrics require requests/limits to be set; cpu.usage does not.)
const POD_FACET_PROBE_METRIC = "k8s.pod.cpu.usage" as const

/**
 * Sort keys for the pod list. All of these are select-list aliases, so they sort
 * the aggregated rows rather than the raw scan.
 *
 * `saturation` is the default and means "peak of CPU-vs-limit or memory-vs-limit
 * over the window" — the thing that decides whether a pod is about to be
 * throttled or OOM-killed. Sorting on the *average* (which is all the list used
 * to compute) hides a pod that pinned at 100% for four minutes of a twelve-hour
 * window behind pods that idle slightly higher.
 */
export type PodSortKey = "saturation" | "cpuUsage" | "cpuLimitPct" | "memoryLimitPct" | "podName" | "lastSeen"

export type SortDirection = "asc" | "desc"

/** Pods whose saturation is 0 because no limits are set sort by raw usage instead. */
const POD_SORT_TIEBREAK: ReadonlyArray<[PodSortKey | "cpuUsagePeak", SortDirection]> = [
	["cpuUsagePeak", "desc"],
	["podName", "asc"],
]

export interface ListPodsOpts {
	search?: string
	podNames?: ReadonlyArray<string>
	namespaces?: ReadonlyArray<string>
	nodeNames?: ReadonlyArray<string>
	clusters?: ReadonlyArray<string>
	deployments?: ReadonlyArray<string>
	statefulsets?: ReadonlyArray<string>
	daemonsets?: ReadonlyArray<string>
	jobs?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
	computeTypes?: ReadonlyArray<string>
	// Single-value filters retained for backward compat with the workload detail
	// page, which still narrows by a single workload owner.
	workloadKind?: "deployment" | "statefulset" | "daemonset"
	workloadName?: string
	/** Defaults to `saturation` — see PodSortKey. */
	sortBy?: PodSortKey
	sortDir?: SortDirection
	/** One-click fleet scope from the summary band. */
	scope?: PodScope
	limit?: number
	offset?: number
}

/**
 * Scopes filter on *aggregated* values, so they can't live in the WHERE clause
 * alongside the row filters. The builder has no HAVING, so a scoped list wraps
 * the grouped query and filters outside it — same plan ClickHouse would produce
 * for HAVING, and it keeps the unscoped query (the common case) single-level.
 */
export type PodScope = "saturated" | "elevated" | "unbounded" | "stale"

export interface ListPodsOutput {
	readonly podName: string
	readonly namespace: string
	readonly nodeName: string
	readonly clusterName: string
	readonly environment: string
	readonly deploymentName: string
	readonly statefulsetName: string
	readonly daemonsetName: string
	readonly jobName: string
	readonly qosClass: string
	readonly podUid: string
	// "fargate" for EKS Fargate pods, "ec2" otherwise (empty when the
	// collector hasn't been told to extract the eks.amazonaws.com/compute-type
	// label, in which case the UI should treat it as ec2).
	readonly computeType: string
	readonly lastSeen: string
	// Window averages.
	readonly cpuUsage: number
	readonly cpuLimitPct: number
	readonly memoryLimitPct: number
	readonly cpuRequestPct: number
	readonly memoryRequestPct: number
	// Window peaks. The list sorts and tones on these; the averages are shown
	// beside them so a row reads "0.42 → 0.97 cores" rather than one number that
	// could mean either.
	readonly cpuUsagePeak: number
	readonly cpuLimitPctPeak: number
	readonly memoryLimitPctPeak: number
	/** greatest(cpuLimitPctPeak, memoryLimitPctPeak) — 0 when no limits are set. */
	readonly saturation: number
}

const workloadAttrKey = (kind: "deployment" | "statefulset" | "daemonset") =>
	kind === "deployment"
		? "k8s.deployment.name"
		: kind === "statefulset"
			? "k8s.statefulset.name"
			: "k8s.daemonset.name"

const podBaseConditions = (
	$: ColumnAccessor<typeof MetricsGauge.columns>,
	metricNames: ReadonlyArray<string> = POD_METRIC_NAMES,
): Array<CH.Condition | undefined> => [
	$.OrgId.eq(param.string("orgId")),
	$.TimeUnix.gte(param.dateTime("startTime")),
	$.TimeUnix.lte(param.dateTime("endTime")),
	$.ResourceAttributes.get("k8s.pod.name").neq(""),
	$.MetricName.in_(...metricNames),
]

const podFilterConditions = (
	$: ColumnAccessor<typeof MetricsGauge.columns>,
	opts: ListPodsOpts,
): Array<CH.Condition | undefined> => [
	CH.when(opts.search, (v: string) =>
		CH.positionCaseInsensitive($.ResourceAttributes.get("k8s.pod.name"), CH.lit(v)).gt(0),
	),
	opts.podNames?.length ? CH.inList($.ResourceAttributes.get("k8s.pod.name"), opts.podNames) : undefined,
	opts.namespaces?.length
		? CH.inList($.ResourceAttributes.get("k8s.namespace.name"), opts.namespaces)
		: undefined,
	opts.nodeNames?.length ? CH.inList($.ResourceAttributes.get("k8s.node.name"), opts.nodeNames) : undefined,
	opts.clusters?.length
		? CH.inList($.ResourceAttributes.get("k8s.cluster.name"), opts.clusters)
		: undefined,
	opts.deployments?.length
		? CH.inList($.ResourceAttributes.get("k8s.deployment.name"), opts.deployments)
		: undefined,
	opts.statefulsets?.length
		? CH.inList($.ResourceAttributes.get("k8s.statefulset.name"), opts.statefulsets)
		: undefined,
	opts.daemonsets?.length
		? CH.inList($.ResourceAttributes.get("k8s.daemonset.name"), opts.daemonsets)
		: undefined,
	opts.jobs?.length ? CH.inList($.ResourceAttributes.get("k8s.job.name"), opts.jobs) : undefined,
	opts.environments?.length
		? CH.inList($.ResourceAttributes.get("deployment.environment.name"), opts.environments)
		: undefined,
	opts.computeTypes?.length
		? CH.inList($.ResourceAttributes.get("eks.amazonaws.com/compute-type"), opts.computeTypes)
		: undefined,
	CH.when(opts.workloadKind && opts.workloadName, () =>
		$.ResourceAttributes.get(workloadAttrKey(opts.workloadKind!)).eq(opts.workloadName!),
	),
]

/** Ten collection intervals at the chart's 30s default. */
const STALE_POD_SECONDS = 300

export function listPodsQuery(opts: ListPodsOpts = {}) {
	const sortBy = opts.sortBy ?? "saturation"
	const sortDir = opts.sortDir ?? (sortBy === "podName" ? "asc" : "desc")
	const orderBy: Array<[string, SortDirection]> = [
		[sortBy, sortDir],
		...POD_SORT_TIEBREAK.filter(([key]) => key !== sortBy),
	]

	const grouped = from(MetricsGauge)
		.select(($) => ({
			podName: $.ResourceAttributes.get("k8s.pod.name"),
			namespace: CH.any_($.ResourceAttributes.get("k8s.namespace.name")),
			nodeName: CH.any_($.ResourceAttributes.get("k8s.node.name")),
			clusterName: CH.any_($.ResourceAttributes.get("k8s.cluster.name")),
			environment: CH.any_($.ResourceAttributes.get("deployment.environment.name")),
			deploymentName: CH.any_($.ResourceAttributes.get("k8s.deployment.name")),
			statefulsetName: CH.any_($.ResourceAttributes.get("k8s.statefulset.name")),
			daemonsetName: CH.any_($.ResourceAttributes.get("k8s.daemonset.name")),
			jobName: CH.any_($.ResourceAttributes.get("k8s.job.name")),
			qosClass: CH.any_($.ResourceAttributes.get("k8s.pod.qos_class")),
			podUid: CH.any_($.ResourceAttributes.get("k8s.pod.uid")),
			computeType: CH.any_($.ResourceAttributes.get("eks.amazonaws.com/compute-type")),
			lastSeen: CH.max_($.TimeUnix),
			cpuUsage: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.cpu.usage")),
			cpuLimitPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
			memoryLimitPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			cpuRequestPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.cpu_request_utilization")),
			memoryRequestPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.memory_request_utilization")),
			// Peaks ride along on the same scan the averages already pay for.
			cpuUsagePeak: CH.maxIf($.Value, $.MetricName.eq("k8s.pod.cpu.usage")),
			cpuLimitPctPeak: CH.maxIf($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
			memoryLimitPctPeak: CH.maxIf($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			saturation: CH.greatest_(
				CH.maxIf($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
				CH.maxIf($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			),
		}))
		.where(($) => [...podBaseConditions($), ...podFilterConditions($, opts)])
		.groupBy("podName")

	// Always wrapped, scope or not: sorting and scoping both operate on aggregates,
	// and one code path is worth more than saving a subquery ClickHouse flattens
	// anyway.
	return fromQuery(grouped, "pods")
		.select(($) => ({
			podName: $.podName,
			namespace: $.namespace,
			nodeName: $.nodeName,
			clusterName: $.clusterName,
			environment: $.environment,
			deploymentName: $.deploymentName,
			statefulsetName: $.statefulsetName,
			daemonsetName: $.daemonsetName,
			jobName: $.jobName,
			qosClass: $.qosClass,
			podUid: $.podUid,
			computeType: $.computeType,
			lastSeen: $.lastSeen,
			cpuUsage: $.cpuUsage,
			cpuLimitPct: $.cpuLimitPct,
			memoryLimitPct: $.memoryLimitPct,
			cpuRequestPct: $.cpuRequestPct,
			memoryRequestPct: $.memoryRequestPct,
			cpuUsagePeak: $.cpuUsagePeak,
			cpuLimitPctPeak: $.cpuLimitPctPeak,
			memoryLimitPctPeak: $.memoryLimitPctPeak,
			saturation: $.saturation,
		}))
		.where(($) => [opts.scope ? podScopeCondition($, opts.scope) : undefined])
		.orderBy(...(orderBy as Array<[never, SortDirection]>))
		.limit(opts.limit ?? 50)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

/**
 * A pod with no limits set reports 0 for both limit utilizations — the metrics
 * simply aren't emitted — so `saturation = 0 AND cpuUsagePeak > 0` is exactly
 * "burning CPU with nothing capping it", with no extra column to carry.
 */
function podScopeCondition(
	$: {
		saturation: CH.Expr<number>
		cpuUsagePeak: CH.Expr<number>
		lastSeen: CH.Expr<string>
	},
	scope: PodScope,
): CH.Condition {
	switch (scope) {
		case "saturated":
			return $.saturation.gte(0.9)
		case "elevated":
			return $.saturation.gte(0.6).and($.saturation.lt(0.9))
		case "unbounded":
			return $.saturation.eq(0).and($.cpuUsagePeak.gt(0))
		case "stale":
			return $.lastSeen.lt(CH.intervalSub(param.dateTime("endTime"), STALE_POD_SECONDS))
	}
}

// ---------------------------------------------------------------------------
// Pod count — the denominator behind "Top 50 of 1,284".
//
// The list is limited, so `rows.length` only ever tells you how many rows came
// back, never how many matched. Without this the UI silently claims the fleet is
// the size of the page.
// ---------------------------------------------------------------------------

export interface ListPodsSummaryOutput {
	readonly totalPods: number
	/** Peak of either limit ≥ 0.9 — matches severityLevel("crit") in the web app. */
	readonly saturatedPods: number
	/** Peak of either limit in [0.6, 0.9). */
	readonly elevatedPods: number
	/** Burning CPU with no limit set at all — invisible to a saturation ranking. */
	readonly unboundedPods: number
	/** Last scrape older than ten collection intervals (5 min at the 30s default). */
	readonly stalePods: number
}

/** Counts arrive as strings on BYO-ClickHouse, so decode rather than trust JSON. */
export const ListPodsSummaryOutputSchema: CompiledQueryRowSchema<ListPodsSummaryOutput> = Schema.Struct({
	totalPods: CHNumber,
	saturatedPods: CHNumber,
	elevatedPods: CHNumber,
	unboundedPods: CHNumber,
	stalePods: CHNumber,
})

/**
 * One row of fleet-shape counts for the browse summary band.
 *
 * Deliberately runs over the *same* WHERE as the list so the band and the table
 * agree, and aggregates per pod first so the counts are exact rather than HLL
 * estimates — `uniq` set-differences would drift on exactly the small numbers
 * ("7 saturated") the band leads with.
 */
export function listPodsSummaryQuery(opts: ListPodsOpts = {}) {
	const perPod = from(MetricsGauge)
		.select(($) => ({
			podName: $.ResourceAttributes.get("k8s.pod.name"),
			lastSeen: CH.max_($.TimeUnix),
			cpuUsagePeak: CH.maxIf($.Value, $.MetricName.eq("k8s.pod.cpu.usage")),
			saturation: CH.greatest_(
				CH.maxIf($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
				CH.maxIf($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			),
			limitSamples: CH.countIf(
				$.MetricName.in_("k8s.pod.cpu_limit_utilization", "k8s.pod.memory_limit_utilization"),
			),
		}))
		.where(($) => [...podBaseConditions($), ...podFilterConditions($, opts)])
		.groupBy("podName")

	return fromQuery(perPod, "pods")
		.select(($) => ({
			totalPods: CH.count(),
			saturatedPods: CH.countIf($.saturation.gte(0.9)),
			elevatedPods: CH.countIf($.saturation.gte(0.6).and($.saturation.lt(0.9))),
			unboundedPods: CH.countIf($.limitSamples.eq(0).and($.cpuUsagePeak.gt(0))),
			stalePods: CH.countIf(
				$.lastSeen.lt(CH.intervalSub(param.dateTime("endTime"), STALE_POD_SECONDS)),
			),
		}))
		.format("JSON")
}

export interface PodDetailSummaryOpts {
	podName: string
	namespace?: string
}

export interface PodDetailSummaryOutput {
	readonly podName: string
	readonly namespace: string
	readonly nodeName: string
	readonly deploymentName: string
	readonly statefulsetName: string
	readonly daemonsetName: string
	readonly qosClass: string
	readonly podUid: string
	readonly computeType: string
	readonly podStartTime: string
	readonly firstSeen: string
	readonly lastSeen: string
	readonly cpuUsage: number
	readonly cpuLimitPct: number
	readonly memoryLimitPct: number
	readonly cpuRequestPct: number
	readonly memoryRequestPct: number
}

export function podDetailSummaryQuery(opts: PodDetailSummaryOpts) {
	return from(MetricsGauge)
		.select(($) => ({
			podName: $.ResourceAttributes.get("k8s.pod.name"),
			namespace: CH.any_($.ResourceAttributes.get("k8s.namespace.name")),
			nodeName: CH.any_($.ResourceAttributes.get("k8s.node.name")),
			deploymentName: CH.any_($.ResourceAttributes.get("k8s.deployment.name")),
			statefulsetName: CH.any_($.ResourceAttributes.get("k8s.statefulset.name")),
			daemonsetName: CH.any_($.ResourceAttributes.get("k8s.daemonset.name")),
			qosClass: CH.any_($.ResourceAttributes.get("k8s.pod.qos_class")),
			podUid: CH.any_($.ResourceAttributes.get("k8s.pod.uid")),
			computeType: CH.any_($.ResourceAttributes.get("eks.amazonaws.com/compute-type")),
			podStartTime: CH.any_($.ResourceAttributes.get("k8s.pod.start_time")),
			firstSeen: CH.min_($.TimeUnix),
			lastSeen: CH.max_($.TimeUnix),
			cpuUsage: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.cpu.usage")),
			cpuLimitPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
			memoryLimitPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			cpuRequestPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.cpu_request_utilization")),
			memoryRequestPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.memory_request_utilization")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.ResourceAttributes.get("k8s.pod.name").eq(opts.podName),
			CH.when(opts.namespace, (v: string) => $.ResourceAttributes.get("k8s.namespace.name").eq(v)),
			$.MetricName.in_(...POD_METRIC_NAMES),
		])
		.groupBy("podName")
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Pod time-series — gauge metric for one pod, optionally broken down by an
// attribute key (e.g. container name, when present).
// ---------------------------------------------------------------------------

export interface PodGaugeTimeseriesOpts {
	podName: string
	namespace?: string
	metricName: string
	groupByAttributeKey?: string
}

export function podGaugeTimeseriesQuery(opts: PodGaugeTimeseriesOpts) {
	const q = from(MetricsGauge)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
			attributeValue: opts.groupByAttributeKey
				? $.ResourceAttributes.get(opts.groupByAttributeKey)
				: CH.lit(""),
			avgValue: CH.avg($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.ResourceAttributes.get("k8s.pod.name").eq(opts.podName),
			CH.when(opts.namespace, (v: string) => $.ResourceAttributes.get("k8s.namespace.name").eq(v)),
			$.MetricName.eq(opts.metricName),
		])

	return (opts.groupByAttributeKey ? q.groupBy("bucket", "attributeValue") : q.groupBy("bucket"))
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Kubernetes — node aggregations over k8s.node.* metrics from the kubelet
// stats + k8s_cluster receivers.
//   k8s.node.cpu.usage    gauge, cores
//   k8s.node.uptime       gauge, seconds
// ---------------------------------------------------------------------------

const NODE_METRIC_NAMES = ["k8s.node.cpu.usage", "k8s.node.uptime"] as const

// Single representative metric for node facets — see POD_FACET_PROBE_METRIC.
const NODE_FACET_PROBE_METRIC = "k8s.node.cpu.usage" as const

export interface ListNodesOpts {
	search?: string
	nodeNames?: ReadonlyArray<string>
	clusters?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
	limit?: number
	offset?: number
}

export interface ListNodesOutput {
	readonly nodeName: string
	readonly nodeUid: string
	readonly clusterName: string
	readonly environment: string
	readonly kubeletVersion: string
	readonly lastSeen: string
	readonly cpuUsage: number
	readonly uptime: number
}

const nodeBaseConditions = (
	$: ColumnAccessor<typeof MetricsGauge.columns>,
	metricNames: ReadonlyArray<string> = NODE_METRIC_NAMES,
): Array<CH.Condition | undefined> => [
	$.OrgId.eq(param.string("orgId")),
	$.TimeUnix.gte(param.dateTime("startTime")),
	$.TimeUnix.lte(param.dateTime("endTime")),
	$.ResourceAttributes.get("k8s.node.name").neq(""),
	$.ResourceAttributes.get("k8s.pod.name").eq(""),
	$.MetricName.in_(...metricNames),
]

const nodeFilterConditions = (
	$: ColumnAccessor<typeof MetricsGauge.columns>,
	opts: ListNodesOpts,
): Array<CH.Condition | undefined> => [
	CH.when(opts.search, (v: string) =>
		CH.positionCaseInsensitive($.ResourceAttributes.get("k8s.node.name"), CH.lit(v)).gt(0),
	),
	opts.nodeNames?.length ? CH.inList($.ResourceAttributes.get("k8s.node.name"), opts.nodeNames) : undefined,
	opts.clusters?.length
		? CH.inList($.ResourceAttributes.get("k8s.cluster.name"), opts.clusters)
		: undefined,
	opts.environments?.length
		? CH.inList($.ResourceAttributes.get("deployment.environment.name"), opts.environments)
		: undefined,
]

export function listNodesQuery(opts: ListNodesOpts = {}) {
	return from(MetricsGauge)
		.select(($) => ({
			nodeName: $.ResourceAttributes.get("k8s.node.name"),
			nodeUid: CH.any_($.ResourceAttributes.get("k8s.node.uid")),
			clusterName: CH.any_($.ResourceAttributes.get("k8s.cluster.name")),
			environment: CH.any_($.ResourceAttributes.get("deployment.environment.name")),
			kubeletVersion: CH.any_($.ResourceAttributes.get("k8s.kubelet.version")),
			lastSeen: CH.max_($.TimeUnix),
			cpuUsage: CH.avgIf($.Value, $.MetricName.eq("k8s.node.cpu.usage")),
			uptime: CH.maxIf($.Value, $.MetricName.eq("k8s.node.uptime")),
		}))
		.where(($) => [...nodeBaseConditions($), ...nodeFilterConditions($, opts)])
		.groupBy("nodeName")
		.orderBy(["lastSeen", "desc"])
		.limit(opts.limit ?? 200)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

export interface NodeDetailSummaryOpts {
	nodeName: string
}

export interface NodeDetailSummaryOutput {
	readonly nodeName: string
	readonly nodeUid: string
	readonly kubeletVersion: string
	readonly containerRuntime: string
	readonly firstSeen: string
	readonly lastSeen: string
	readonly cpuUsage: number
	readonly uptime: number
}

export function nodeDetailSummaryQuery(opts: NodeDetailSummaryOpts) {
	return from(MetricsGauge)
		.select(($) => ({
			nodeName: $.ResourceAttributes.get("k8s.node.name"),
			nodeUid: CH.any_($.ResourceAttributes.get("k8s.node.uid")),
			kubeletVersion: CH.any_($.ResourceAttributes.get("k8s.kubelet.version")),
			containerRuntime: CH.any_($.ResourceAttributes.get("container.runtime")),
			firstSeen: CH.min_($.TimeUnix),
			lastSeen: CH.max_($.TimeUnix),
			cpuUsage: CH.avgIf($.Value, $.MetricName.eq("k8s.node.cpu.usage")),
			uptime: CH.maxIf($.Value, $.MetricName.eq("k8s.node.uptime")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.ResourceAttributes.get("k8s.node.name").eq(opts.nodeName),
			$.ResourceAttributes.get("k8s.pod.name").eq(""),
			$.MetricName.in_(...NODE_METRIC_NAMES),
		])
		.groupBy("nodeName")
		.format("JSON")
}

export interface NodeGaugeTimeseriesOpts {
	nodeName: string
	metricName: string
}

export function nodeGaugeTimeseriesQuery(opts: NodeGaugeTimeseriesOpts) {
	return from(MetricsGauge)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
			attributeValue: CH.lit(""),
			avgValue: CH.avg($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.ResourceAttributes.get("k8s.node.name").eq(opts.nodeName),
			$.ResourceAttributes.get("k8s.pod.name").eq(""),
			$.MetricName.eq(opts.metricName),
		])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Kubernetes — workload aggregations (Deployment / StatefulSet / DaemonSet).
// Walks over k8s.pod.* metrics and groups by workload-name + namespace.
// ---------------------------------------------------------------------------

export type WorkloadKind = "deployment" | "statefulset" | "daemonset"

export interface ListWorkloadsOpts {
	kind: WorkloadKind
	search?: string
	workloadNames?: ReadonlyArray<string>
	namespaces?: ReadonlyArray<string>
	clusters?: ReadonlyArray<string>
	environments?: ReadonlyArray<string>
	computeTypes?: ReadonlyArray<string>
	limit?: number
	offset?: number
}

export interface ListWorkloadsOutput {
	readonly workloadName: string
	readonly namespace: string
	readonly clusterName: string
	readonly environment: string
	readonly podCount: number
	readonly lastSeen: string
	readonly avgCpuLimitPct: number
	readonly avgMemoryLimitPct: number
	readonly avgCpuUsage: number
}

const workloadFilterConditions = (
	$: ColumnAccessor<typeof MetricsGauge.columns>,
	opts: ListWorkloadsOpts,
	attrKey: string,
): Array<CH.Condition | undefined> => [
	CH.when(opts.search, (v: string) =>
		CH.positionCaseInsensitive($.ResourceAttributes.get(attrKey), CH.lit(v)).gt(0),
	),
	opts.workloadNames?.length ? CH.inList($.ResourceAttributes.get(attrKey), opts.workloadNames) : undefined,
	opts.namespaces?.length
		? CH.inList($.ResourceAttributes.get("k8s.namespace.name"), opts.namespaces)
		: undefined,
	opts.clusters?.length
		? CH.inList($.ResourceAttributes.get("k8s.cluster.name"), opts.clusters)
		: undefined,
	opts.environments?.length
		? CH.inList($.ResourceAttributes.get("deployment.environment.name"), opts.environments)
		: undefined,
	opts.computeTypes?.length
		? CH.inList($.ResourceAttributes.get("eks.amazonaws.com/compute-type"), opts.computeTypes)
		: undefined,
]

export function listWorkloadsQuery(opts: ListWorkloadsOpts) {
	const attrKey = workloadAttrKey(opts.kind)
	return from(MetricsGauge)
		.select(($) => ({
			workloadName: $.ResourceAttributes.get(attrKey),
			namespace: CH.any_($.ResourceAttributes.get("k8s.namespace.name")),
			clusterName: CH.any_($.ResourceAttributes.get("k8s.cluster.name")),
			environment: CH.any_($.ResourceAttributes.get("deployment.environment.name")),
			podCount: CH.uniq($.ResourceAttributes.get("k8s.pod.uid")),
			lastSeen: CH.max_($.TimeUnix),
			avgCpuLimitPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
			avgMemoryLimitPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			avgCpuUsage: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.cpu.usage")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.ResourceAttributes.get(attrKey).neq(""),
			$.MetricName.in_(...POD_METRIC_NAMES),
			...workloadFilterConditions($, opts, attrKey),
		])
		.groupBy("workloadName")
		.orderBy(["lastSeen", "desc"])
		.limit(opts.limit ?? 200)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

export interface WorkloadDetailSummaryOpts {
	kind: WorkloadKind
	workloadName: string
	namespace?: string
}

export interface WorkloadDetailSummaryOutput {
	readonly workloadName: string
	readonly kind: string
	readonly namespace: string
	readonly podCount: number
	readonly firstSeen: string
	readonly lastSeen: string
	readonly avgCpuLimitPct: number
	readonly avgMemoryLimitPct: number
	readonly avgCpuUsage: number
}

export function workloadDetailSummaryQuery(opts: WorkloadDetailSummaryOpts) {
	const attrKey = workloadAttrKey(opts.kind)
	return from(MetricsGauge)
		.select(($) => ({
			workloadName: $.ResourceAttributes.get(attrKey),
			namespace: CH.any_($.ResourceAttributes.get("k8s.namespace.name")),
			podCount: CH.uniq($.ResourceAttributes.get("k8s.pod.uid")),
			firstSeen: CH.min_($.TimeUnix),
			lastSeen: CH.max_($.TimeUnix),
			avgCpuLimitPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
			avgMemoryLimitPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			avgCpuUsage: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.cpu.usage")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.ResourceAttributes.get(attrKey).eq(opts.workloadName),
			CH.when(opts.namespace, (v: string) => $.ResourceAttributes.get("k8s.namespace.name").eq(v)),
			$.MetricName.in_(...POD_METRIC_NAMES),
		])
		.groupBy("workloadName")
		.format("JSON")
}

export interface WorkloadGaugeTimeseriesOpts {
	kind: WorkloadKind
	workloadName: string
	namespace?: string
	metricName: string
	groupByPod?: boolean
}

export function workloadGaugeTimeseriesQuery(opts: WorkloadGaugeTimeseriesOpts) {
	const attrKey = workloadAttrKey(opts.kind)
	const q = from(MetricsGauge)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
			attributeValue: opts.groupByPod ? $.ResourceAttributes.get("k8s.pod.name") : CH.lit(""),
			avgValue: CH.avg($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.ResourceAttributes.get(attrKey).eq(opts.workloadName),
			CH.when(opts.namespace, (v: string) => $.ResourceAttributes.get("k8s.namespace.name").eq(v)),
			$.MetricName.eq(opts.metricName),
		])

	return (opts.groupByPod ? q.groupBy("bucket", "attributeValue") : q.groupBy("bucket"))
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// K8s facets — distinct (name, count) pairs per ResourceAttribute key, used to
// populate the SigNoz-style left filter sidebar. Each facet query is a UNION
// of per-attribute SELECTs scoped to the rows that show up in the matching
// list query (pods, nodes, or workloads), filtered by the same opts so the
// facet counts reflect the *current* filtered set.
// ---------------------------------------------------------------------------

export interface PodFacetsOutput {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

const makePodFacet = (opts: ListPodsOpts, attrKey: string, facetType: string, perFacetLimit: number) =>
	from(MetricsGauge)
		.select(($) => ({
			name: $.ResourceAttributes.get(attrKey),
			count: CH.uniq($.ResourceAttributes.get("k8s.pod.uid")),
			facetType: CH.lit(facetType),
		}))
		.where(($) => [
			...podBaseConditions($, [POD_FACET_PROBE_METRIC]),
			...podFilterConditions($, opts),
			$.ResourceAttributes.get(attrKey).neq(""),
		])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(perFacetLimit)

export function podFacetsQuery(opts: ListPodsOpts = {}): CHUnionQuery<PodFacetsOutput> {
	return unionAll(
		makePodFacet(opts, "k8s.pod.name", "pod", 200),
		makePodFacet(opts, "k8s.namespace.name", "namespace", 100),
		makePodFacet(opts, "k8s.node.name", "node", 100),
		makePodFacet(opts, "k8s.cluster.name", "cluster", 50),
		makePodFacet(opts, "k8s.deployment.name", "deployment", 100),
		makePodFacet(opts, "k8s.statefulset.name", "statefulset", 100),
		makePodFacet(opts, "k8s.daemonset.name", "daemonset", 100),
		makePodFacet(opts, "k8s.job.name", "job", 100),
		makePodFacet(opts, "deployment.environment.name", "environment", 50),
		makePodFacet(opts, "eks.amazonaws.com/compute-type", "computeType", 10),
	).format("JSON")
}

export interface NodeFacetsOutput {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

const makeNodeFacet = (opts: ListNodesOpts, attrKey: string, facetType: string, perFacetLimit: number) =>
	from(MetricsGauge)
		.select(($) => ({
			name: $.ResourceAttributes.get(attrKey),
			count: CH.uniq($.ResourceAttributes.get("k8s.node.name")),
			facetType: CH.lit(facetType),
		}))
		.where(($) => [
			...nodeBaseConditions($, [NODE_FACET_PROBE_METRIC]),
			...nodeFilterConditions($, opts),
			$.ResourceAttributes.get(attrKey).neq(""),
		])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(perFacetLimit)

export function nodeFacetsQuery(opts: ListNodesOpts = {}): CHUnionQuery<NodeFacetsOutput> {
	return unionAll(
		makeNodeFacet(opts, "k8s.node.name", "node", 200),
		makeNodeFacet(opts, "k8s.cluster.name", "cluster", 50),
		makeNodeFacet(opts, "deployment.environment.name", "environment", 50),
	).format("JSON")
}

export interface WorkloadFacetsOutput {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

const makeWorkloadFacet = (
	opts: ListWorkloadsOpts,
	attrKey: string,
	facetType: string,
	perFacetLimit: number,
) => {
	const ownerKey = workloadAttrKey(opts.kind)
	return from(MetricsGauge)
		.select(($) => ({
			name: $.ResourceAttributes.get(attrKey),
			count: CH.uniq($.ResourceAttributes.get(ownerKey)),
			facetType: CH.lit(facetType),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.ResourceAttributes.get(ownerKey).neq(""),
			$.MetricName.in_(POD_FACET_PROBE_METRIC),
			...workloadFilterConditions($, opts, ownerKey),
			$.ResourceAttributes.get(attrKey).neq(""),
		])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(perFacetLimit)
}

export function workloadFacetsQuery(opts: ListWorkloadsOpts): CHUnionQuery<WorkloadFacetsOutput> {
	const ownerKey = workloadAttrKey(opts.kind)
	return unionAll(
		makeWorkloadFacet(opts, ownerKey, "workload", 200),
		makeWorkloadFacet(opts, "k8s.namespace.name", "namespace", 100),
		makeWorkloadFacet(opts, "k8s.cluster.name", "cluster", 50),
		makeWorkloadFacet(opts, "deployment.environment.name", "environment", 50),
		makeWorkloadFacet(opts, "eks.amazonaws.com/compute-type", "computeType", 10),
	).format("JSON")
}

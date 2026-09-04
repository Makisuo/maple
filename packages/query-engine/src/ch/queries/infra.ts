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

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from, fromQuery, type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import { unionAll, type CHUnionQuery } from "@maple-dev/clickhouse-builder"
import { MetricsGauge, MetricsSum } from "../tables"
import { containerRuntimeExpr, deploymentEnvExpr } from "@maple/domain/tinybird/semconv-renames"
import { avgIfOrZero, facetAttrExpr, maxIfOrZero, type FacetOutput } from "./query-helpers"

const HOSTMETRIC_NAMES = [
	"system.cpu.utilization",
	"system.memory.utilization",
	"system.filesystem.utilization",
	"system.cpu.load_average.15m",
] as const

// List hosts — one row per host.name with latest-window headline gauges

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
			cpuPct: avgIfOrZero(
				$.Value,
				$.MetricName.eq("system.cpu.utilization").and($.Attributes.get("state").neq("idle")),
			),
			memoryPct: avgIfOrZero(
				$.Value,
				$.MetricName.eq("system.memory.utilization").and($.Attributes.get("state").eq("used")),
			),
			diskPct: maxIfOrZero(
				$.Value,
				$.MetricName.eq("system.filesystem.utilization").and($.Attributes.get("state").eq("used")),
			),
			load15: avgIfOrZero($.Value, $.MetricName.eq("system.cpu.load_average.15m")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
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

// Host detail summary — single host, latest-window headline gauges + uptime

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
			cpuPct: avgIfOrZero(
				$.Value,
				$.MetricName.eq("system.cpu.utilization").and($.Attributes.get("state").neq("idle")),
			),
			memoryPct: avgIfOrZero(
				$.Value,
				$.MetricName.eq("system.memory.utilization").and($.Attributes.get("state").eq("used")),
			),
			diskPct: maxIfOrZero(
				$.Value,
				$.MetricName.eq("system.filesystem.utilization").and($.Attributes.get("state").eq("used")),
			),
			load15: avgIfOrZero($.Value, $.MetricName.eq("system.cpu.load_average.15m")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
			$.ResourceAttributes.get("host.name").eq(opts.hostName),
			$.MetricName.in_(...HOSTMETRIC_NAMES),
		])
		.groupBy("hostName")
		.format("JSON")
}

// Host infra time-series — gauge metric broken down by a single attribute key
// (e.g. CPU by state, filesystem by mountpoint). Always filtered to one host.

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
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
			$.ResourceAttributes.get("host.name").eq(opts.hostName),
			$.MetricName.eq(opts.metricName),
		])

	return (opts.groupByAttributeKey ? q.groupBy("bucket", "attributeValue") : q.groupBy("bucket"))
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// Host network time-series — sum metric broken down by direction.
// Reports bytes/sec computed from the latest sample in each bucket divided by
// the bucket size. `system.network.io` is a cumulative counter; the UI layer
// is expected to render the derivative, but for the first cut we surface
// average bytes/sec using the gauge-style aggregation.

export interface HostNetworkTimeseriesOpts {
	hostName: string
}

export interface HostNetworkTimeseriesOutput {
	readonly bucket: string
	readonly attributeValue: string
	readonly sumValue: number
}

// Fleet utilization time-series — bucketed averages of CPU + memory across all
// hosts in the org, plus an active-host count per bucket. Powers the small
// sparklines on the overview KPI cards.

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
			avgCpu: avgIfOrZero(
				$.Value,
				$.MetricName.eq("system.cpu.utilization").and($.Attributes.get("state").neq("idle")),
			),
			avgMemory: avgIfOrZero(
				$.Value,
				$.MetricName.eq("system.memory.utilization").and($.Attributes.get("state").eq("used")),
			),
			activeHosts: CH.uniq($.ResourceAttributes.get("host.name")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
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
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
			$.ResourceAttributes.get("host.name").eq(opts.hostName),
			$.MetricName.eq("system.network.io"),
		])
		.groupBy("bucket", "attributeValue")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

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
	excludedPodNames?: ReadonlyArray<string>
	excludedNamespaces?: ReadonlyArray<string>
	excludedNodeNames?: ReadonlyArray<string>
	excludedClusters?: ReadonlyArray<string>
	excludedDeployments?: ReadonlyArray<string>
	excludedStatefulsets?: ReadonlyArray<string>
	excludedDaemonsets?: ReadonlyArray<string>
	excludedJobs?: ReadonlyArray<string>
	excludedEnvironments?: ReadonlyArray<string>
	excludedComputeTypes?: ReadonlyArray<string>
	// Single-value filters retained for backward compat with the workload detail
	// page, which still narrows by a single workload owner.
	workloadKind?: "deployment" | "statefulset" | "daemonset"
	workloadName?: string
	/** Defaults to `saturation` — see PodSortKey. */
	sortBy?: PodSortKey
	sortDir?: SortDirection
	/** One-click fleet scope from the summary band. */
	scope?: PodScope
	/** Defaults to `live` — see PodLifecycle. */
	lifecycle?: PodLifecycle
	limit?: number
	offset?: number
}

/**
 * Scopes filter on *aggregated* values, so they can't live in the WHERE clause
 * alongside the row filters. The builder has no HAVING, so a scoped list wraps
 * the grouped query and filters outside it — same plan ClickHouse would produce
 * for HAVING, and it keeps the unscoped query (the common case) single-level.
 */
export type PodScope = "saturated" | "elevated" | "unbounded"

/**
 * Which slice of the window's pods the caller wants.
 *
 * A windowed pod list is the union of everything that reported at any point in
 * it, so on an autoscaled fleet most of those pods no longer exist — scaled in
 * by an HPA, rolled out by a deploy, replaced when a Fargate task or spot node
 * was cycled. Ending is the normal end of a pod's life, not a fault, so the
 * list defaults to `live` and offers the rest as a deliberate scope. Without
 * this the ranking, the denominator and the fleet band all mix the dead in with
 * the running.
 */
export type PodLifecycle = "live" | "ended" | "all"

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
	$.TimeUnix.gte(param.dateTimeString("startTime")),
	$.TimeUnix.lte(param.dateTimeString("endTime")),
	$.ResourceAttributes.get("k8s.pod.name").neq(""),
	$.MetricName.in_(...metricNames),
]

/**
 * Every pod facet, paired with the resource-attribute key it filters on.
 *
 * Driven from one table rather than open-coded per dimension: ten facets written out twice — once
 * to include, once to exclude — is exactly where a missed polarity hides. `attr: null` means the
 * dimension needs a real expression (environment coalesces both semconv spellings) rather than a
 * plain map read. Order here is the emitted clause order, so it stays as it was.
 */
const POD_FACETS = [
	{ include: "podNames", exclude: "excludedPodNames", attr: "k8s.pod.name" },
	{ include: "namespaces", exclude: "excludedNamespaces", attr: "k8s.namespace.name" },
	{ include: "nodeNames", exclude: "excludedNodeNames", attr: "k8s.node.name" },
	{ include: "clusters", exclude: "excludedClusters", attr: "k8s.cluster.name" },
	{ include: "deployments", exclude: "excludedDeployments", attr: "k8s.deployment.name" },
	{ include: "statefulsets", exclude: "excludedStatefulsets", attr: "k8s.statefulset.name" },
	{ include: "daemonsets", exclude: "excludedDaemonsets", attr: "k8s.daemonset.name" },
	{ include: "jobs", exclude: "excludedJobs", attr: "k8s.job.name" },
	{ include: "environments", exclude: "excludedEnvironments", attr: null },
	{
		include: "computeTypes",
		exclude: "excludedComputeTypes",
		attr: "eks.amazonaws.com/compute-type",
	},
] as const satisfies ReadonlyArray<{
	include: keyof ListPodsOpts
	exclude: keyof ListPodsOpts
	attr: string | null
}>

const podFilterConditions = (
	$: ColumnAccessor<typeof MetricsGauge.columns>,
	opts: ListPodsOpts,
): Array<CH.Condition | undefined> => [
	CH.when(opts.search, (v: string) =>
		CH.positionCaseInsensitive($.ResourceAttributes.get("k8s.pod.name"), CH.lit(v)).gt(0),
	),
	...POD_FACETS.flatMap(({ include, exclude, attr }) => {
		const expr = attr === null ? deploymentEnvExpr($.ResourceAttributes) : $.ResourceAttributes.get(attr)
		const included = opts[include] as ReadonlyArray<string> | undefined
		const excluded = opts[exclude] as ReadonlyArray<string> | undefined
		return [
			included?.length ? CH.inList(expr, included) : undefined,
			excluded?.length ? CH.notInList(expr, excluded) : undefined,
		]
	}),
	CH.when(
		opts.workloadKind !== undefined && opts.workloadName !== undefined
			? { kind: opts.workloadKind, name: opts.workloadName }
			: undefined,
		(workload) => $.ResourceAttributes.get(workloadAttrKey(workload.kind)).eq(workload.name),
	),
]

/**
 * Ten collection intervals at the chart's 30s default. A pod whose newest
 * datapoint predates this is one whose series ended, which for a pod means it
 * stopped existing — the same cutoff `deriveHostStatus` uses in the web app, so
 * the badge on a row and the predicate that selected it never disagree.
 */
const ENDED_POD_SECONDS = 300

/**
 * `lastSeen` is an aggregate, so these belong outside the grouping. The cutoff
 * rides on `endTime` rather than wall-clock now, so a window that ended an hour
 * ago still reports who was live *then*.
 */
type PodLifecycleColumns = { lastSeen: CH.Expr<string> }
const endedCutoff = () => CH.intervalSub(param.dateTimeString("endTime"), ENDED_POD_SECONDS)
const podLiveCondition = ($: PodLifecycleColumns) => $.lastSeen.gte(endedCutoff())
const podEndedCondition = ($: PodLifecycleColumns) => $.lastSeen.lt(endedCutoff())

const podLifecycleCondition = (
	$: PodLifecycleColumns,
	lifecycle: PodLifecycle,
): CH.Condition | undefined => {
	switch (lifecycle) {
		case "live":
			return podLiveCondition($)
		case "ended":
			return podEndedCondition($)
		case "all":
			return undefined
	}
}

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
			environment: CH.any_(deploymentEnvExpr($.ResourceAttributes)),
			deploymentName: CH.any_($.ResourceAttributes.get("k8s.deployment.name")),
			statefulsetName: CH.any_($.ResourceAttributes.get("k8s.statefulset.name")),
			daemonsetName: CH.any_($.ResourceAttributes.get("k8s.daemonset.name")),
			jobName: CH.any_($.ResourceAttributes.get("k8s.job.name")),
			qosClass: CH.any_($.ResourceAttributes.get("k8s.pod.qos_class")),
			podUid: CH.any_($.ResourceAttributes.get("k8s.pod.uid")),
			computeType: CH.any_($.ResourceAttributes.get("eks.amazonaws.com/compute-type")),
			lastSeen: CH.max_($.TimeUnix),
			cpuUsage: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu.usage")),
			cpuLimitPct: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
			memoryLimitPct: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			cpuRequestPct: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu_request_utilization")),
			memoryRequestPct: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.memory_request_utilization")),
			// Peaks ride along on the same scan the averages already pay for.
			cpuUsagePeak: maxIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu.usage")),
			cpuLimitPctPeak: maxIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
			memoryLimitPctPeak: maxIfOrZero($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			saturation: CH.greatest_(
				maxIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
				maxIfOrZero($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
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
		.where(($) => [
			podLifecycleCondition($, opts.lifecycle ?? "live"),
			opts.scope ? podScopeCondition($, opts.scope) : undefined,
		])
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
	}
}

// Pod count — the denominator behind "Top 50 of 1,284".
//
// The list is limited, so `rows.length` only ever tells you how many rows came
// back, never how many matched. Without this the UI silently claims the fleet is
// the size of the page.

export interface ListPodsSummaryOutput {
	/** Still reporting at the window's end — the fleet as it stands. */
	readonly livePods: number
	/**
	 * Reported earlier in the window and stopped. Scale-in, a rollout, a cycled
	 * Fargate task: expected churn, counted separately so it can be offered as a
	 * scope instead of inflating the denominator.
	 */
	readonly endedPods: number
	/** Peak of either limit ≥ 0.9 — matches severityLevel("crit") in the web app. */
	readonly saturatedPods: number
	/** Peak of either limit in [0.6, 0.9). */
	readonly elevatedPods: number
	/** Burning CPU with no limit set at all — invisible to a saturation ranking. */
	readonly unboundedPods: number
}

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
			cpuUsagePeak: maxIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu.usage")),
			saturation: CH.greatest_(
				maxIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
				maxIfOrZero($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			),
			limitSamples: CH.countIf(
				$.MetricName.in_("k8s.pod.cpu_limit_utilization", "k8s.pod.memory_limit_utilization"),
			),
		}))
		.where(($) => [...podBaseConditions($), ...podFilterConditions($, opts)])
		.groupBy("podName")

	// Live/ended are absolute so the band can always offer "and N more that
	// ended"; the saturation buckets are counted WITHIN the requested lifecycle
	// so they stay a valid denominator for the list that ran beside them.
	const lifecycle = opts.lifecycle ?? "live"
	return fromQuery(perPod, "pods")
		.select(($) => {
			const inScope = podLifecycleCondition($, lifecycle)
			const within = (condition: CH.Condition) =>
				CH.countIf(inScope ? inScope.and(condition) : condition)
			return {
				livePods: CH.countIf(podLiveCondition($)),
				endedPods: CH.countIf(podEndedCondition($)),
				saturatedPods: within($.saturation.gte(0.9)),
				elevatedPods: within($.saturation.gte(0.6).and($.saturation.lt(0.9))),
				unboundedPods: within($.limitSamples.eq(0).and($.cpuUsagePeak.gt(0))),
			}
		})
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
			cpuUsage: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu.usage")),
			cpuLimitPct: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
			memoryLimitPct: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			cpuRequestPct: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu_request_utilization")),
			memoryRequestPct: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.memory_request_utilization")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
			$.ResourceAttributes.get("k8s.pod.name").eq(opts.podName),
			CH.when(opts.namespace, (v: string) => $.ResourceAttributes.get("k8s.namespace.name").eq(v)),
			$.MetricName.in_(...POD_METRIC_NAMES),
		])
		.groupBy("podName")
		.format("JSON")
}

// Pod time-series — gauge metric for one pod, optionally broken down by an
// attribute key (e.g. container name, when present).

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
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
			$.ResourceAttributes.get("k8s.pod.name").eq(opts.podName),
			CH.when(opts.namespace, (v: string) => $.ResourceAttributes.get("k8s.namespace.name").eq(v)),
			$.MetricName.eq(opts.metricName),
		])

	return (opts.groupByAttributeKey ? q.groupBy("bucket", "attributeValue") : q.groupBy("bucket"))
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// Kubernetes — node aggregations over k8s.node.* metrics from the kubelet
// stats + k8s_cluster receivers.
//   k8s.node.cpu.usage    gauge, cores
//   k8s.node.uptime       gauge, seconds

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
	$.TimeUnix.gte(param.dateTimeString("startTime")),
	$.TimeUnix.lte(param.dateTimeString("endTime")),
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
		? CH.inList(deploymentEnvExpr($.ResourceAttributes), opts.environments)
		: undefined,
]

export function listNodesQuery(opts: ListNodesOpts = {}) {
	return from(MetricsGauge)
		.select(($) => ({
			nodeName: $.ResourceAttributes.get("k8s.node.name"),
			nodeUid: CH.any_($.ResourceAttributes.get("k8s.node.uid")),
			clusterName: CH.any_($.ResourceAttributes.get("k8s.cluster.name")),
			environment: CH.any_(deploymentEnvExpr($.ResourceAttributes)),
			kubeletVersion: CH.any_($.ResourceAttributes.get("k8s.kubelet.version")),
			lastSeen: CH.max_($.TimeUnix),
			cpuUsage: avgIfOrZero($.Value, $.MetricName.eq("k8s.node.cpu.usage")),
			uptime: maxIfOrZero($.Value, $.MetricName.eq("k8s.node.uptime")),
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
			containerRuntime: CH.any_(containerRuntimeExpr($.ResourceAttributes)),
			firstSeen: CH.min_($.TimeUnix),
			lastSeen: CH.max_($.TimeUnix),
			cpuUsage: avgIfOrZero($.Value, $.MetricName.eq("k8s.node.cpu.usage")),
			uptime: maxIfOrZero($.Value, $.MetricName.eq("k8s.node.uptime")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
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
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
			$.ResourceAttributes.get("k8s.node.name").eq(opts.nodeName),
			$.ResourceAttributes.get("k8s.pod.name").eq(""),
			$.MetricName.eq(opts.metricName),
		])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// Kubernetes — workload aggregations (Deployment / StatefulSet / DaemonSet).
// Walks over k8s.pod.* metrics and groups by workload-name + namespace.

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
		? CH.inList(deploymentEnvExpr($.ResourceAttributes), opts.environments)
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
			environment: CH.any_(deploymentEnvExpr($.ResourceAttributes)),
			podCount: CH.uniq($.ResourceAttributes.get("k8s.pod.uid")),
			lastSeen: CH.max_($.TimeUnix),
			avgCpuLimitPct: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
			avgMemoryLimitPct: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			avgCpuUsage: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu.usage")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
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
			avgCpuLimitPct: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
			avgMemoryLimitPct: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			avgCpuUsage: avgIfOrZero($.Value, $.MetricName.eq("k8s.pod.cpu.usage")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
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
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
			$.ResourceAttributes.get(attrKey).eq(opts.workloadName),
			CH.when(opts.namespace, (v: string) => $.ResourceAttributes.get("k8s.namespace.name").eq(v)),
			$.MetricName.eq(opts.metricName),
		])

	return (opts.groupByPod ? q.groupBy("bucket", "attributeValue") : q.groupBy("bucket"))
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// K8s facets — distinct (name, count) pairs per ResourceAttribute key, used to
// populate the SigNoz-style left filter sidebar. Each facet query is a UNION
// of per-attribute SELECTs scoped to the rows that show up in the matching
// list query (pods, nodes, or workloads), filtered by the same opts so the
// facet counts reflect the *current* filtered set.

export type PodFacetsOutput = FacetOutput

const makePodFacet = (opts: ListPodsOpts, attrKey: string, facetType: string, perFacetLimit: number) =>
	from(MetricsGauge)
		.select(($) => ({
			name: facetAttrExpr($.ResourceAttributes, attrKey),
			count: CH.uniq($.ResourceAttributes.get("k8s.pod.uid")),
			facetType: CH.lit(facetType),
		}))
		.where(($) => [
			...podBaseConditions($, [POD_FACET_PROBE_METRIC]),
			...podFilterConditions($, opts),
			facetAttrExpr($.ResourceAttributes, attrKey).neq(""),
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

export type NodeFacetsOutput = FacetOutput

const makeNodeFacet = (opts: ListNodesOpts, attrKey: string, facetType: string, perFacetLimit: number) =>
	from(MetricsGauge)
		.select(($) => ({
			name: facetAttrExpr($.ResourceAttributes, attrKey),
			count: CH.uniq($.ResourceAttributes.get("k8s.node.name")),
			facetType: CH.lit(facetType),
		}))
		.where(($) => [
			...nodeBaseConditions($, [NODE_FACET_PROBE_METRIC]),
			...nodeFilterConditions($, opts),
			facetAttrExpr($.ResourceAttributes, attrKey).neq(""),
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

export type WorkloadFacetsOutput = FacetOutput

const makeWorkloadFacet = (
	opts: ListWorkloadsOpts,
	attrKey: string,
	facetType: string,
	perFacetLimit: number,
) => {
	const ownerKey = workloadAttrKey(opts.kind)
	return from(MetricsGauge)
		.select(($) => ({
			name: facetAttrExpr($.ResourceAttributes, attrKey),
			count: CH.uniq($.ResourceAttributes.get(ownerKey)),
			facetType: CH.lit(facetType),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
			$.ResourceAttributes.get(ownerKey).neq(""),
			$.MetricName.in_(POD_FACET_PROBE_METRIC),
			...workloadFilterConditions($, opts, ownerKey),
			facetAttrExpr($.ResourceAttributes, attrKey).neq(""),
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

// Infrastructure presence — which surfaces this org actually reports
//
// The sidebar's Infrastructure section has seven children, and almost no org
// runs all seven. To show only the ones an org has, something has to answer
// "does this surface report anything?" on every page load — so the probe has
// to be far cheaper than the list queries it gates.
//
// One branch per surface, each an existence check: a constant select list, a
// single probe metric, a bounded window, `LIMIT 1`. Deliberately NOT an
// aggregate — `count()` reads every matching row before the limit can trim its
// one output row, while a non-aggregating branch stops at the first hit, which
// is the whole point. One metric name rather than the surface's full set for
// the same reason: every pod emits `k8s.pod.cpu.usage` and every container
// `container.cpu.utilization`, so one name reaches the same population.
//
// A surface with nothing to report contributes NO row — presence is the row's
// existence, not a count in it. The set of surfaces is known to the caller, so
// there is nothing a zero row would say that an absent one does not.
//
// Callers pass a short window (an hour is plenty — this asks "is it reporting
// now?", not "has it ever").

/** Sidebar surfaces gated by the probe. `hosts` is `/infra` itself. */
export type InfraSurface = "hosts" | "containers" | "k8sPods" | "k8sNodes" | "k8sWorkloads"

export interface InfraPresenceOutput {
	readonly surface: string
}

/**
 * The three workload kinds share one branch: the sidebar has a single
 * "K8s Workloads" row, so which owner attribute is set doesn't change what it
 * shows — only whether *any* of them is.
 */
const WORKLOAD_OWNER_KEYS = [
	"k8s.deployment.name",
	"k8s.statefulset.name",
	"k8s.daemonset.name",
] as const

const presenceBranch = (
	surface: InfraSurface,
	metricName: string,
	identity: ($: ColumnAccessor<typeof MetricsGauge.columns>) => CH.Condition,
) =>
	from(MetricsGauge)
		.select(() => ({ surface: CH.lit(surface) }))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
			$.MetricName.eq(metricName),
			identity($),
		])
		.limit(1)

export function infraPresenceQuery(): CHUnionQuery<InfraPresenceOutput> {
	return unionAll(
		presenceBranch("hosts", "system.cpu.utilization", ($) =>
			$.ResourceAttributes.get("host.name").neq(""),
		),
		presenceBranch("containers", "container.cpu.utilization", ($) =>
			$.ResourceAttributes.get("container.name").neq(""),
		),
		presenceBranch("k8sPods", POD_FACET_PROBE_METRIC, ($) =>
			$.ResourceAttributes.get("k8s.pod.name").neq(""),
		),
		presenceBranch("k8sNodes", NODE_FACET_PROBE_METRIC, ($) =>
			$.ResourceAttributes.get("k8s.node.name").neq(""),
		),
		presenceBranch("k8sWorkloads", POD_FACET_PROBE_METRIC, ($) =>
			WORKLOAD_OWNER_KEYS.map((key) => $.ResourceAttributes.get(key).neq("")).reduce((a, b) =>
				a.or(b),
			),
		),
	).format("JSON")
}

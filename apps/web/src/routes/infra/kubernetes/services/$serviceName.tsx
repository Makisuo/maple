import { useMemo } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatPercent } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { GridIcon } from "@/components/icons"
import { QueryErrorState } from "@/components/common/query-error-state"
import { PodTable, PodTableLoading } from "@/components/infra/pod-table"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import { toIsoBucket } from "@/api/warehouse/timeseries-utils"
import { CorrelationStrips, type StripSeries } from "@/components/infra/service-lens/correlation-strips"
import { unifiedBucketDomain } from "@/components/infra/service-lens/bucket-domain"
import { ServiceLensShell } from "@/components/infra/service-lens/service-lens-shell"
import {
	deriveLensVerdict,
	lensHeadline,
	lensSubhead,
} from "@/components/infra/service-lens/service-lens-summary"
import {
	getServiceDetailOverviewResultAtom,
	getServiceWorkloadsResultAtom,
	listPodsResultAtom,
	workloadInfraTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import type { WorkloadKind } from "@/api/warehouse/infra"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"

/**
 * Kubernetes, read through one service.
 *
 * The other pages in this section start from the fleet and let you filter down
 * to a service. This one starts from the service and asks a question the fleet
 * view structurally cannot answer: is Kubernetes why this got slow? That is the
 * whole reason the page exists, and it's why latency and CPU-of-limit share a
 * time axis here instead of living on two different pages.
 */

const searchSchema = Schema.Struct(TimeRangeSearchFields)

export const Route = createFileRoute("/infra/kubernetes/services/$serviceName")({
	component: ServiceLensPage,
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

/** Matches the pod table's own page size on the browse route. */
const POD_LIMIT = 50

function ServiceLensPage() {
	const { serviceName } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		void navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	return (
		<ServiceLensShell
			activeService={serviceName}
			startTime={search.startTime ?? startTime}
			endTime={search.endTime ?? endTime}
			timeSearch={search}
			timePreset={search.timePreset ?? (search.startTime ? undefined : "12h")}
			onTimeChange={handleTimeChange}
		>
			<LensBody serviceName={serviceName} startTime={startTime} endTime={endTime} search={search} />
		</ServiceLensShell>
	)
}

function LensBody({
	serviceName,
	startTime,
	endTime,
	search,
}: {
	serviceName: string
	startTime: string
	endTime: string
	search: Record<string, unknown>
}) {
	const workloadsResult = useAtomValue(
		getServiceWorkloadsResultAtom({ data: { services: [serviceName], startTime, endTime } }),
	)

	// The dominant workload. `serviceWorkloads` reads the hourly MV, which takes
	// `max()` per attribute, so a service spread across several deployments
	// resolves to one — the same limitation the service page's Kubernetes panel
	// already has, surfaced here rather than papered over.
	//
	// A row can come back as kind "unknown" (the service emitted k8s attributes
	// that don't name a deployment/statefulset/daemonset). Narrowing it away here
	// rather than at each use is what lets the pod query and the workload link
	// take the kind directly.
	// The `find` runs outside the Result builder: the builder unifies its
	// success and fallback branches, which widens the guard's narrowing back to
	// the raw row type.
	//
	// Memoized on the Result, like every derivation below it: `Result.builder`
	// returns a NEW array each call, so anything that reads one of these as a
	// dependency re-runs on every render. That made the verdict, the strips and
	// the shared axis recompute on each hover of the linked cursor.
	const workload = useMemo(
		() =>
			firstLinkedWorkload(
				Result.builder(workloadsResult)
					.onSuccess((r) => r.workloads)
					.orElse(() => []),
			),
		[workloadsResult],
	)

	const overviewResult = useAtomValue(
		getServiceDetailOverviewResultAtom({ data: { serviceName, startTime, endTime } }),
	)

	const points = useMemo(
		() =>
			Result.builder(overviewResult)
				.onSuccess((r) => r.data)
				.orElse(() => []),
		[overviewResult],
	)

	/**
	 * The bucket width the SERVICE series actually came back on, so the pod gauges
	 * can be asked for the same one.
	 *
	 * Read off the response rather than recomputed: the overview endpoint picks
	 * its own width server-side, and `chartBucketSeconds` is a different rule. Two
	 * rules meant two grids, and a shared x axis over two grids draws each line as
	 * a comb of gaps. ClickHouse's `toStartOfInterval` is epoch-aligned, so equal
	 * widths over one window give byte-identical buckets.
	 */
	const bucketSeconds = useMemo(() => {
		const first = points[0]?.bucket
		const second = points[1]?.bucket
		if (first && second) {
			const delta = Math.round((bucketMs(second) - bucketMs(first)) / 1000)
			if (Number.isFinite(delta) && delta > 0) return delta
		}
		return chartBucketSeconds(startTime, endTime)
	}, [points, startTime, endTime])

	// `listPods` and the CPU series both need a resolved workload. Their atoms are
	// keyed on its name, so they simply don't fire until it lands — no effect, no
	// conditional hook.
	const cpuResult = useAtomValue(
		workloadInfraTimeseriesResultAtom({
			data: {
				kind: workload?.workloadKind ?? "deployment",
				workloadName: workload?.workloadName ?? "",
				namespace: workload?.namespace || undefined,
				metric: "cpu_limit",
				// Per pod, then collapsed to the worst below. Ungrouped, the query
				// AVERAGES every pod into one line, so three pods at 97% among
				// fifteen at 20% read as ~33% and the verdict can never see the
				// saturation it exists to find.
				groupByPod: true,
				startTime,
				endTime,
				bucketSeconds,
			},
		}),
	)

	const podsResult = useAtomValue(
		listPodsResultAtom({
			data: {
				startTime,
				endTime,
				workloadKind: workload?.workloadKind,
				workloadName: workload?.workloadName || undefined,
				namespaces: workload?.namespace ? [workload.namespace] : undefined,
				limit: POD_LIMIT,
			},
		}),
	)

	/**
	 * The pod gauges, re-keyed onto the service series' bucket format.
	 *
	 * These two endpoints return the SAME INSTANTS in different strings — the
	 * service overview emits `2026-08-31T10:00:00.000Z`, the infra timeseries
	 * emits the raw warehouse `2026-08-31 10:00:00`. Unioned and sorted, every
	 * space-format bucket sorts before every `T`-format one (' ' < 'T'), so the
	 * shared axis ran the window twice: once for CPU, then again for latency.
	 * `toIsoBucket` is the codebase's existing normalizer and is idempotent, so
	 * one format reaches the domain, the strips, and the verdict alike.
	 */
	const cpuRows = useMemo(
		() =>
			Result.builder(cpuResult)
				.onSuccess((r) => r.data.map((row) => ({ ...row, bucket: toIsoBucket(row.bucket) })))
				.orElse(() => []),
		[cpuResult],
	)
	const pods = useMemo(
		() =>
			Result.builder(podsResult)
				.onSuccess((r) => r.data)
				.orElse(() => []),
		[podsResult],
	)
	const totalPods = Result.builder(podsResult)
		.onSuccess((r) => r.totalCount)
		.orElse(() => 0)

	// One collapse, used by both the strip and the verdict, so the line you read
	// and the sentence above it are the same series.
	const worstCpuRows = useMemo(() => worstPerBucket(cpuRows), [cpuRows])

	const verdict = useMemo(
		() =>
			deriveLensVerdict({
				hasWorkload: workload != null,
				pods,
				// The true size of the workload — `pods` is a worst-first PAGE of it.
				totalPods,
				latency: points.map((point) => ({
					bucket: point.bucket,
					value: point.p99LatencyMs,
					// A zero-filled bucket is not a fast bucket; it is one the service
					// did not serve, and it must not drag the baseline to zero.
					hasTraffic: point.totalCount > 0,
				})),
				cpuOfLimit: worstCpuRows,
				bucketSeconds,
			}),
		[workload, pods, totalPods, points, worstCpuRows, bucketSeconds],
	)

	const strips: StripSeries[] = useMemo(
		() => [
			{
				id: "p99",
				label: "p99 latency",
				source: "from spans",
				unit: "milliseconds",
				rows: points.map((p) => ({
					bucket: p.bucket,
					attributeValue: "",
					value: p.p99LatencyMs,
				})),
			},
			{
				id: "cpu",
				label: "CPU of limit",
				source: workload ? `worst pod · ${workload.workloadName}` : "no workload",
				unit: "percent",
				showThreshold: true,
				rows: worstCpuRows.map((row) => ({ ...row, attributeValue: "" })),
			},
			{
				id: "throughput",
				label: "Throughput",
				source: "spans per second",
				unit: "rate",
				rows: points.map((p) => ({
					bucket: p.bucket,
					attributeValue: "",
					value: p.throughput,
				})),
			},
		],
		[points, worstCpuRows, workload],
	)

	// One axis for all three strips. Built from the union rather than from either
	// side alone: the service series and the pod gauges are produced by different
	// pipelines at different cadences, so neither one's grid contains the other's
	// — and they spell a bucket differently, which `unifiedBucketDomain` settles.
	const xDomain = useMemo(
		() => unifiedBucketDomain([points.map((p) => p.bucket), cpuRows.map((r) => r.bucket)]),
		[points, cpuRows],
	)

	if (Result.isFailure(overviewResult)) {
		return <QueryErrorState error={overviewResult.cause} titleOverride="Failed to load this service" />
	}

	// The headline reads pods and CPU as well as the overview, and both of those
	// atoms re-key once the workload resolves — so a naive gate on the first two
	// publishes a diagnosis over `[]` twice: once before pods land, once again
	// after the re-key. `Result.builder` turns a FAILURE into `[]` too, which is
	// indistinguishable from "no pods" and would read as a confident "healthy".
	const evidenceMissing = workload != null && (Result.isFailure(podsResult) || Result.isFailure(cpuResult))
	const loading =
		Result.isInitial(overviewResult) ||
		Result.isInitial(workloadsResult) ||
		(workload != null && (Result.isInitial(podsResult) || Result.isInitial(cpuResult)))
	const waiting =
		(Result.isSuccess(overviewResult) && overviewResult.waiting) ||
		(Result.isSuccess(cpuResult) && cpuResult.waiting)

	return (
		<div className="space-y-7 pb-4">
			<header className="space-y-3">
				{loading ? (
					<>
						<Skeleton className="h-9 w-[520px]" />
						<Skeleton className="h-4 w-[420px]" />
					</>
				) : evidenceMissing ? (
					<>
						<h1 className="max-w-[820px] text-[30px] font-semibold leading-[1.15] tracking-tight text-foreground">
							{serviceName} — evidence incomplete.
						</h1>
						<p className="max-w-[700px] text-[13px] leading-relaxed text-muted-foreground">
							The pod list or the CPU series failed to load, so this page can't say whether
							Kubernetes is involved. The charts below show what did arrive.
						</p>
					</>
				) : (
					<>
						<h1 className="max-w-[820px] text-[30px] font-semibold leading-[1.15] tracking-tight text-foreground">
							{lensHeadline(verdict, serviceName)}
						</h1>
						<p className="max-w-[700px] text-[13px] leading-relaxed text-muted-foreground">
							{lensSubhead(verdict)}
						</p>
					</>
				)}
				{workload && (
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 font-mono text-[11px] text-muted-foreground">
						<Link
							to="/infra/kubernetes/workloads/$kind/$workloadName"
							params={{ kind: workload.workloadKind, workloadName: workload.workloadName }}
							search={{ namespace: workload.namespace || undefined }}
							className="hover:text-foreground"
						>
							{workload.workloadKind} {workload.workloadName}
						</Link>
						{workload.namespace && <span>ns {workload.namespace}</span>}
						{workload.clusterName && <span>cluster {workload.clusterName}</span>}
						<Link
							to="/services/$serviceName"
							params={{ serviceName }}
							search={search}
							className="text-primary hover:underline"
						>
							Open the service
						</Link>
					</div>
				)}
			</header>

			{workload == null && !loading ? (
				<Empty className="py-16">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<GridIcon size={16} />
						</EmptyMedia>
						<EmptyTitle>No Kubernetes workload for {serviceName}</EmptyTitle>
						<EmptyDescription>
							Maple links a service to its pods through the k8s.deployment.name (or statefulset
							/ daemonset) attribute on its spans. Enable the k8sattributes processor in the
							Helm chart so the collector tags them.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<>
					<section className="space-y-2.5">
						<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
							<h2 className="text-[13px] font-medium text-foreground">
								Service signal over infrastructure signal
							</h2>
							<span className="font-mono text-[11px] text-muted-foreground">
								one cursor, one time axis
							</span>
						</div>
						{loading ? (
							<Skeleton className="h-[360px] w-full rounded-lg" />
						) : (
							<CorrelationStrips series={strips} xDomain={xDomain} waiting={waiting} />
						)}
					</section>

					<section className="space-y-2.5">
						<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
							<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
								<h2 className="text-[13px] font-medium text-foreground">
									The pods behind this service
								</h2>
								<span className="font-mono text-[11px] text-muted-foreground">
									worst first, by peak saturation
								</span>
							</div>
							<span className="font-mono text-[11px] tabular-nums text-muted-foreground">
								{totalPods > pods.length
									? `Top ${pods.length} of ${totalPods.toLocaleString()}`
									: `${totalPods.toLocaleString()} ${totalPods === 1 ? "pod" : "pods"}`}
							</span>
						</div>
						{Result.builder(podsResult)
							.onInitial(() => <PodTableLoading />)
							.onError((error) => (
								<QueryErrorState error={error} titleOverride="Failed to load pods" />
							))
							.onSuccess((response, holder) =>
								response.data.length === 0 ? (
									<div className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
										No pods reported for this workload in the selected window.
									</div>
								) : (
									<PodTable
										pods={response.data}
										waiting={Boolean(holder.waiting)}
										referenceTime={endTime}
									/>
								),
							)
							.render()}
					</section>

					{workload && <PodDistribution pods={pods} className={cn(waiting && "opacity-60")} />}
				</>
			)}
		</div>
	)
}

/**
 * Which nodes this service landed on.
 *
 * The design called for a group-by control on the pod table; this is the part
 * of it that earns its place on a first pass — "all three hot pods share one
 * node" is the observation that turns a service problem into a placement
 * problem, and it needs no new query.
 */
function PodDistribution({
	pods,
	className,
}: {
	pods: ReadonlyArray<{ nodeName: string; saturation: number }>
	className?: string
}) {
	const byNode = useMemo(() => {
		const map = new Map<string, { count: number; worst: number }>()
		for (const pod of pods) {
			const node = pod.nodeName || "unknown"
			const existing = map.get(node) ?? { count: 0, worst: 0 }
			map.set(node, {
				count: existing.count + 1,
				worst: Math.max(existing.worst, pod.saturation),
			})
		}
		return [...map.entries()].sort((a, b) => b[1].worst - a[1].worst)
	}, [pods])

	if (byNode.length <= 1) return null

	return (
		<section className={cn("space-y-2.5", className)}>
			<h2 className="text-[13px] font-medium text-foreground">Spread across nodes</h2>
			<div className="flex flex-wrap gap-2">
				{byNode.map(([node, { count, worst }]) => (
					<Link
						key={node}
						to="/infra/kubernetes/nodes/$nodeName"
						params={{ nodeName: node }}
						className="flex items-center gap-2.5 rounded-md border px-2.5 py-1.5 font-mono text-[11px] transition-colors hover:bg-accent/50"
					>
						<span className="text-foreground">{node}</span>
						<span className="text-muted-foreground">
							{count} {count === 1 ? "pod" : "pods"}
						</span>
						<span className="tabular-nums text-muted-foreground">
							worst {formatPercent(worst)}
						</span>
					</Link>
				))}
			</div>
		</section>
	)
}

/**
 * A bucket's epoch ms, whichever of the two formats it arrived in.
 *
 * The previous version appended "Z" unconditionally, which is right for the
 * warehouse's `2026-08-31 10:00:00` and produces `…000ZZ` — an Invalid Date —
 * for the overview's already-ISO strings. The width derivation silently fell
 * back to the default, which is why the pod gauges came back on ten-minute
 * buckets while latency was on five.
 */
function bucketMs(bucket: string): number {
	return new Date(toIsoBucket(bucket)).getTime()
}

/** A workload row this page can actually query: one with a real k8s kind. */
interface LinkedWorkload {
	workloadKind: WorkloadKind
	workloadName: string
	namespace: string
	clusterName: string
	podCount: number
	avgCpuLimitUtilization: number | null
}

/**
 * The first workload row with a kind the downstream queries accept.
 *
 * `serviceWorkloads` reports kind "unknown" when a service carries k8s
 * attributes that name no deployment, statefulset, or daemonset. Rebuilding the
 * row around the narrowed kind — rather than asserting it — is what keeps this
 * cast-free while still handing `listPods` and the CPU series a real kind.
 */
function firstLinkedWorkload(
	workloads: ReadonlyArray<{
		workloadKind: "deployment" | "statefulset" | "daemonset" | "unknown"
		workloadName: string
		namespace: string
		clusterName: string
		podCount: number
		avgCpuLimitUtilization: number | null
	}>,
): LinkedWorkload | null {
	for (const workload of workloads) {
		const { workloadKind } = workload
		if (workloadKind === "unknown") continue
		return { ...workload, workloadKind }
	}
	return null
}

/**
 * Collapse a possibly per-pod series to the worst value in each bucket.
 *
 * The verdict asks "when did this workload first hit its limit", and a workload
 * hits its limit when any of its pods does — an average across pods would hide
 * exactly the three-of-eighteen case the page is built to show.
 */
function worstPerBucket(
	rows: ReadonlyArray<{ bucket: string; value: number }>,
): Array<{ bucket: string; value: number }> {
	const byBucket = new Map<string, number>()
	for (const row of rows) {
		const current = byBucket.get(row.bucket)
		if (current === undefined || row.value > current) byBucket.set(row.bucket, row.value)
	}
	return [...byBucket.entries()]
		.map(([bucket, value]) => ({ bucket, value }))
		.sort((a, b) => a.bucket.localeCompare(b.bucket))
}

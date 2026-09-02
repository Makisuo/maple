import { useState } from "react"
import { DetailRail } from "@maple/ui/components/detail-rail"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { Schema } from "effect"

import { Card, CardContent, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatPercent } from "@maple/ui/lib/format"

import type { WorkloadInfraMetric, WorkloadKind } from "@/api/warehouse/infra"
import { QueryErrorState } from "@/components/common/query-error-state"
import { GridIcon } from "@/components/icons"
import { KubernetesShell } from "@/components/infra/kubernetes/kubernetes-shell"
import { WorkloadDetailChart } from "@/components/infra/k8s-detail-chart"
import { PodTable } from "@/components/infra/pod-table"
import { bucketSecondsForRange } from "@/components/infra/constants"
import { severityLevel } from "@/components/infra/format"
import { PageHero, HeroChip } from "@/components/infra/primitives/page-hero"
import { SegmentPivot } from "@/components/infra/primitives/segment-pivot"
import { StatRail, StatRailItem } from "@/components/infra/primitives/stat-rail"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
} from "@/components/time-range-picker/search"
import {
	listPodsResultAtom,
	workloadDetailSummaryResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

const DEFAULT_PRESET = "1h"

const workloadDetailSearchSchema = Schema.Struct({
	namespace: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

const WorkloadKindSchema = Schema.Literals(["deployment", "statefulset", "daemonset"])

const paramsSchema = Schema.Struct({
	kind: WorkloadKindSchema,
	workloadName: Schema.String,
})

export const Route = createFileRoute("/infra/kubernetes/workloads/$kind/$workloadName")({
	component: WorkloadDetailPage,
	validateSearch: Schema.toStandardSchemaV1(workloadDetailSearchSchema),
	params: {
		parse: (raw) => Schema.decodeUnknownSync(paramsSchema)(raw),
		stringify: (p) => ({ kind: p.kind, workloadName: p.workloadName }),
	},
})

const METRIC_OPTIONS = [
	{ value: "cpu_limit", label: "CPU / limit" },
	{ value: "memory_limit", label: "Mem / limit" },
	{ value: "cpu_usage", label: "CPU cores" },
] as const satisfies ReadonlyArray<{ value: WorkloadInfraMetric; label: string }>

const KIND_LABEL: Record<WorkloadKind, string> = {
	deployment: "Deployment",
	statefulset: "StatefulSet",
	daemonset: "DaemonSet",
} satisfies Record<WorkloadKind, string>

function WorkloadDetailPage() {
	const params = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const namespace = search.namespace
	const [metric, setMetric] = useState<WorkloadInfraMetric>("cpu_limit")
	const [groupByPod, setGroupByPod] = useState(true)

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const bucketSeconds = bucketSecondsForRange(startTime, endTime)

	const summaryAtom = workloadDetailSummaryResultAtom({
		data: { kind: params.kind, workloadName: params.workloadName, namespace, startTime, endTime },
	})
	const podsAtom = listPodsResultAtom({
		data: {
			workloadKind: params.kind,
			workloadName: params.workloadName,
			namespaces: namespace ? [namespace] : undefined,
			startTime,
			endTime,
			limit: 200,
		},
	})
	const summaryResult = useAtomValue(summaryAtom)
	const podsResult = useAtomValue(podsAtom)
	const refreshSummary = useAtomRefresh(summaryAtom)
	const refreshPods = useAtomRefresh(podsAtom)

	const summary = Result.builder(summaryResult)
		.onSuccess((r) => r.data)
		.orElse(() => null)

	const rightPanel = summary ? (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-sm font-medium">
					<GridIcon size={14} className="text-muted-foreground" />
					Resource attributes
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-1">
				<DetailRail.MetaRow label="kind" value={KIND_LABEL[params.kind]} />
				<DetailRail.MetaRow label={`k8s.${params.kind}.name`} value={summary.workloadName} />
				<DetailRail.MetaRow label="k8s.namespace.name" value={summary.namespace} />
				<DetailRail.MetaRow label="pods" value={String(summary.podCount)} />
			</CardContent>
		</Card>
	) : null

	return (
		<KubernetesShell
			view="workloads"
			trail={[{ label: params.workloadName }]}
			timeSearch={search}
			startTime={startTime}
			endTime={endTime}
			defaultPreset={DEFAULT_PRESET}
			onTimeChange={(range, options) =>
				void navigate({
					replace: options?.replace,
					search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
				})
			}
			rightPanel={rightPanel}
		>
			<div className="space-y-6">
				<PageHero
					title={<span className="font-mono">{params.workloadName}</span>}
					description={`${KIND_LABEL[params.kind]}${
						namespace ? ` in namespace ${namespace}` : ""
					} — aggregated from pod metrics.`}
					meta={
						<>
							{namespace && <HeroChip>ns {namespace}</HeroChip>}
							<HeroChip>kind {params.kind}</HeroChip>
							{summary && <HeroChip>{summary.podCount} pods</HeroChip>}
						</>
					}
				/>

				{Result.isInitial(summaryResult) ? (
					<Skeleton className="h-24 w-full rounded-md" />
				) : Result.isFailure(summaryResult) ? (
					<QueryErrorState
						error={summaryResult.cause}
						titleOverride="Failed to load workload metrics"
						onRetry={refreshSummary}
					/>
				) : summary ? (
					<StatRail>
						<StatRailItem eyebrow="Pods" value={String(summary.podCount)} compact />
						<StatRailItem
							eyebrow="Avg CPU vs limit"
							value={formatPercent(summary.avgCpuLimitPct)}
							tone={severityLevel(summary.avgCpuLimitPct)}
							compact
						/>
						<StatRailItem
							eyebrow="Avg memory vs limit"
							value={formatPercent(summary.avgMemoryLimitPct)}
							tone={severityLevel(summary.avgMemoryLimitPct)}
							compact
						/>
						<StatRailItem
							eyebrow="Avg CPU cores"
							value={
								Number.isFinite(summary.avgCpuUsage) ? summary.avgCpuUsage.toFixed(3) : "—"
							}
							compact
						/>
					</StatRail>
				) : (
					<div className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
						No metrics arrived for this workload in the selected window.
					</div>
				)}

				<div className="space-y-3">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<SegmentPivot
							ariaLabel="Metric"
							options={METRIC_OPTIONS}
							value={metric}
							onChange={setMetric}
						/>
						<label className="inline-flex items-center gap-2 text-[11px] text-muted-foreground">
							<input
								type="checkbox"
								checked={groupByPod}
								onChange={(e) => setGroupByPod(e.target.checked)}
								className="size-3 accent-primary"
							/>
							Per-pod breakdown
						</label>
					</div>

					<WorkloadDetailChart
						kind={params.kind}
						workloadName={params.workloadName}
						namespace={namespace}
						metric={metric}
						groupByPod={groupByPod}
						startTime={startTime}
						endTime={endTime}
						bucketSeconds={bucketSeconds}
					/>
				</div>

				<div className="space-y-3">
					<h3 className="text-sm font-medium">Pods</h3>
					{Result.builder(podsResult)
						.onInitial(() => <Skeleton className="h-28 w-full rounded-md" />)
						.onError((error) => (
							<QueryErrorState
								error={error}
								titleOverride="Failed to load workload pods"
								onRetry={refreshPods}
							/>
						))
						.onSuccess((r) => {
							const pods = r.data
							if (pods.length === 0) {
								return (
									<div className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
										No pods reporting for this workload in the selected window.
									</div>
								)
							}
							return (
								<PodTable
									pods={pods}
									timeSearch={pickTimeRangeSearch(search)}
									referenceTime={endTime}
								/>
							)
						})
						.render()}
				</div>
			</div>
		</KubernetesShell>
	)
}

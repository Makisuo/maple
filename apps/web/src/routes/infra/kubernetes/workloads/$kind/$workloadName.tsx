import { useState } from "react"
import { Navigate, createFileRoute } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { Schema } from "effect"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { QueryErrorState } from "@/components/common/query-error-state"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { GridIcon } from "@/components/icons"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import { WorkloadDetailChart } from "@/components/infra/k8s-detail-chart"
import { PodTable } from "@/components/infra/pod-table"
import { PageHero, HeroChip } from "@/components/infra/primitives/page-hero"
import { StatRail, StatRailItem } from "@/components/infra/primitives/stat-rail"
import {
	listPodsResultAtom,
	workloadDetailSummaryResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { TIME_PRESETS, bucketSecondsFor } from "@/components/infra/constants"
import { formatPercent, severityLevel } from "@/components/infra/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import type { WorkloadInfraMetric, WorkloadKind } from "@/api/warehouse/infra"

const workloadDetailSearchSchema = Schema.Struct({
	namespace: Schema.optional(Schema.String),
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

const METRIC_TABS = [
	{ value: "cpu_limit", label: "CPU / limit" },
	{ value: "memory_limit", label: "Mem / limit" },
	{ value: "cpu_usage", label: "CPU cores" },
] as const

const KIND_LABEL: Record<WorkloadKind, string> = {
	deployment: "Deployment",
	statefulset: "StatefulSet",
	daemonset: "DaemonSet",
}

function WorkloadDetailPage() {
	const infraEnabled = useInfraEnabled()
	if (!infraEnabled) return <Navigate to="/" replace />
	return <WorkloadDetailContent />
}

function WorkloadDetailContent() {
	const params = Route.useParams()
	const search = Route.useSearch()
	const namespace = search.namespace
	const [preset, setPreset] = useState("1h")
	const [metric, setMetric] = useState<WorkloadInfraMetric>("cpu_limit")
	const [groupByPod, setGroupByPod] = useState(true)

	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, preset)
	const bucketSeconds = bucketSecondsFor(preset)

	const summaryAtom = workloadDetailSummaryResultAtom({
		data: {
			kind: params.kind,
			workloadName: params.workloadName,
			namespace,
			startTime,
			endTime,
		},
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

	const toolbar = (
		<Select value={preset} onValueChange={(v) => v && setPreset(v)}>
			<SelectTrigger className="w-[180px]">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{TIME_PRESETS.map((p) => (
					<SelectItem key={p.value} value={p.value}>
						{p.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)

	const rightSidebar = summary ? (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-sm font-medium">
					<GridIcon size={14} className="text-muted-foreground" />
					Resource attributes
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-1">
				<MetaRow label="kind" value={KIND_LABEL[params.kind]} />
				<MetaRow label={`k8s.${params.kind}.name`} value={summary.workloadName} />
				<MetaRow label="k8s.namespace.name" value={summary.namespace} />
				<MetaRow label="pods" value={String(summary.podCount)} />
			</CardContent>
		</Card>
	) : null

	return (
		<DashboardLayout
			breadcrumbs={[
				{ label: "Infrastructure", href: "/infra" },
				{ label: "Kubernetes" },
				{ label: "Workloads", href: "/infra/kubernetes/workloads" },
				{ label: params.workloadName },
			]}
			headerActions={toolbar}
			rightSidebar={rightSidebar}
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
					<div className="flex items-center justify-between gap-3">
						<div className="flex items-center gap-1 rounded-md border bg-background p-0.5">
							{METRIC_TABS.map((tab) => {
								const active = metric === tab.value
								return (
									<button
										key={tab.value}
										type="button"
										onClick={() => setMetric(tab.value)}
										className={cn(
											"rounded-sm px-2.5 py-1 text-[11px] font-medium transition-colors",
											active
												? "bg-foreground text-background"
												: "text-muted-foreground hover:text-foreground",
										)}
									>
										{tab.label}
									</button>
								)
							})}
						</div>
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
							return <PodTable pods={pods} />
						})
						.render()}
				</div>
			</div>
		</DashboardLayout>
	)
}

function MetaRow({ label, value }: { label: string; value: string | null | undefined }) {
	if (!value) return null
	return (
		<div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 last:border-0">
			<span className="font-mono text-[11px] text-muted-foreground">{label}</span>
			<span className="break-all text-right font-mono text-[11px] tabular-nums text-foreground/85">
				{value}
			</span>
		</div>
	)
}

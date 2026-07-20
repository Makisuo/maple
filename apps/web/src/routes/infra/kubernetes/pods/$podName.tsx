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
import { FolderIcon } from "@/components/icons"
import { useInfraEnabled } from "@/hooks/use-infra-enabled"
import { PodDetailChart } from "@/components/infra/k8s-detail-chart"
import { PageHero, HeroChip } from "@/components/infra/primitives/page-hero"
import { StatRail, StatRailItem } from "@/components/infra/primitives/stat-rail"
import { podDetailSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { TIME_PRESETS, bucketSecondsFor } from "@/components/infra/constants"
import { formatPercent, severityLevel } from "@/components/infra/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import type { PodInfraMetric } from "@/api/warehouse/infra"

const podDetailSearchSchema = Schema.Struct({
	namespace: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/infra/kubernetes/pods/$podName")({
	component: PodDetailPage,
	validateSearch: Schema.toStandardSchemaV1(podDetailSearchSchema),
})

const METRIC_TABS = [
	{ value: "cpu_usage", label: "CPU cores" },
	{ value: "cpu_limit", label: "CPU / limit" },
	{ value: "cpu_request", label: "CPU / request" },
	{ value: "memory_limit", label: "Mem / limit" },
	{ value: "memory_request", label: "Mem / request" },
] as const

function PodDetailPage() {
	const infraEnabled = useInfraEnabled()
	if (!infraEnabled) return <Navigate to="/" replace />
	return <PodDetailContent />
}

function PodDetailContent() {
	const { podName } = Route.useParams()
	const search = Route.useSearch()
	const namespace = search.namespace
	const [preset, setPreset] = useState("1h")
	const [metric, setMetric] = useState<PodInfraMetric>("cpu_usage")

	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, preset)
	const bucketSeconds = bucketSecondsFor(preset)

	const summaryAtom = podDetailSummaryResultAtom({
		data: { podName, namespace, startTime, endTime },
	})
	const summaryResult = useAtomValue(summaryAtom)
	const refreshSummary = useAtomRefresh(summaryAtom)

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
					<FolderIcon size={14} className="text-muted-foreground" />
					Resource attributes
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-1">
				<MetaRow label="k8s.pod.name" value={summary.podName} />
				<MetaRow label="k8s.namespace.name" value={summary.namespace} />
				<MetaRow label="k8s.node.name" value={summary.nodeName} />
				<MetaRow label="k8s.pod.uid" value={summary.podUid} />
				<MetaRow label="k8s.pod.qos_class" value={summary.qosClass} />
				<MetaRow label="k8s.deployment.name" value={summary.deploymentName} />
				<MetaRow label="k8s.statefulset.name" value={summary.statefulsetName} />
				<MetaRow label="k8s.daemonset.name" value={summary.daemonsetName} />
				<MetaRow label="k8s.pod.start_time" value={summary.podStartTime} />
			</CardContent>
		</Card>
	) : null

	return (
		<DashboardLayout
			breadcrumbs={[
				{ label: "Infrastructure", href: "/infra" },
				{ label: "Kubernetes" },
				{ label: "Pods", href: "/infra/kubernetes/pods" },
				{ label: podName },
			]}
			headerActions={toolbar}
			rightSidebar={rightSidebar}
		>
			<div className="space-y-6">
				<PageHero
					title={<span className="font-mono">{podName}</span>}
					description="Pod metrics from kubelet stats receiver."
					meta={
						<>
							{namespace && <HeroChip>ns {namespace}</HeroChip>}
							{summary?.nodeName && <HeroChip>node {summary.nodeName}</HeroChip>}
							{summary?.qosClass && <HeroChip>qos {summary.qosClass}</HeroChip>}
						</>
					}
				/>

				{Result.isInitial(summaryResult) ? (
					<Skeleton className="h-24 w-full rounded-md" />
				) : Result.isFailure(summaryResult) ? (
					<QueryErrorState
						error={summaryResult.cause}
						titleOverride="Failed to load pod metrics"
						onRetry={refreshSummary}
					/>
				) : summary ? (
					<StatRail>
						<StatRailItem
							eyebrow="CPU vs limit"
							value={formatPercent(summary.cpuLimitPct)}
							tone={severityLevel(summary.cpuLimitPct)}
							compact
						/>
						<StatRailItem
							eyebrow="CPU vs request"
							value={formatPercent(summary.cpuRequestPct)}
							compact
						/>
						<StatRailItem
							eyebrow="Memory vs limit"
							value={formatPercent(summary.memoryLimitPct)}
							tone={severityLevel(summary.memoryLimitPct)}
							compact
						/>
						<StatRailItem
							eyebrow="Memory vs request"
							value={formatPercent(summary.memoryRequestPct)}
							compact
						/>
					</StatRail>
				) : (
					<div className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
						No metrics arrived for this pod in the selected window.
					</div>
				)}

				<div className="space-y-3">
					<div className="flex flex-wrap items-center gap-1 rounded-md border bg-background p-0.5 self-start w-fit">
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
					<PodDetailChart
						podName={podName}
						namespace={namespace}
						metric={metric}
						startTime={startTime}
						endTime={endTime}
						bucketSeconds={bucketSeconds}
					/>
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

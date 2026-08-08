import { useState } from "react"
import { DetailRail } from "@maple/ui/components/detail-rail"
import { createFileRoute } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { cn } from "@maple/ui/lib/utils"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ServerIcon } from "@/components/icons"
import { NodeDetailChart } from "@/components/infra/k8s-detail-chart"
import { PodTable } from "@/components/infra/pod-table"
import { PageHero, HeroChip } from "@/components/infra/primitives/page-hero"
import { StatRail, StatRailItem } from "@/components/infra/primitives/stat-rail"
import { listPodsResultAtom, nodeDetailSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { TIME_PRESETS, bucketSecondsFor } from "@/components/infra/constants"
import { formatUptime } from "@maple/ui/lib/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import type { NodeInfraMetric } from "@/api/warehouse/infra"

export const Route = createFileRoute("/infra/kubernetes/nodes/$nodeName")({
	component: NodeDetailPage,
})

const METRIC_TABS = [
	{ value: "cpu_usage", label: "CPU cores" },
	{ value: "uptime", label: "Uptime" },
] as const

function NodeDetailPage() {
	const { nodeName } = Route.useParams()
	const [preset, setPreset] = useState("1h")
	const [metric, setMetric] = useState<NodeInfraMetric>("cpu_usage")

	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, preset)
	const bucketSeconds = bucketSecondsFor(preset)

	const summaryResult = useAtomValue(
		nodeDetailSummaryResultAtom({
			data: { nodeName, startTime, endTime },
		}),
	)

	const podsResult = useAtomValue(
		listPodsResultAtom({
			data: { nodeNames: [nodeName], startTime, endTime, limit: 200 },
		}),
	)

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
					<ServerIcon size={14} className="text-muted-foreground" />
					Resource attributes
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-1">
				<DetailRail.MetaRow label="k8s.node.name" value={summary.nodeName} />
				<DetailRail.MetaRow label="k8s.node.uid" value={summary.nodeUid} />
				<DetailRail.MetaRow label="k8s.kubelet.version" value={summary.kubeletVersion} />
				<DetailRail.MetaRow label="container.runtime" value={summary.containerRuntime} />
			</CardContent>
		</Card>
	) : null

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[
					{ label: "Infrastructure", href: "/infra" },
					{ label: "Kubernetes" },
					{ label: "Nodes", href: "/infra/kubernetes/nodes" },
					{ label: nodeName },
				]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header>{toolbar}</DashboardLayout.Header>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<div className="space-y-6">
							<PageHero
								title={<span className="font-mono">{nodeName}</span>}
								description="Node metrics from kubelet stats receiver."
								meta={
									summary ? (
										<>
											{summary.kubeletVersion && (
												<HeroChip>kubelet {summary.kubeletVersion}</HeroChip>
											)}
											{summary.containerRuntime && (
												<HeroChip>runtime {summary.containerRuntime}</HeroChip>
											)}
										</>
									) : undefined
								}
							/>

							{summary ? (
								<StatRail columns={3}>
									<StatRailItem
										eyebrow="CPU cores"
										value={
											Number.isFinite(summary.cpuUsage)
												? summary.cpuUsage.toFixed(2)
												: "—"
										}
										compact
									/>
									<StatRailItem
										eyebrow="Uptime"
										value={formatUptime(summary.uptime)}
										compact
									/>
									<StatRailItem
										eyebrow="Kubelet"
										value={summary.kubeletVersion || "—"}
										compact
									/>
								</StatRail>
							) : (
								<div className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
									No metrics arrived for this node in the selected window.
								</div>
							)}

							<div className="space-y-3">
								<div className="flex items-center gap-1 rounded-md border bg-background p-0.5 self-start w-fit">
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
								<NodeDetailChart
									nodeName={nodeName}
									metric={metric}
									startTime={startTime}
									endTime={endTime}
									bucketSeconds={bucketSeconds}
								/>
							</div>

							<div className="space-y-3">
								<h3 className="text-sm font-medium">Pods on this node</h3>
								{Result.builder(podsResult)
									.onSuccess((r) => {
										const pods = r.data
										if (pods.length === 0) {
											return (
												<div className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
													No pods reporting on this node in the selected window.
												</div>
											)
										}
										return <PodTable pods={pods} />
									})
									.orElse(() => null)}
							</div>
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
				<DashboardLayout.RightPanel>{rightSidebar}</DashboardLayout.RightPanel>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

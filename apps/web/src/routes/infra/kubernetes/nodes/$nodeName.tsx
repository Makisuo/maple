import { useState } from "react"
import { DetailRail } from "@maple/ui/components/detail-rail"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Schema } from "effect"

import { Card, CardContent, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { formatUptime } from "@maple/ui/lib/format"

import type { NodeInfraMetric } from "@/api/warehouse/infra"
import { ServerIcon } from "@/components/icons"
import { KubernetesShell } from "@/components/infra/kubernetes/kubernetes-shell"
import { NodeDetailChart } from "@/components/infra/k8s-detail-chart"
import { PodTable } from "@/components/infra/pod-table"
import { bucketSecondsForRange } from "@/components/infra/constants"
import { PageHero, HeroChip } from "@/components/infra/primitives/page-hero"
import { SegmentPivot } from "@/components/infra/primitives/segment-pivot"
import { StatRail, StatRailItem } from "@/components/infra/primitives/stat-rail"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
} from "@/components/time-range-picker/search"
import { listPodsResultAtom, nodeDetailSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

const DEFAULT_PRESET = "1h"

const nodeDetailSearchSchema = Schema.Struct(TimeRangeSearchFields)

export const Route = createFileRoute("/infra/kubernetes/nodes/$nodeName")({
	component: NodeDetailPage,
	validateSearch: Schema.toStandardSchemaV1(nodeDetailSearchSchema),
})

const METRIC_OPTIONS = [
	{ value: "cpu_usage", label: "CPU cores" },
	{ value: "uptime", label: "Uptime" },
] as const satisfies ReadonlyArray<{ value: NodeInfraMetric; label: string }>

function NodeDetailPage() {
	const { nodeName } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const [metric, setMetric] = useState<NodeInfraMetric>("cpu_usage")

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const bucketSeconds = bucketSecondsForRange(startTime, endTime)

	const summaryResult = useAtomValue(
		nodeDetailSummaryResultAtom({ data: { nodeName, startTime, endTime } }),
	)
	const podsResult = useAtomValue(
		listPodsResultAtom({ data: { nodeNames: [nodeName], startTime, endTime, limit: 200 } }),
	)

	const summary = Result.builder(summaryResult)
		.onSuccess((r) => r.data)
		.orElse(() => null)

	const rightPanel = summary ? (
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
		<KubernetesShell
			view="nodes"
			trail={[{ label: nodeName }]}
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
					title={<span className="font-mono">{nodeName}</span>}
					description="Node metrics from the kubelet stats receiver."
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
							value={Number.isFinite(summary.cpuUsage) ? summary.cpuUsage.toFixed(2) : "—"}
							compact
						/>
						<StatRailItem eyebrow="Uptime" value={formatUptime(summary.uptime)} compact />
						<StatRailItem eyebrow="Kubelet" value={summary.kubeletVersion || "—"} compact />
					</StatRail>
				) : (
					<div className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
						No metrics arrived for this node in the selected window.
					</div>
				)}

				<div className="space-y-3">
					<SegmentPivot
						ariaLabel="Metric"
						options={METRIC_OPTIONS}
						value={metric}
						onChange={setMetric}
					/>
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
							return (
								<PodTable
									pods={pods}
									timeSearch={pickTimeRangeSearch(search)}
									referenceTime={endTime}
								/>
							)
						})
						.orElse(() => null)}
				</div>
			</div>
		</KubernetesShell>
	)
}

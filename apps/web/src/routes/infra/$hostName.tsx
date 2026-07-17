import { useState } from "react"
import { Navigate, createFileRoute } from "@tanstack/react-router"
import { Result, useAtomValue, useAtomRefresh } from "@/lib/effect-atom"

import { useInfraEnabled } from "@/hooks/use-infra-enabled"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ErrorState } from "@/components/common/error-state"
import { HostDetailHeader, HostDetailHeaderLoading } from "@/components/infra/host-detail-header"
import { MetricStrip } from "@/components/infra/host-detail-chart"
import { HostMetadataPanel } from "@/components/infra/host-metadata-panel"
import { hostDetailSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { TIME_PRESETS, bucketSecondsFor } from "@/components/infra/constants"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useLinkedCursor } from "@/hooks/use-linked-cursor"

export const Route = createFileRoute("/infra/$hostName")({
	component: HostDetailPage,
})

const METRIC_STRIPS = [
	{ metric: "cpu", label: "CPU", caption: "Per-mode utilization · stacked area" },
	{ metric: "memory", label: "Memory", caption: "Used / cached / free · stacked" },
	{ metric: "filesystem", label: "Filesystem", caption: "Mountpoint utilization" },
	{ metric: "network", label: "Network", caption: "Throughput in/out per device" },
	{ metric: "load15", label: "Load 15m", caption: "Linux load average" },
] as const

function HostDetailPage() {
	const infraEnabled = useInfraEnabled()
	if (!infraEnabled) return <Navigate to="/" replace />
	return <HostDetailPageContent />
}

function HostDetailPageContent() {
	const { hostName } = Route.useParams()
	const [preset, setPreset] = useState("1h")

	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, preset)
	const bucketSeconds = bucketSecondsFor(preset)

	const summaryAtom = hostDetailSummaryResultAtom({
		data: { hostName, startTime, endTime },
	})
	const summaryResult = useAtomValue(summaryAtom)
	const refreshSummary = useAtomRefresh(summaryAtom)

	const summary = Result.builder(summaryResult)
		.onSuccess((r) => r.data)
		.orElse(() => null)

	const rightSidebar = <HostMetadataPanel summary={summary} />

	// Linked hover cursor across the metric strips (charts stay independent —
	// no Recharts syncId render storms).
	const { containerProps: linkedCursorContainerProps } = useLinkedCursor(true)

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

	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Infrastructure", href: "/infra" }, { label: hostName }]}
			headerActions={toolbar}
			rightSidebar={rightSidebar}
		>
			<div className="space-y-8">
				{Result.builder(summaryResult)
					.onInitial(() => <HostDetailHeaderLoading />)
					.onError((error) => (
						<ErrorState
							variant="inline"
							error={error}
							title="Failed to load host summary"
							onRetry={refreshSummary}
						/>
					))
					.onSuccess((r) => <HostDetailHeader summary={r.data} hostName={hostName} />)
					.render()}

				<div className="rounded-md border bg-card">
					<div className="flex items-baseline justify-between gap-3 border-b px-4 py-2.5">
						<span className="text-sm font-medium">Metrics</span>
						<span className="text-xs tabular-nums text-muted-foreground">
							{METRIC_STRIPS.length} signals · {preset}
						</span>
					</div>
					<div className="px-4" {...linkedCursorContainerProps}>
						{METRIC_STRIPS.map((strip) => (
							<MetricStrip
								key={strip.metric}
								label={strip.label}
								caption={strip.caption}
								hostName={hostName}
								metric={strip.metric}
								startTime={startTime}
								endTime={endTime}
								bucketSeconds={bucketSeconds}
								syncId={`host-${hostName}`}
							/>
						))}
					</div>
				</div>
			</div>
		</DashboardLayout>
	)
}

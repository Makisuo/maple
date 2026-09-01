import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useHotkeys } from "@tanstack/react-hotkeys"

import { Button } from "@maple/ui/components/ui/button"
import { Kbd } from "@maple/ui/components/ui/kbd"
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetPanel,
	SheetTitle,
} from "@maple/ui/components/ui/sheet"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatPercent } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"

import type { PodInfraMetric } from "@/api/warehouse/infra"
import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon } from "@/components/icons"
import { QueryErrorState } from "@/components/common/query-error-state"
import { bucketSecondsForRange } from "@/components/infra/constants"
import { severityLevel } from "@/components/infra/format"
import { PodDetailChart } from "@/components/infra/k8s-detail-chart"
import type { PodRow } from "@/components/infra/pod-table"
import { HeroChip } from "@/components/infra/primitives/page-hero"
import { SegmentPivot } from "@/components/infra/primitives/segment-pivot"
import { StatRail, StatRailItem } from "@/components/infra/primitives/stat-rail"
import { HostStatusBadge } from "@/components/infra/status-badge"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { podDetailSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

/**
 * The peek: a pod's page, in a sheet, without leaving the list.
 *
 * Triage is a walk down a sorted list, and a full navigation per row costs the
 * sort, the scroll and the filters each time. The sheet shows what the pod page
 * would — the four limit ratios and the chart — over the SAME window the list
 * is on, and ↑/↓ walk the list behind it. "Open pod" is there when a row earns
 * the whole page.
 */

const METRIC_OPTIONS = [
	{ value: "cpu_limit", label: "CPU / limit" },
	{ value: "memory_limit", label: "Mem / limit" },
	{ value: "cpu_usage", label: "CPU cores" },
	{ value: "cpu_request", label: "CPU / request" },
	{ value: "memory_request", label: "Mem / request" },
] as const satisfies ReadonlyArray<{ value: PodInfraMetric; label: string }>

interface PodPeekSheetProps {
	pod: PodRow | null
	/** Where the pod sits in the list, for the footer's "3 of 50" and the arrows. */
	position: { index: number; count: number } | null
	onStep: (delta: 1 | -1) => void
	onClose: () => void
	startTime: string
	endTime: string
	timeSearch: TimeRangeSearch
	referenceTime?: string
}

export function PodPeekSheet({
	pod,
	position,
	onStep,
	onClose,
	startTime,
	endTime,
	timeSearch,
	referenceTime,
}: PodPeekSheetProps) {
	const [metric, setMetric] = useState<PodInfraMetric>("cpu_limit")

	// Page-level, not on the popup: opening the sheet from a row leaves focus on
	// that row, outside the sheet, so a handler on the popup would only fire once
	// the user had tabbed into it. The keys exist so they never have to.
	useHotkeys(
		[
			{ hotkey: "ArrowDown", callback: () => onStep(1), options: { ignoreInputs: true } },
			{ hotkey: "J", callback: () => onStep(1), options: { ignoreInputs: true } },
			{ hotkey: "ArrowUp", callback: () => onStep(-1), options: { ignoreInputs: true } },
			{ hotkey: "K", callback: () => onStep(-1), options: { ignoreInputs: true } },
		],
		{ enabled: pod !== null },
	)

	const canStepBack = position !== null && position.index > 0
	const canStepForward = position !== null && position.index < position.count - 1

	return (
		<Sheet open={pod !== null} onOpenChange={(open) => !open && onClose()}>
			<SheetContent className="p-0 sm:max-w-xl">
				{pod ? (
					<>
						<SheetHeader className="gap-1.5 pr-14">
							<span className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
								Pod
							</span>
							<SheetTitle className="flex flex-wrap items-center gap-2 font-mono text-[15px] leading-tight">
								<span className="min-w-0 break-all">{pod.podName}</span>
								<HostStatusBadge
									quiet
									lastSeen={pod.lastSeen}
									referenceTime={referenceTime}
								/>
							</SheetTitle>
							<SheetDescription className="sr-only">
								Peak utilization and metrics for {pod.podName}
							</SheetDescription>
							<div className="flex flex-wrap items-center gap-1.5">
								{pod.namespace && <HeroChip>ns {pod.namespace}</HeroChip>}
								{pod.deploymentName && <HeroChip>deploy {pod.deploymentName}</HeroChip>}
								{pod.statefulsetName && <HeroChip>sts {pod.statefulsetName}</HeroChip>}
								{pod.daemonsetName && <HeroChip>ds {pod.daemonsetName}</HeroChip>}
								{pod.jobName && <HeroChip>job {pod.jobName}</HeroChip>}
								{pod.nodeName && <HeroChip>node {pod.nodeName}</HeroChip>}
								{pod.qosClass && <HeroChip>qos {pod.qosClass}</HeroChip>}
								<span className="ml-auto font-mono text-[11px] text-muted-foreground">
									seen {formatRelativeTime(pod.lastSeen)}
								</span>
							</div>
						</SheetHeader>

						<SheetPanel className="space-y-5">
							<PeekSummary
								key={`${pod.namespace}/${pod.podName}`}
								pod={pod}
								startTime={startTime}
								endTime={endTime}
							/>
							<div className="space-y-3">
								<SegmentPivot
									ariaLabel="Metric"
									options={METRIC_OPTIONS}
									value={metric}
									onChange={setMetric}
								/>
								<PodDetailChart
									podName={pod.podName}
									namespace={pod.namespace || undefined}
									metric={metric}
									startTime={startTime}
									endTime={endTime}
									bucketSeconds={bucketSecondsForRange(startTime, endTime)}
								/>
							</div>
						</SheetPanel>

						<SheetFooter className="flex-row items-center justify-between gap-3 border-t">
							<div className="flex items-center gap-1.5">
								<Button
									variant="outline"
									size="icon-sm"
									aria-label="Previous pod"
									disabled={!canStepBack}
									onClick={() => onStep(-1)}
								>
									<ArrowUpIcon size={14} />
								</Button>
								<Button
									variant="outline"
									size="icon-sm"
									aria-label="Next pod"
									disabled={!canStepForward}
									onClick={() => onStep(1)}
								>
									<ArrowDownIcon size={14} />
								</Button>
								{position ? (
									<span className="ml-1 font-mono text-[11px] tabular-nums text-muted-foreground">
										{position.index + 1} of {position.count}
									</span>
								) : null}
								<span className="ml-2 hidden items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex">
									<Kbd>↑</Kbd>
									<Kbd>↓</Kbd> walk the list
								</span>
							</div>
							<Button
								size="sm"
								render={
									<Link
										to="/infra/kubernetes/pods/$podName"
										params={{ podName: pod.podName }}
										search={{ ...timeSearch, namespace: pod.namespace || undefined }}
									/>
								}
							>
								Open pod
								<ArrowRightIcon size={14} />
							</Button>
						</SheetFooter>
					</>
				) : null}
			</SheetContent>
		</Sheet>
	)
}

/** The four limit ratios the pod page leads with, over the list's window. */
function PeekSummary({ pod, startTime, endTime }: { pod: PodRow; startTime: string; endTime: string }) {
	const atom = podDetailSummaryResultAtom({
		data: { podName: pod.podName, namespace: pod.namespace || undefined, startTime, endTime },
	})
	const result = useAtomValue(atom)
	const refresh = useAtomRefresh(atom)

	return Result.builder(result)
		.onInitial(() => <Skeleton className="h-[88px] w-full rounded-md" />)
		.onError((error) => (
			<QueryErrorState error={error} titleOverride="Failed to load pod metrics" onRetry={refresh} />
		))
		.onSuccess((response) => {
			const summary = response.data
			if (!summary) {
				return (
					<div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
						No metrics arrived for this pod in this window.
					</div>
				)
			}
			return (
				<StatRail>
					<StatRailItem
						eyebrow="CPU vs limit"
						value={formatPercent(summary.cpuLimitPct)}
						tone={severityLevel(summary.cpuLimitPct)}
						compact
						className="px-4 py-3"
						valueClassName="text-[22px]"
					/>
					<StatRailItem
						eyebrow="CPU vs request"
						value={formatPercent(summary.cpuRequestPct)}
						compact
						className="px-4 py-3"
						valueClassName="text-[22px]"
					/>
					<StatRailItem
						eyebrow="Mem vs limit"
						value={formatPercent(summary.memoryLimitPct)}
						tone={severityLevel(summary.memoryLimitPct)}
						compact
						className="px-4 py-3"
						valueClassName="text-[22px]"
					/>
					<StatRailItem
						eyebrow="Mem vs request"
						value={formatPercent(summary.memoryRequestPct)}
						compact
						className="px-4 py-3"
						valueClassName="text-[22px]"
					/>
				</StatRail>
			)
		})
		.render()
}

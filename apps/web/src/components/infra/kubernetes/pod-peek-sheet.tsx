import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react"
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
import { podKey, type PodRow } from "@/components/infra/pod-table"
import { HeroChip } from "@/components/infra/primitives/page-hero"
import { StatRail, StatRailItem } from "@/components/infra/primitives/stat-rail"
import { HostStatusBadge } from "@/components/infra/status-badge"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { Result, useAtomMount, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import {
	podDetailSummaryResultAtom,
	podInfraTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"

/**
 * The peek: a pod's page, in a sheet, without leaving the list.
 *
 * Triage is a walk down a sorted list, and a full navigation per row costs the
 * sort, the scroll and the filters each time. The sheet shows what the pod page
 * would — the four limit ratios and every metric chart — over the SAME window
 * the list is on, and ↑/↓ walk the list behind it. "Open pod" is there when a
 * row earns the whole page.
 *
 * The charts are stacked, not tabbed: a peek is a glance, and a glance that
 * has to click through five tabs to see whether memory moved with CPU is not
 * one. The panel scrolls instead.
 */

/** Limits first — they are what the list is sorted by — then the raw cores and the requests. */
const PEEK_METRICS: ReadonlyArray<PodInfraMetric> = [
	"cpu_limit",
	"memory_limit",
	"cpu_usage",
	"cpu_request",
	"memory_request",
]

/** Shorter than the pod page's plot: five of them stack in a 576px sheet. */
const PEEK_CHART_HEIGHT = 150

/** ↓/J step forward, ↑/K back — the list idiom, mirrored in the footer hint. */
function stepFor(key: string): 1 | -1 | undefined {
	switch (key) {
		case "ArrowDown":
		case "j":
		case "J":
			return 1
		case "ArrowUp":
		case "k":
		case "K":
			return -1
		default:
			return undefined
	}
}

function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.isContentEditable
	)
}

interface PodPeekSheetProps {
	pod: PodRow | null
	/** Where the pod sits in the list, for the footer's "3 of 50" and the arrows. */
	position: { index: number; count: number } | null
	/**
	 * The rows a step lands on — the one before and the one after. Their summary
	 * and chart are fetched while this pod is on screen, so ↑/↓ swaps to data
	 * that has already arrived instead of waiting a round trip per row.
	 */
	neighbors: ReadonlyArray<PodRow>
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
	neighbors,
	onStep,
	onClose,
	startTime,
	endTime,
	timeSearch,
	referenceTime,
}: PodPeekSheetProps) {
	/**
	 * The keys are handled in two places, split by where focus is.
	 *
	 * Inside the popup, in the CAPTURE phase: opening the sheet from a row moves
	 * focus onto the metric toggle, the first tabbable thing, and a real ↑/↓
	 * press from there is stopped by the toggle group's own arrow-key handling
	 * before it bubbles to the document, where the hotkeys library listens. J/K
	 * reached it; the arrows the footer advertises did not. Capturing on the
	 * popup runs before any descendant.
	 *
	 * Outside it, as document hotkeys: a page loaded with `peek` already in the
	 * URL opens the sheet with focus still on the body, and nothing inside the
	 * popup ever sees those presses. The document handler yields whenever the
	 * press came from inside, so a key is handled exactly once.
	 */
	const popupRef = useRef<HTMLDivElement>(null)

	const handleKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
		const delta = stepFor(event.key)
		if (delta === undefined) return
		if (event.metaKey || event.ctrlKey || event.altKey) return
		if (isTextEntry(event.target)) return
		event.preventDefault()
		event.stopPropagation()
		onStep(delta)
	}

	const stepFromOutside = (delta: 1 | -1) => (event: KeyboardEvent) => {
		if (event.target instanceof Node && popupRef.current?.contains(event.target)) return
		onStep(delta)
	}

	useHotkeys(
		[
			{ hotkey: "ArrowDown", callback: stepFromOutside(1) },
			{ hotkey: "J", callback: stepFromOutside(1) },
			{ hotkey: "ArrowUp", callback: stepFromOutside(-1) },
			{ hotkey: "K", callback: stepFromOutside(-1) },
		],
		// `stopPropagation: false` so Base UI's own document-level key handling
		// (Escape closes the sheet) is never starved.
		{ enabled: pod !== null, ignoreInputs: true, stopPropagation: false },
	)

	const canStepBack = position !== null && position.index > 0
	const canStepForward = position !== null && position.index < position.count - 1

	return (
		<Sheet open={pod !== null} onOpenChange={(open) => !open && onClose()}>
			<SheetContent ref={popupRef} className="p-0 sm:max-w-xl" onKeyDownCapture={handleKeyDownCapture}>
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

						{neighbors.map((neighbor) => (
							<PeekPrefetch
								key={podKey(neighbor)}
								pod={neighbor}
								startTime={startTime}
								endTime={endTime}
							/>
						))}

						<SheetPanel className="space-y-5">
							{/*
							 * Deliberately NOT keyed by pod. `useAtomValue` hands back the
							 * previous pod's success, flagged `waiting`, while the next one
							 * loads — the same call every detail page makes — so a step dims
							 * the rail for a beat instead of dropping it to a skeleton and
							 * back, which read as the whole drawer being slow.
							 */}
							<PeekSummary pod={pod} startTime={startTime} endTime={endTime} />
							<div className="space-y-3">
								{PEEK_METRICS.map((metric) => (
									<PodDetailChart
										key={metric}
										podName={pod.podName}
										namespace={pod.namespace || undefined}
										metric={metric}
										startTime={startTime}
										endTime={endTime}
										bucketSeconds={bucketSecondsForRange(startTime, endTime)}
										height={PEEK_CHART_HEIGHT}
									/>
								))}
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

/**
 * Warms a neighbouring pod's queries without rendering anything.
 *
 * Mounting the atoms is enough: the family runs the query on first mount and
 * the idle TTL keeps the result for the step that follows. When the step
 * happens the charts and rail mount the very same atoms in the same commit, so
 * the subscription never drops to zero in between. One child per metric rather
 * than a loop of hooks, so the hook count stays fixed.
 */
function PeekPrefetch({ pod, startTime, endTime }: { pod: PodRow; startTime: string; endTime: string }) {
	const namespace = pod.namespace || undefined
	useAtomMount(
		podDetailSummaryResultAtom({
			data: { podName: pod.podName, namespace, startTime, endTime },
		}),
	)
	return PEEK_METRICS.map((metric) => (
		<PeekPrefetchSeries
			key={metric}
			podName={pod.podName}
			namespace={namespace}
			metric={metric}
			startTime={startTime}
			endTime={endTime}
		/>
	))
}

function PeekPrefetchSeries({
	podName,
	namespace,
	metric,
	startTime,
	endTime,
}: {
	podName: string
	namespace: string | undefined
	metric: PodInfraMetric
	startTime: string
	endTime: string
}) {
	useAtomMount(
		podInfraTimeseriesResultAtom({
			data: {
				podName,
				namespace,
				metric,
				startTime,
				endTime,
				bucketSeconds: bucketSecondsForRange(startTime, endTime),
			},
		}),
	)
	return null
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
		.onSuccess((response, holder) => {
			const summary = response.data
			if (!summary) {
				return (
					<div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
						No metrics arrived for this pod in this window.
					</div>
				)
			}
			return (
				<StatRail className={holder.waiting ? "opacity-60 transition-opacity" : "transition-opacity"}>
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

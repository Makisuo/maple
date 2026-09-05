import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { cn } from "@maple/ui/lib/utils"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { RELEASE_HEALTH_DOT_CLASS, RELEASE_HEALTH_LABEL, releaseHealthFigure } from "./release-health"
import { RELEASE_HEALTH_ORDER, shortReleaseLabel, type ReleaseServiceImpact } from "./release-model"

/** Lanes beyond this fold into a trailing count; the table still lists every release. */
const MAX_LANES = 12

interface ReleasesTimelineProps {
	impacts: ReadonlyArray<ReleaseServiceImpact>
	/** ISO bounds of the window the dots are placed in. */
	startTime: string
	endTime: string
	/** Carried onto each dot's link so the detail opens on the same window. */
	timeSearch: TimeRangeSearch
	environments?: string[]
}

interface Lane {
	serviceName: string
	spanCount: number
	dots: ReleaseServiceImpact[]
}

function buildLanes(impacts: ReadonlyArray<ReleaseServiceImpact>): Lane[] {
	const byService = new Map<string, Lane>()
	for (const impact of impacts) {
		const lane = byService.get(impact.serviceName)
		if (lane === undefined) {
			byService.set(impact.serviceName, {
				serviceName: impact.serviceName,
				spanCount: impact.spanCount,
				dots: [impact],
			})
		} else {
			lane.spanCount += impact.spanCount
			lane.dots.push(impact)
		}
	}
	return [...byService.values()].toSorted(
		(a, b) => b.spanCount - a.spanCount || a.serviceName.localeCompare(b.serviceName),
	)
}

function axisLabels(startMs: number, endMs: number): string[] {
	const span = endMs - startMs
	const showTime = span <= 3 * 86_400_000
	return [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
		const date = new Date(startMs + span * ratio)
		return showTime
			? date.toLocaleString(undefined, {
					month: "short",
					day: "numeric",
					hour: "numeric",
					minute: "2-digit",
				})
			: date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
	})
}

/**
 * One lane per service, one dot per version at the moment it was first seen.
 * A vertical line of dots is a monorepo deploy; a dot's fill is its health.
 * Positioned by time, not by bucket, so a deploy sits where it happened.
 */
export function ReleasesTimeline({
	impacts,
	startTime,
	endTime,
	timeSearch,
	environments,
}: ReleasesTimelineProps) {
	const lanes = useMemo(() => buildLanes(impacts), [impacts])
	const startMs = Date.parse(startTime)
	const endMs = Date.parse(endTime)
	const span = Math.max(1, endMs - startMs)
	const visible = lanes.slice(0, MAX_LANES)
	const hidden = lanes.length - visible.length
	const labels = useMemo(() => axisLabels(startMs, endMs), [startMs, endMs])

	return (
		<div className="flex flex-col rounded-md border bg-card">
			<div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
				<span className="text-[11px] font-medium text-muted-foreground">Deploys over time</span>
				<div className="flex items-center gap-3 text-[10px] text-muted-foreground">
					{RELEASE_HEALTH_ORDER.map((band) => (
						<span key={band} className="inline-flex items-center gap-1">
							<span
								className={cn(
									"inline-block size-2 rounded-full",
									RELEASE_HEALTH_DOT_CLASS[band],
								)}
							/>
							{RELEASE_HEALTH_LABEL[band]}
						</span>
					))}
				</div>
			</div>
			<div className="px-3 pb-2 pt-1">
				{visible.map((lane) => (
					<div
						key={lane.serviceName}
						className="grid h-7 grid-cols-[minmax(0,120px)_1fr] items-center gap-2"
					>
						<span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
							<ServiceDot serviceName={lane.serviceName} />
							<span className="truncate" title={lane.serviceName}>
								{lane.serviceName}
							</span>
						</span>
						<div className="relative h-full border-b border-dashed border-border/60">
							{lane.dots.map((dot) => {
								const ratio = Math.min(
									1,
									Math.max(0, (Date.parse(dot.firstSeen) - startMs) / span),
								)
								const figure = releaseHealthFigure(dot)
								return (
									<Link
										key={`${dot.commitSha}:${dot.environment}`}
										to="/releases/$commitSha"
										params={{ commitSha: dot.commitSha }}
										search={{
											service: dot.serviceName,
											environments:
												environments ??
												(dot.environment ? [dot.environment] : undefined),
											...timeSearch,
										}}
										title={`${shortReleaseLabel(dot.commitSha)} · ${formatRelativeTimeOrDate(dot.firstSeen)}${figure ? ` · ${figure}` : ""}`}
										aria-label={`${dot.serviceName} ${shortReleaseLabel(dot.commitSha)}`}
										className={cn(
											"absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-ring",
											RELEASE_HEALTH_DOT_CLASS[dot.health],
										)}
										style={{ left: `${ratio * 100}%` }}
									/>
								)
							})}
						</div>
					</div>
				))}
				{hidden > 0 ? (
					<div className="grid grid-cols-[minmax(0,120px)_1fr] gap-2 py-1 text-[10px] text-muted-foreground/70">
						<span>
							+{hidden} more {hidden === 1 ? "service" : "services"}
						</span>
					</div>
				) : null}
				<div className="grid grid-cols-[minmax(0,120px)_1fr] gap-2 pt-1.5">
					<span />
					<div className="flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground/70">
						{labels.map((label, index) => (
							<span key={index}>{label}</span>
						))}
					</div>
				</div>
			</div>
		</div>
	)
}

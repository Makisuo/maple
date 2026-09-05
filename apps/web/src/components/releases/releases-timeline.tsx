import { useCallback, useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { cn } from "@maple/ui/lib/utils"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { RELEASE_HEALTH_DOT_CLASS, RELEASE_HEALTH_LABEL, releaseHealthFigure } from "./release-health"
import {
	RELEASE_HEALTH_ORDER,
	shortReleaseLabel,
	type ReleaseHealth,
	type ReleaseServiceImpact,
} from "./release-model"

/** Lanes beyond this fold into a trailing count; the table still lists every release. */
const MAX_LANES = 12

/**
 * Two deploys closer than this many pixels merge into one marker: a dot's
 * own width plus a hair, so markers never overlap and a service that ships
 * every hour shows a few counted markers instead of a smear. Measured against
 * the rendered track, so the same data clusters more on a narrow pane.
 */
const MERGE_PX = 18

/** Threshold used before the track has been measured (a ~900px track). */
const FALLBACK_MERGE_RATIO = 0.016

/** Keeps a dot at the very start or end of the window inside the track. */
const TRACK_INSET_PX = 8

interface ReleasesTimelineProps {
	impacts: ReadonlyArray<ReleaseServiceImpact>
	/** ISO bounds of the window the dots are placed in. */
	startTime: string
	endTime: string
	/** Carried onto each dot's link so the detail opens on the same window. */
	timeSearch: TimeRangeSearch
	environments?: string[]
}

/** Several deploys close enough in time to share one marker. */
interface Marker {
	/** Position along the track, 0..1 (mean of the members). */
	ratio: number
	/** Newest first. */
	members: ReleaseServiceImpact[]
	health: ReleaseHealth
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

function worstHealth(members: ReadonlyArray<ReleaseServiceImpact>): ReleaseHealth {
	for (const band of RELEASE_HEALTH_ORDER) if (members.some((m) => m.health === band)) return band
	return "healthy"
}

/**
 * Greedy left-to-right clustering: a dot joins the open marker while it sits
 * within `mergeRatio` (a share of the track) of that marker's first member,
 * otherwise it opens a new one. Exported for its tests.
 */
export function clusterMarkers(
	dots: ReadonlyArray<ReleaseServiceImpact>,
	startMs: number,
	endMs: number,
	mergeRatio: number = FALLBACK_MERGE_RATIO,
): Marker[] {
	const span = Math.max(1, endMs - startMs)
	const placed = dots
		.map((dot) => ({
			dot,
			ratio: Math.min(1, Math.max(0, (Date.parse(dot.firstSeen) - startMs) / span)),
		}))
		.toSorted((a, b) => a.ratio - b.ratio)

	const markers: Marker[] = []
	let open: { anchor: number; items: typeof placed } | undefined
	const flush = () => {
		if (open === undefined) return
		const members = open.items.map((item) => item.dot).toReversed()
		markers.push({
			ratio: open.items.reduce((sum, item) => sum + item.ratio, 0) / open.items.length,
			members,
			health: worstHealth(members),
		})
		open = undefined
	}
	for (const item of placed) {
		if (open !== undefined && item.ratio - open.anchor < mergeRatio) {
			open.items.push(item)
		} else {
			flush()
			open = { anchor: item.ratio, items: [item] }
		}
	}
	flush()
	return markers
}

/**
 * Width of the first lane's track, kept current by a ResizeObserver. The ref
 * callback returns its own cleanup (React 19), so there is no effect to keep
 * in step with the node.
 */
function useTrackWidth(): [(node: HTMLDivElement | null) => void | (() => void), number] {
	const [width, setWidth] = useState(0)
	const ref = useCallback((node: HTMLDivElement | null) => {
		if (node === null) return
		setWidth(node.getBoundingClientRect().width)
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0]
			if (entry) setWidth(entry.contentRect.width)
		})
		observer.observe(node)
		return () => observer.disconnect()
	}, [])
	return [ref, width]
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

function markerTitle(marker: Marker): string {
	const [newest] = marker.members
	if (newest === undefined) return ""
	if (marker.members.length === 1) {
		const figure = releaseHealthFigure(newest)
		return `${shortReleaseLabel(newest.commitSha)} · ${formatRelativeTimeOrDate(newest.firstSeen)}${figure ? ` · ${figure}` : ""}`
	}
	const oldest = marker.members[marker.members.length - 1]!
	const listed = marker.members
		.slice(0, 6)
		.map((m) => shortReleaseLabel(m.commitSha))
		.join(", ")
	const more = marker.members.length > 6 ? `, +${marker.members.length - 6} more` : ""
	return `${marker.members.length} deploys · ${formatRelativeTimeOrDate(oldest.firstSeen)} → ${formatRelativeTimeOrDate(newest.firstSeen)}\n${listed}${more}`
}

/**
 * One lane per service, one marker per deploy at the moment it was first
 * seen — deploys closer than a dot's width share a marker with a count. A
 * vertical line of markers is a monorepo deploy; a marker's fill is the worst
 * health among its deploys. Positioned by time, not by bucket.
 */
export function ReleasesTimeline({
	impacts,
	startTime,
	endTime,
	timeSearch,
	environments,
}: ReleasesTimelineProps) {
	const startMs = Date.parse(startTime)
	const endMs = Date.parse(endTime)
	const [trackRef, trackWidth] = useTrackWidth()
	const usable = trackWidth - TRACK_INSET_PX * 2
	const mergeRatio = usable > MERGE_PX ? MERGE_PX / usable : FALLBACK_MERGE_RATIO
	const lanes = useMemo(
		() =>
			buildLanes(impacts).map((lane) => ({
				...lane,
				markers: clusterMarkers(lane.dots, startMs, endMs, mergeRatio),
			})),
		[impacts, startMs, endMs, mergeRatio],
	)
	const visible = lanes.slice(0, MAX_LANES)
	const hidden = lanes.length - visible.length
	const labels = useMemo(() => axisLabels(startMs, endMs), [startMs, endMs])

	return (
		<div className="flex flex-col rounded-md border bg-card">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-2.5">
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
				{visible.map((lane, laneIndex) => (
					<div
						key={lane.serviceName}
						className="grid h-8 grid-cols-[minmax(0,160px)_1fr] items-center gap-3"
					>
						<span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
							<ServiceDot serviceName={lane.serviceName} />
							<span className="truncate" title={lane.serviceName}>
								{lane.serviceName}
							</span>
						</span>
						<div
							ref={laneIndex === 0 ? trackRef : undefined}
							className="relative h-full border-b border-dashed border-border/60"
						>
							{lane.markers.map((marker) => {
								const [newest] = marker.members
								if (newest === undefined) return null
								const count = marker.members.length
								return (
									<Link
										key={`${newest.commitSha}:${newest.environment}:${marker.ratio}`}
										to="/releases/$commitSha"
										params={{ commitSha: newest.commitSha }}
										search={{
											service: newest.serviceName,
											environments:
												environments ??
												(newest.environment ? [newest.environment] : undefined),
											...timeSearch,
										}}
										title={markerTitle(marker)}
										aria-label={`${lane.serviceName}: ${count === 1 ? shortReleaseLabel(newest.commitSha) : `${count} deploys`}`}
										className="group absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center focus-visible:outline-none"
										style={{
											left: `calc(${TRACK_INSET_PX}px + ${marker.ratio} * (100% - ${TRACK_INSET_PX * 2}px))`,
										}}
									>
										<span
											className={cn(
												"block size-3 rounded-full ring-2 ring-card transition-transform group-hover:scale-125 group-focus-visible:ring-ring",
												RELEASE_HEALTH_DOT_CLASS[marker.health],
											)}
										/>
										{count > 1 ? (
											<span className="absolute left-full ml-0.5 rounded-sm bg-card px-0.5 font-mono text-[9px] leading-none tabular-nums text-muted-foreground">
												{count}
											</span>
										) : null}
									</Link>
								)
							})}
						</div>
					</div>
				))}
				{hidden > 0 ? (
					<div className="grid grid-cols-[minmax(0,160px)_1fr] gap-3 py-1 text-[10px] text-muted-foreground/70">
						<span>
							+{hidden} more {hidden === 1 ? "service" : "services"}
						</span>
					</div>
				) : null}
				<div className="grid grid-cols-[minmax(0,160px)_1fr] gap-3 pt-1.5">
					<span />
					<div
						className="flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground/70"
						style={{ paddingLeft: TRACK_INSET_PX, paddingRight: TRACK_INSET_PX }}
					>
						{labels.map((label, index) => (
							<span key={index}>{label}</span>
						))}
					</div>
				</div>
			</div>
		</div>
	)
}

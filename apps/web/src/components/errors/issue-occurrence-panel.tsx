import { useMemo } from "react"

import type { IssueSeverity } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"

import { densifySpark, surgeRatio } from "@/lib/models/error-signal"

import { IssueOccurrenceChart } from "./issue-occurrence-chart"

/** The same threshold the list row calls a surge, so the two cannot disagree. */
const SURGE_THRESHOLD = 2.5

interface TimeseriesPoint {
	bucket: string
	count: number
}

/**
 * The occurrence chart, given a frame and something to read it against.
 *
 * It used to sit bare in the page stack with both axes hidden and no numbers
 * beside it, which made it decoration: you could see a shape and not say how
 * tall it was or how wide a bar was. The peak and the bucket size are printed in
 * the heading, and the surge call-out is the same `surgeRatio` the list row uses
 * — so a fingerprint flagged as surging in the queue is still surging when you
 * open it.
 */
export function IssueOccurrencePanel({
	data,
	severity,
	window,
}: {
	data: ReadonlyArray<TimeseriesPoint>
	severity: IssueSeverity | null
	window: { readonly startMs: number; readonly endMs: number; readonly bucketMs: number }
}) {
	const { peak, surging } = useMemo(() => {
		const dense = densifySpark(data, window)
		const ratio = surgeRatio(dense)
		return {
			peak: data.reduce((max, point) => Math.max(max, point.count), 0),
			surging: ratio !== null && ratio >= SURGE_THRESHOLD,
		}
	}, [data, window])

	return (
		<section
			aria-labelledby="occurrence-chart-heading"
			className="flex shrink-0 flex-col gap-3.5 rounded-xl border bg-card px-5 py-4"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<div className="flex items-baseline gap-2.5">
					<h2
						id="occurrence-chart-heading"
						className="font-display text-base font-semibold tracking-[-0.01em] text-foreground"
					>
						Occurrences
					</h2>
					<span className="text-sm text-muted-foreground">
						peak <span className="tabular-nums">{formatNumber(peak)}</span> per{" "}
						{formatBucket(window.bucketMs)}
					</span>
				</div>
				{surging ? (
					<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-destructive">
						Surging
					</span>
				) : null}
			</div>
			<IssueOccurrenceChart data={data} severity={severity} />
		</section>
	)
}

/** `900000` → `15m`. Short enough to ride the heading, exact enough to size a bar. */
function formatBucket(bucketMs: number): string {
	const seconds = Math.round(bucketMs / 1000)
	if (seconds < 60) return `${seconds}s`
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`
	return `${Math.round(seconds / 86_400)}d`
}

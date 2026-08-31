import { cn } from "@maple/ui/lib/utils"
import { formatPercent } from "@maple/ui/lib/format"

import { severityLevel } from "../format"
import { BAR_FILL, BAR_VALUE_TONE } from "../severity-tokens"

/**
 * The labelled utilization meter every infra table shows.
 *
 * This replaces four implementations of one idea: `MiniBar` (written twice,
 * verbatim, in the pod and container tables), `InlineMetricBars` (hosts, three
 * fixed rows), and `UsageBar` (workloads, which re-declared the severity colour
 * maps that `severity-tokens` already owns). They disagreed on bar height
 * (4/6/1px), radius, label width, value width, and label case — so no two infra
 * tables lined up, which is most of why the section read as assembled rather
 * than designed.
 *
 * Fixed lanes, not `gap` alone: the label and value columns are the same width
 * in every table, so meters align down the page and across sibling tables even
 * when one has two rows and another has three.
 */

/** Label lane. Wide enough for "MEM"; every table therefore starts its bar at the same x. */
const LABEL_WIDTH = "w-8"
/** Value lane. Wide enough for "100%". */
const VALUE_WIDTH = "w-9"

export interface Meter {
	/** Short, upper-case: CPU, MEM, DSK. */
	label: string
	/** 0–1. Values outside are clamped; non-finite renders as an em dash. */
	fraction: number
}

export function MeterRows({
	meters,
	/**
	 * Drop the label lane. For a table that gives each metric its own COLUMN
	 * (workloads sort CPU and memory independently, so they can't share a cell),
	 * the column head already names it and an inline label would say it twice.
	 * The value lane keeps its width either way, so sibling columns still align.
	 */
	hideLabels = false,
	className,
}: {
	meters: ReadonlyArray<Meter>
	hideLabels?: boolean
	className?: string
}) {
	return (
		<div className={cn("flex flex-col gap-1", className)}>
			{meters.map((meter) => (
				<MeterRow key={meter.label} {...meter} hideLabel={hideLabels} />
			))}
		</div>
	)
}

function MeterRow({ label, fraction, hideLabel }: Meter & { hideLabel?: boolean }) {
	const finite = Number.isFinite(fraction)
	const clamped = finite ? Math.max(0, Math.min(1, fraction)) : 0
	const level = severityLevel(clamped)

	return (
		<div className="flex items-center gap-2 leading-none">
			{!hideLabel && (
				<span
					className={cn(
						LABEL_WIDTH,
						"shrink-0 font-mono text-[10px] tracking-[0.06em] text-muted-foreground/70",
					)}
				>
					{label}
				</span>
			)}
			<div className="relative h-[3px] min-w-0 flex-1 overflow-hidden rounded-[1px] bg-muted/60">
				<div
					className={cn(
						"absolute inset-y-0 left-0 transition-[width] duration-500",
						BAR_FILL[level],
					)}
					// A non-zero value never renders as nothing: 0.4% of a 120px lane
					// rounds to half a pixel, and "no bar" and "a bar too small to see"
					// are different facts.
					style={{ width: `${clamped > 0 ? Math.max(clamped * 100, 1.5) : 0}%` }}
				/>
			</div>
			<span
				className={cn(
					VALUE_WIDTH,
					"shrink-0 text-right font-mono text-[11px] tabular-nums",
					BAR_VALUE_TONE[level],
				)}
			>
				{finite ? formatPercent(fraction) : "—"}
			</span>
		</div>
	)
}

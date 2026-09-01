import { cn } from "@maple/ui/lib/utils"

import { useLinkedCursor } from "@/hooks/use-linked-cursor"
import { InfraMetricChart, type InfraSeriesInfo } from "@/components/infra/primitives/infra-metric-chart"
import { formatValueWithUnit, type ChartUnit } from "@/components/infra/chart-utils"

/**
 * The service lens's one argument, drawn.
 *
 * Three series that normally live on different pages — p99 from spans, CPU-of-
 * limit from kubeletstats gauges, throughput from spans again — stacked on one
 * time axis under one hover cursor. The stacking IS the claim: saturation that
 * rises before latency, with throughput flat beneath both, says "throttled, not
 * overloaded" without a sentence of explanation.
 *
 * They are strips rather than a chart grid on purpose. A grid invites you to
 * read each panel on its own; a stack invites you to read down a vertical line,
 * which is the only reading that answers the question.
 */

/** Deliberately short. Three of these plus chrome still sit above the fold. */
const STRIP_HEIGHT = 96

export interface StripSeries {
	id: string
	label: string
	/** The source, so a reader knows which pipeline produced the line. */
	source: string
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>
	unit: ChartUnit
	/** Draws the 80% rule. Percent units only. */
	showThreshold?: boolean
	/** Stacked bands rather than independent lines (per-pod CPU). */
	stacked?: boolean
}

interface CorrelationStripsProps {
	series: ReadonlyArray<StripSeries>
	/**
	 * The union of every strip's buckets. Without it each strip domains over its
	 * own rows and the vertical line through them means nothing — the service
	 * series and the kubeletstats gauges rarely cover the window identically.
	 */
	xDomain: ReadonlyArray<string>
	waiting?: boolean
	className?: string
}

export function CorrelationStrips({ series, xDomain, waiting, className }: CorrelationStripsProps) {
	// One cursor across all three strips. They are independent charts — the
	// cursor is a CSS variable on the container, not a Recharts syncId, so
	// hovering one does not rerender the others (see `useLinkedCursor`).
	const { containerProps } = useLinkedCursor(true)

	return (
		<div
			className={cn(
				"overflow-hidden rounded-lg border bg-card transition-opacity",
				waiting && "opacity-60",
				className,
			)}
			{...containerProps}
		>
			{series.map((strip, index) => (
				<div
					key={strip.id}
					className={cn("flex items-center gap-4 px-4 py-3", index > 0 && "border-t")}
				>
					<div className="flex w-[150px] shrink-0 flex-col gap-0.5">
						<span className="text-[12px] font-medium text-foreground">{strip.label}</span>
						<span className="font-mono text-[10px] text-muted-foreground">{strip.source}</span>
					</div>
					<div className="min-w-0 flex-1">
						<InfraMetricChart
							rows={strip.rows}
							unit={strip.unit}
							seriesLabel={strip.label}
							stacked={strip.stacked}
							showThreshold={strip.showThreshold}
							height={STRIP_HEIGHT}
							xDomain={xDomain}
							linkedChartId={`lens-${strip.id}`}
							waiting={waiting}
							header={LastValue}
						/>
					</div>
				</div>
			))}
		</div>
	)
}

/**
 * The strip's trailing value.
 *
 * `InfraMetricChart` puts its header above the plot, so this renders as a right-
 * aligned caption rather than the design's trailing column — the alternative was
 * a second layout path through the shared chart for one page's benefit.
 */
// A render prop, not a component: `InfraMetricChart` invokes it during its own
// render, so a hook in here would join ITS hook list. Kept hook-free for that
// reason — see `K8sSeriesSummary`, which is the same shape.
function LastValue({ series, lastValues, labelFor, unit, colors }: InfraSeriesInfo) {
	const summary = series
		.map((name) => ({ name, value: lastValues[name] }))
		.filter((entry): entry is { name: string; value: number } => entry.value !== undefined)

	if (summary.length === 0) return null

	return (
		<div className="mb-1 flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
			{summary.map(({ name, value }) => (
				<span key={name} className="inline-flex items-center gap-1.5 text-[11px]">
					{summary.length > 1 && (
						<span className="size-1.5 rounded-full" style={{ background: colors.get(name) }} />
					)}
					{summary.length > 1 && <span className="text-muted-foreground">{labelFor(name)}</span>}
					<span className="font-mono tabular-nums text-foreground">
						{formatValueWithUnit(value, unit)}
					</span>
				</span>
			))}
		</div>
	)
}

import { Suspense, type ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"
import { getChartById } from "@maple/ui/components/charts/registry"
import { ChartSkeleton } from "@maple/ui/components/charts/_shared/chart-skeleton"
import { ChartTooltipSuppressionProvider } from "@maple/ui/components/plot"
import type { ChartLegendMode, ChartTooltipMode } from "@maple/ui/components/charts/_shared/chart-types"
import { ReadonlyWidgetShell } from "@/components/dashboard-builder/widgets/widget-shell"
import { ErrorState } from "@/components/common/error-state"
import { LinkedCursorOverlay, linkedCursorChartProps, useLinkedCursor } from "@/hooks/use-linked-cursor"

interface MetricsGridItem {
	id: string
	chartId: string
	title: string
	layout: { x: number; y: number; w: number; h: number }
	data: Record<string, unknown>[]
	legend?: ChartLegendMode
	tooltip?: ChartTooltipMode
	rateMode?: "per_second"
	isLoading?: boolean
	/** When set, the card renders an inline error state instead of the chart. */
	error?: { error: unknown; onRetry?: () => void }
	/** Headline stat rendered at the top-right of the card header. */
	headerValue?: ReactNode
	/** Summary stat rendered below the chart. */
	footer?: ReactNode
}

interface MetricsGridProps {
	items: MetricsGridItem[]
	className?: string
	waiting?: boolean
	/**
	 * Groups the grid's charts under one linked cursor: hovering any chart paints
	 * a cursor line at the same time-bucket ratio on every sibling. Omit it and
	 * each chart is fully independent.
	 *
	 * There is no longer a second sync mode. `syncMode="recharts"` used to hand
	 * this id to Recharts' event bus, which re-rendered every synced chart's
	 * tooltip store on each pointer tick; the linked cursor replaced it (CSS
	 * variables, no React state) and the Recharts arm had been dead in production
	 * since it became the default.
	 */
	syncId?: string
	/**
	 * Overlay element rendered over every time-series chart (e.g. commit deploy
	 * markers). The same element is handed to each chart, which mounts its own
	 * instance in `PlotFrame`'s overlay slot against that chart's own scale.
	 */
	overlay?: ReactNode
	/**
	 * Pins every chart's plot to the same left edge, in pixels.
	 *
	 * Pass it whenever the grid shares an `overlay`: the commit markers decide
	 * whether two deploys merge into one label chip from the plot WIDTH, so
	 * charts whose y-axis gutters differ (they do — the four service metrics span
	 * ~38px to ~65px, "0.9" against "155.0ms") group the same commits differently
	 * on adjacent cards. The linked cursor itself does not need this; it works in
	 * per-plot ratios.
	 */
	yAxisWidth?: number
}

export function MetricsGrid({ items, className, waiting, syncId, overlay, yAxisWidth }: MetricsGridProps) {
	const linkedCursorEnabled = syncId != null
	const { containerProps } = useLinkedCursor(linkedCursorEnabled)

	return (
		<ChartTooltipSuppressionProvider>
			<div
				{...containerProps}
				data-metrics-grid=""
				className={cn(
					"grid grid-cols-1 md:grid-cols-2 gap-3 transition-opacity",
					waiting && "opacity-60",
					className,
				)}
			>
				{items.map((item) => {
					const entry = getChartById(item.chartId)
					if (!entry) {
						return <div key={item.id} />
					}

					const ChartComponent = entry.component
					const fullWidth = item.layout.w > 6

					return (
						<div
							key={item.id}
							{...linkedCursorChartProps(linkedCursorEnabled ? item.id : undefined)}
							className={cn("h-[240px] md:h-[280px]", fullWidth && "md:col-span-2")}
						>
							<ReadonlyWidgetShell
								title={item.title}
								headerValue={item.headerValue}
								footer={item.footer}
								// Commit deploy markers draw their label chip ABOVE the plot, so it
								// overflows the chart's top edge into the card's header gap (by design —
								// the series keeps full height). The widget shell clips content by
								// default (MAP-49, to stop funnel rows spilling), which would hide that
								// chip. When an overlay is present, opt this card out of the clip so the
								// label shows; `overflow-visible` wins the tailwind-merge over the
								// shell's default `overflow-hidden`. Area/line charts don't otherwise
								// spill, so nothing else escapes.
								contentClassName={overlay ? "flex-1 min-h-0 p-2 overflow-visible" : undefined}
							>
								{item.error ? (
									<ErrorState
										variant="panel"
										className="border-0"
										error={item.error.error}
										onRetry={item.error.onRetry}
									/>
								) : item.isLoading ? (
									<ChartSkeleton variant={entry.category} />
								) : (
									<div className="relative h-full min-h-0 w-full">
										<Suspense fallback={<ChartSkeleton variant={entry.category} />}>
											<ChartComponent
												data={item.data}
												className="h-full w-full aspect-auto"
												legend={item.legend}
												tooltip={item.tooltip}
												rateMode={item.rateMode}
												overlay={overlay}
												yAxisWidth={yAxisWidth}
											/>
										</Suspense>
										{linkedCursorEnabled && <LinkedCursorOverlay chartId={item.id} />}
									</div>
								)}
							</ReadonlyWidgetShell>
						</div>
					)
				})}
			</div>
		</ChartTooltipSuppressionProvider>
	)
}

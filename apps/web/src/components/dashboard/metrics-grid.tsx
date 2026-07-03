import { Suspense, type ReactNode } from "react"

import { cn } from "@maple/ui/utils"
import { getChartById } from "@maple/ui/components/charts/registry"
import { ChartSkeleton } from "@maple/ui/components/charts/_shared/chart-skeleton"
import { ChartTooltipSuppressionProvider } from "@maple/ui/components/ui/chart"
import type { ChartLegendMode, ChartTooltipMode } from "@maple/ui/components/charts/_shared/chart-types"
import { ReadonlyWidgetShell } from "@/components/dashboard-builder/widgets/widget-shell"

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
	 * If provided, every chart in the grid is given the same syncId so
	 * hovering one chart highlights the same time bucket on the others.
	 */
	syncId?: string
	/**
	 * Overlay element rendered inside every time-series chart (e.g. commit deploy
	 * markers). The same element is handed to each chart; recharts renders one
	 * instance per chart against its own axis scale.
	 */
	overlay?: ReactNode
	/**
	 * Fixed y-axis width applied to every chart so their plot areas line up exactly.
	 * Pass this whenever charts are synced and/or share an `overlay`, so the cursor and
	 * the deploy markers align (and group identically) across charts instead of drifting
	 * with each chart's own y-axis width.
	 */
	yAxisWidth?: number
}

export function MetricsGrid({ items, className, waiting, syncId, overlay, yAxisWidth }: MetricsGridProps) {
	return (
		<ChartTooltipSuppressionProvider>
			<div
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
							className={cn("h-[240px] md:h-[280px]", fullWidth && "md:col-span-2")}
						>
							<ReadonlyWidgetShell
								title={item.title}
								headerValue={item.headerValue}
								footer={item.footer}
							>
								{item.isLoading ? (
									<ChartSkeleton variant={entry.category} />
								) : (
									<Suspense fallback={<ChartSkeleton variant={entry.category} />}>
										<ChartComponent
											data={item.data}
											className="h-full w-full aspect-auto"
											legend={item.legend}
											tooltip={item.tooltip}
											rateMode={item.rateMode}
											syncId={syncId}
											overlay={overlay}
											yAxisWidth={yAxisWidth}
										/>
									</Suspense>
								)}
							</ReadonlyWidgetShell>
						</div>
					)
				})}
			</div>
		</ChartTooltipSuppressionProvider>
	)
}

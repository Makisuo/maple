import { Suspense } from "react"

import { cn } from "@maple/ui/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { getChartById } from "@maple/ui/components/charts/registry"
import type {
  ChartLegendMode,
  ChartTooltipMode,
} from "@maple/ui/components/charts/_shared/chart-types"
import { ReadonlyWidgetShell } from "@/components/dashboard-builder/widgets/widget-shell"

interface MetricsGridItem {
  id: string
  chartId: string
  title: string
  layout: { x: number; y: number; w: number; h: number }
  data: Record<string, unknown>[]
  legend?: ChartLegendMode
  tooltip?: ChartTooltipMode
  isLoading?: boolean
}

interface MetricsGridProps {
  items: MetricsGridItem[]
  className?: string
}

export function MetricsGrid({ items, className }: MetricsGridProps) {
  return (
    <div className={cn("grid grid-cols-1 md:grid-cols-2 gap-3", className)}>
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
            className={cn("h-[280px]", fullWidth && "md:col-span-2")}
          >
            <ReadonlyWidgetShell title={item.title}>
              {item.isLoading ? (
                <Skeleton className="h-full w-full" />
              ) : (
                <Suspense fallback={<Skeleton className="h-full w-full" />}>
                  <ChartComponent
                    data={item.data}
                    className="h-full w-full aspect-auto"
                    legend={item.legend}
                    tooltip={item.tooltip}
                  />
                </Suspense>
              )}
            </ReadonlyWidgetShell>
          </div>
        )
      })}
    </div>
  )
}

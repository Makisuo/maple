import { memo, Suspense } from "react"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { getChartById } from "@maple/ui/components/charts/registry"
import { WidgetShell } from "@/components/dashboard-builder/widgets/widget-shell"
import type {
  WidgetDataState,
  WidgetDisplayConfig,
  WidgetMode,
} from "@/components/dashboard-builder/types"

interface ChartWidgetProps {
  dataState: WidgetDataState
  display: WidgetDisplayConfig
  mode: WidgetMode
  onRemove: () => void
  onConfigure?: () => void
  editPanel?: React.ReactNode
}

export const ChartWidget = memo(function ChartWidget({
  dataState,
  display,
  mode,
  onRemove,
  onConfigure,
  editPanel,
}: ChartWidgetProps) {
  const chartId = display.chartId ?? "gradient-area"
  const entry = getChartById(chartId)
  if (!entry) return null

  const ChartComponent = entry.component
  const chartData =
    dataState.status === "ready" && Array.isArray(dataState.data)
      ? dataState.data
      : undefined
  const legend = display.chartPresentation?.legend ?? "visible"
  const tooltip = display.chartPresentation?.tooltip

  return (
    <WidgetShell
      title={display.title || entry.name}
      mode={mode}
      onRemove={onRemove}
      onConfigure={onConfigure}
      editPanel={editPanel}
    >
      {dataState.status === "loading" ? (
        <Skeleton className="h-full w-full" />
      ) : dataState.status === "error" ? (
        <div className="flex items-center justify-center h-full">
          <span className="text-xs text-muted-foreground">Unable to load</span>
        </div>
      ) : (
        <Suspense fallback={<Skeleton className="h-full w-full" />}>
          <ChartComponent
            data={chartData}
            className="h-full w-full aspect-auto"
            legend={legend}
            tooltip={tooltip}
          />
        </Suspense>
      )}
    </WidgetShell>
  )
})

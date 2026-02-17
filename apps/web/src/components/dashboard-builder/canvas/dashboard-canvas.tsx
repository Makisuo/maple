import { memo, useCallback, useMemo } from "react"
import {
  Responsive,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout"
import type { Layout } from "react-grid-layout"
import "react-grid-layout/css/styles.css"

import type {
  WidgetDataState,
  DashboardWidget,
  WidgetDisplayConfig,
  WidgetMode,
} from "@/components/dashboard-builder/types"
import { useWidgetData } from "@/hooks/use-widget-data"
import { ChartWidget } from "@/components/dashboard-builder/widgets/chart-widget"
import { StatWidget } from "@/components/dashboard-builder/widgets/stat-widget"
import { TableWidget } from "@/components/dashboard-builder/widgets/table-widget"
import { WidgetEditPanel } from "@/components/dashboard-builder/widgets/widget-edit-panel"

interface DashboardCanvasProps {
  widgets: DashboardWidget[]
  mode: WidgetMode
  onLayoutChange: (
    layouts: Array<{ i: string; x: number; y: number; w: number; h: number }>
  ) => void
  onRemoveWidget: (widgetId: string) => void
  onUpdateWidgetDisplay?: (
    widgetId: string,
    display: Partial<WidgetDisplayConfig>
  ) => void
  onConfigureWidget?: (widgetId: string) => void
}

const visualizationRegistry: Record<
  string,
  React.ComponentType<{
    dataState: WidgetDataState
    display: WidgetDisplayConfig
    mode: WidgetMode
    onRemove: () => void
    onConfigure?: () => void
    editPanel?: React.ReactNode
  }>
> = {
  chart: ChartWidget,
  stat: StatWidget,
  table: TableWidget,
}

const WidgetRenderer = memo(function WidgetRenderer({
  widget,
  mode,
  onRemoveWidget,
  onConfigureWidget,
  onUpdateWidgetDisplay,
}: {
  widget: DashboardWidget
  mode: WidgetMode
  onRemoveWidget: (widgetId: string) => void
  onConfigureWidget?: (widgetId: string) => void
  onUpdateWidgetDisplay?: (
    widgetId: string,
    display: Partial<WidgetDisplayConfig>
  ) => void
}) {
  const { dataState } = useWidgetData(widget)
  const Visualization =
    visualizationRegistry[widget.visualization] ?? visualizationRegistry.chart

  const onRemove = useCallback(
    () => onRemoveWidget(widget.id),
    [onRemoveWidget, widget.id]
  )

  const onConfigure = useMemo(
    () =>
      onConfigureWidget
        ? () => onConfigureWidget(widget.id)
        : undefined,
    [onConfigureWidget, widget.id]
  )

  const handleUpdateDisplay = useCallback(
    (display: Partial<WidgetDisplayConfig>) =>
      onUpdateWidgetDisplay?.(widget.id, display),
    [onUpdateWidgetDisplay, widget.id]
  )

  const editPanel = useMemo(
    () =>
      onUpdateWidgetDisplay ? (
        <WidgetEditPanel
          widget={widget}
          onUpdateDisplay={handleUpdateDisplay}
        />
      ) : undefined,
    [widget, onUpdateWidgetDisplay, handleUpdateDisplay]
  )

  return (
    <Visualization
      dataState={dataState}
      display={widget.display}
      mode={mode}
      onRemove={onRemove}
      onConfigure={onConfigure}
      editPanel={editPanel}
    />
  )
})

export function DashboardCanvas({
  widgets,
  mode,
  onLayoutChange,
  onRemoveWidget,
  onUpdateWidgetDisplay,
  onConfigureWidget,
}: DashboardCanvasProps) {
  const { width, containerRef, mounted } = useContainerWidth()

  const layouts: Layout = widgets.map((w) => ({
    i: w.id,
    x: w.layout.x,
    y: w.layout.y,
    w: w.layout.w,
    h: w.layout.h,
    minW: w.layout.minW ?? 2,
    minH: w.layout.minH ?? 2,
    ...(w.layout.maxW != null ? { maxW: w.layout.maxW } : {}),
    ...(w.layout.maxH != null ? { maxH: w.layout.maxH } : {}),
  }))

  return (
    <div ref={containerRef}>
      {mounted && (
        <Responsive
          width={width}
          layouts={{ lg: layouts }}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
          cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
          rowHeight={60}
          dragConfig={{
            enabled: mode === "edit",
            handle: ".widget-drag-handle",
            bounded: false,
            threshold: 3,
          }}
          resizeConfig={{
            enabled: mode === "edit",
            handles: ["se"],
          }}
          compactor={verticalCompactor}
          margin={[12, 12] as [number, number]}
          onLayoutChange={(layout) =>
            onLayoutChange(
              layout.map((l) => ({
                i: l.i,
                x: l.x,
                y: l.y,
                w: l.w,
                h: l.h,
              }))
            )
          }
        >
          {widgets.map((widget) => (
            <div key={widget.id}>
              <WidgetRenderer
                widget={widget}
                mode={mode}
                onRemoveWidget={onRemoveWidget}
                onConfigureWidget={onConfigureWidget}
                onUpdateWidgetDisplay={onUpdateWidgetDisplay}
              />
            </div>
          ))}
        </Responsive>
      )}
    </div>
  )
}

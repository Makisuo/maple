import { Input } from "@maple/ui/components/ui/input"
import { getChartById, getChartsByCategory } from "@maple/ui/components/charts/registry"
import { ChartPreview } from "@/components/dashboard-builder/widgets/chart-preview"
import type {
  DashboardWidget,
  WidgetDisplayConfig,
  DataSourceEndpoint,
} from "@/components/dashboard-builder/types"

const ENDPOINT_OPTIONS: Array<{ value: DataSourceEndpoint; label: string }> = [
  { value: "service_usage", label: "Service Usage" },
  { value: "service_overview", label: "Service Overview" },
  { value: "service_overview_time_series", label: "Service Time Series" },
  { value: "errors_summary", label: "Errors Summary" },
  { value: "errors_by_type", label: "Errors by Type" },
  { value: "error_rate_by_service", label: "Error Rate by Service" },
  { value: "list_traces", label: "Traces" },
  { value: "list_logs", label: "Logs" },
  { value: "list_metrics", label: "Metrics" },
  { value: "metrics_summary", label: "Metrics Summary" },
  { value: "custom_timeseries", label: "Custom Time Series" },
  { value: "custom_breakdown", label: "Custom Breakdown" },
  { value: "custom_query_builder_timeseries", label: "Query Builder (Multi Query)" },
]

interface WidgetEditPanelProps {
  widget: DashboardWidget
  onUpdateDisplay: (updates: Partial<WidgetDisplayConfig>) => void
}

export function WidgetEditPanel({
  widget,
  onUpdateDisplay,
}: WidgetEditPanelProps) {
  const isChart = widget.visualization === "chart"
  const chartId = widget.display.chartId
  const currentChart = isChart && chartId ? getChartById(chartId) : null
  const variants = currentChart ? getChartsByCategory(currentChart.category) : []

  const placeholder = currentChart?.name ?? widget.display.title ?? "Widget"

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] font-medium text-muted-foreground">
          Title
        </label>
        <Input
          placeholder={placeholder}
          value={widget.display.title || ""}
          onChange={(e) => onUpdateDisplay({ title: e.target.value })}
          className="h-7 text-xs"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] font-medium text-muted-foreground">
          Data Source
        </label>
        <div className="text-[10px] text-muted-foreground bg-muted px-2 py-1.5 rounded">
          {ENDPOINT_OPTIONS.find((o) => o.value === widget.dataSource.endpoint)?.label ??
            widget.dataSource.endpoint}
        </div>
      </div>

      {isChart && variants.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-medium text-muted-foreground">
            Variant
          </label>
          <div className="grid grid-cols-3 gap-1.5">
            {variants.map((variant) => {
              const isActive = variant.id === chartId

              return (
                <button
                  key={variant.id}
                  type="button"
                  onClick={() => onUpdateDisplay({ chartId: variant.id })}
                  className={`ring-1 p-1.5 transition-all ${
                    isActive
                      ? "ring-foreground ring-2"
                      : "ring-border hover:ring-foreground/30"
                  }`}
                >
                  <ChartPreview component={variant.component} />
                  <div className="text-[9px] text-muted-foreground truncate mt-1">
                    {variant.name}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}

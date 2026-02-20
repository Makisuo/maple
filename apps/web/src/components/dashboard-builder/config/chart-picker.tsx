import { useState } from "react"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@maple/ui/components/ui/dialog"
import { getChartById } from "@maple/ui/components/charts/registry"
import { ChartPreview } from "@/components/dashboard-builder/widgets/chart-preview"
import type {
  VisualizationType,
  WidgetDataSource,
  WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"
import {
  statPresets,
  tablePresets,
  type WidgetPresetDefinition,
} from "@/components/dashboard-builder/widgets/widget-definitions"
import { formatValue } from "@/components/dashboard-builder/widgets/stat-widget"
import { formatCellValue } from "@/components/dashboard-builder/widgets/table-widget"
import { createQueryDraft } from "@/lib/query-builder/model"

type ChartCategory = "bar" | "area" | "line"

const categoryDefaults: Array<{
  category: ChartCategory
  chartId: string
  previewChartId: string
  label: string
}> = [
  { category: "bar", chartId: "query-builder-bar", previewChartId: "default-bar", label: "Bar Chart" },
  { category: "area", chartId: "query-builder-area", previewChartId: "gradient-area", label: "Area Chart" },
  { category: "line", chartId: "query-builder-line", previewChartId: "dotted-line", label: "Line Chart" },
]

type PickerTab = "charts" | "stats" | "tables"

const tabs: { id: PickerTab; label: string }[] = [
  { id: "charts", label: "Charts" },
  { id: "stats", label: "Stats" },
  { id: "tables", label: "Tables" },
]

// Sample values for stat previews
const statSampleValues: Record<string, number> = {
  "stat-total-traces": 48293,
  "stat-total-logs": 124817,
  "stat-error-rate": 0.032,
  "stat-total-errors": 1247,
  "stat-total-services": 12,
}

// Sample rows for table previews
const tableSampleRows: Record<string, Record<string, unknown>[]> = {
  "table-traces": [
    { rootSpanName: "GET /api/users", durationMs: 142, hasError: false },
    { rootSpanName: "POST /api/orders", durationMs: 891, hasError: true },
    { rootSpanName: "GET /api/health", durationMs: 3, hasError: false },
  ],
  "table-errors": [
    { errorType: "ConnectionTimeout", count: 342, affectedServicesCount: 5 },
    { errorType: "NullPointerException", count: 128, affectedServicesCount: 3 },
    { errorType: "RateLimitExceeded", count: 87, affectedServicesCount: 2 },
  ],
  "table-services": [
    { serviceName: "api-gateway", p95LatencyMs: 245, errorRate: 2.1, throughput: 1250 },
    { serviceName: "user-service", p95LatencyMs: 89, errorRate: 0.4, throughput: 830 },
    { serviceName: "order-service", p95LatencyMs: 412, errorRate: 5.2, throughput: 340 },
  ],
}

function StatPreviewCard({ preset }: { preset: WidgetPresetDefinition }) {
  const sampleValue = statSampleValues[preset.id] ?? 0
  const formatted = formatValue(sampleValue, preset.display.unit, preset.display.prefix, preset.display.suffix)

  return (
    <div className="aspect-[4/3] flex flex-col items-center justify-center gap-1.5">
      <div className="text-[10px] text-muted-foreground">{preset.display.title}</div>
      <div className="text-lg font-bold">{formatted}</div>
    </div>
  )
}

function TablePreviewCard({ preset }: { preset: WidgetPresetDefinition }) {
  const rows = tableSampleRows[preset.id] ?? []
  const columns = preset.display.columns ?? []

  return (
    <div className="aspect-[4/3] flex flex-col overflow-hidden">
      <div className="text-[10px] text-muted-foreground mb-1 px-0.5">{preset.display.title}</div>
      <table className="w-full text-[9px]">
        <thead>
          <tr className="border-b border-border">
            {columns.map((col) => (
              <th
                key={col.field}
                className="px-1 py-0.5 font-medium text-muted-foreground"
                style={{ textAlign: col.align ?? "left" }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border/50">
              {columns.map((col) => (
                <td
                  key={col.field}
                  className="px-1 py-0.5 truncate max-w-[80px]"
                  style={{ textAlign: col.align ?? "left" }}
                >
                  {formatCellValue(row[col.field], col.unit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface WidgetPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (
    visualization: VisualizationType,
    dataSource: WidgetDataSource,
    display: WidgetDisplayConfig
  ) => void
}

export function WidgetPicker({ open, onOpenChange, onSelect }: WidgetPickerProps) {
  const [activeTab, setActiveTab] = useState<PickerTab>("charts")

  const handleSelectChart = (chartId: string) => {
    onSelect(
      "chart",
      {
        endpoint: "custom_query_builder_timeseries",
        params: {
          queries: [createQueryDraft(0)],
          formulas: [],
          comparison: {
            mode: "none",
            includePercentChange: true,
          },
          debug: false,
        },
      },
      { chartId }
    )
    onOpenChange(false)
  }

  const handleSelectPreset = (preset: WidgetPresetDefinition) => {
    onSelect(preset.visualization, preset.dataSource, preset.display)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add Widget</DialogTitle>
          <DialogDescription>
            Choose a widget type to add to your dashboard.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 mb-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium transition-all ${
                activeTab === tab.id
                  ? "ring-2 ring-foreground bg-foreground text-background"
                  : "ring-1 ring-border hover:ring-foreground/30"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "charts" && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {categoryDefaults.map(({ chartId, previewChartId, label }) => {
              const entry = getChartById(previewChartId)
              if (!entry) return null
              const Component = entry.component

              return (
                <button
                  key={chartId}
                  type="button"
                  onClick={() => handleSelectChart(chartId)}
                  className="group ring-1 ring-border hover:ring-foreground/30 bg-card p-3 text-left transition-all flex flex-col gap-2"
                >
                  <ChartPreview component={Component} />
                  <div className="text-xs font-medium">{label}</div>
                </button>
              )
            })}
          </div>
        )}

        {activeTab === "stats" && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {statPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleSelectPreset(preset)}
                className="group ring-1 ring-border hover:ring-foreground/30 bg-card p-3 text-left transition-all flex flex-col gap-2"
              >
                <StatPreviewCard preset={preset} />
                <div className="text-xs font-medium">{preset.name}</div>
              </button>
            ))}
          </div>
        )}

        {activeTab === "tables" && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {tablePresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleSelectPreset(preset)}
                className="group ring-1 ring-border hover:ring-foreground/30 bg-card p-3 text-left transition-all flex flex-col gap-2"
              >
                <TablePreviewCard preset={preset} />
                <div className="text-xs font-medium">{preset.name}</div>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

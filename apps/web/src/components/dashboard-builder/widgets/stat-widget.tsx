import { memo } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { WidgetShell } from "@/components/dashboard-builder/widgets/widget-shell"
import type {
  WidgetDataState,
  WidgetDisplayConfig,
  WidgetMode,
} from "@/components/dashboard-builder/types"
import { formatNumber, formatDuration } from "@/lib/format"

interface StatWidgetProps {
  dataState: WidgetDataState
  display: WidgetDisplayConfig
  mode: WidgetMode
  onRemove: () => void
  onConfigure?: () => void
  editPanel?: React.ReactNode
}

export function formatValue(value: unknown, unit?: string, prefix?: string, suffix?: string): string {
  const num = typeof value === "number" ? value : Number(value)
  if (Number.isNaN(num)) return String(value ?? "-")

  let formatted: string
  switch (unit) {
    case "percent":
      formatted = `${(num * 100).toFixed(1)}%`
      break
    case "duration_ms":
      formatted = formatDuration(num)
      break
    case "duration_us":
      formatted = formatDuration(num / 1000)
      break
    case "number":
      formatted = formatNumber(num)
      break
    case "requests_per_sec":
      formatted = `${num.toFixed(1)}/s`
      break
    case "bytes":
      if (num >= 1_000_000_000) formatted = `${(num / 1_000_000_000).toFixed(1)} GB`
      else if (num >= 1_000_000) formatted = `${(num / 1_000_000).toFixed(1)} MB`
      else if (num >= 1_000) formatted = `${(num / 1_000).toFixed(1)} KB`
      else formatted = `${num} B`
      break
    default:
      formatted = formatNumber(num)
  }

  return `${prefix ?? ""}${formatted}${suffix ?? ""}`
}

function getThresholdColor(
  value: unknown,
  thresholds?: Array<{ value: number; color: string }>
): string | undefined {
  if (!thresholds || thresholds.length === 0) return undefined
  const num = typeof value === "number" ? value : Number(value)
  if (Number.isNaN(num)) return undefined

  const sorted = [...thresholds].sort((a, b) => b.value - a.value)
  for (const t of sorted) {
    if (num >= t.value) return t.color
  }
  return undefined
}

export const StatWidget = memo(function StatWidget({
  dataState,
  display,
  mode,
  onRemove,
  onConfigure,
  editPanel,
}: StatWidgetProps) {
  const displayName = display.title || "Stat"
  const value = dataState.status === "ready" ? dataState.data : undefined
  const formattedValue = formatValue(value, display.unit, display.prefix, display.suffix)
  const thresholdColor = getThresholdColor(value, display.thresholds)

  return (
    <WidgetShell
      title={displayName}
      mode={mode}
      onRemove={onRemove}
      onConfigure={onConfigure}
      contentClassName="flex-1 min-h-0 flex items-center justify-center p-4"
      editPanel={editPanel}
    >
      {dataState.status === "loading" ? (
        <Skeleton className="h-8 w-24" />
      ) : dataState.status === "error" ? (
        <span className="text-xs text-muted-foreground">Unable to load</span>
      ) : (
        <span
          className="text-2xl font-bold"
          style={thresholdColor ? { color: thresholdColor } : undefined}
        >
          {formattedValue}
        </span>
      )}
    </WidgetShell>
  )
})

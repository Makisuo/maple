import { PlusIcon, PencilIcon, CheckIcon, GridIcon } from "@/components/icons"

import { Button } from "@maple/ui/components/ui/button"
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { relativeToAbsolute } from "@/lib/time-utils"
import type { TimeRange, WidgetMode } from "@/components/dashboard-builder/types"

interface DashboardToolbarProps {
  mode: WidgetMode
  readOnly?: boolean
  onToggleEdit: () => void
  onAddWidget: () => void
  onAutoLayout: () => void
}

function resolveForPicker(timeRange: TimeRange): {
  startTime?: string
  endTime?: string
} {
  if (timeRange.type === "absolute") {
    return { startTime: timeRange.startTime, endTime: timeRange.endTime }
  }
  const resolved = relativeToAbsolute(timeRange.value)
  return resolved
    ? { startTime: resolved.startTime, endTime: resolved.endTime }
    : {}
}

export function DashboardToolbar({
  mode,
  readOnly = false,
  onToggleEdit,
  onAddWidget,
  onAutoLayout,
}: DashboardToolbarProps) {
  const {
    state: { timeRange },
    actions: { setTimeRange },
  } = useDashboardTimeRange()

   const pickerRange = resolveForPicker(timeRange)

  return (
    <div className="flex items-center gap-1">
      <TimeRangePicker
        startTime={pickerRange.startTime}
        endTime={pickerRange.endTime}
        presetValue={timeRange.type === "relative" ? timeRange.value : undefined}
        onChange={(range) => {
          if (range.startTime && range.endTime) {
            if (range.presetValue) {
              setTimeRange({
                type: "relative",
                value: range.presetValue,
              })
            } else {
              setTimeRange({
                type: "absolute",
                startTime: range.startTime,
                endTime: range.endTime,
              })
            }
          }
        }}
      />
      {mode === "edit" && (
        <>
          <Button variant="outline" size="sm" onClick={onAddWidget} disabled={readOnly}>
            <PlusIcon size={14} data-icon="inline-start" />
            Add Widget
          </Button>
          <Button variant="outline" size="sm" onClick={onAutoLayout} disabled={readOnly}>
            <GridIcon size={14} data-icon="inline-start" />
            Auto Layout
          </Button>
        </>
      )}
      <Button
        variant={mode === "edit" ? "default" : "outline"}
        size="sm"
        onClick={onToggleEdit}
        disabled={readOnly}
      >
        {mode === "edit" ? <CheckIcon size={14} data-icon="inline-start" /> : <PencilIcon size={14} data-icon="inline-start" />}
        {mode === "edit" ? "Done" : "Edit"}
      </Button>
    </div>
  )
}

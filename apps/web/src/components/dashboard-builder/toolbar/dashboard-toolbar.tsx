import { PlusIcon, PencilIcon, CheckIcon, GridIcon, ChatBubbleSparkleIcon, DotsVerticalIcon, DownloadIcon } from "@/components/icons"

import { Button } from "@maple/ui/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@maple/ui/components/ui/dropdown-menu"
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { downloadPortableDashboard } from "@/components/dashboard-builder/portable-dashboard"
import { relativeToAbsolute } from "@/lib/time-utils"
import type { Dashboard, TimeRange, WidgetMode } from "@/components/dashboard-builder/types"

interface DashboardToolbarProps {
  mode: WidgetMode
  readOnly?: boolean
  dashboard: Dashboard
  onToggleEdit: () => void
  onAddWidget: () => void
  onAutoLayout: () => void
  onOpenAi?: () => void
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
  dashboard,
  onToggleEdit,
  onAddWidget,
  onAutoLayout,
  onOpenAi,
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
      {onOpenAi && (
        <Button variant="outline" size="sm" onClick={onOpenAi}>
          <ChatBubbleSparkleIcon size={14} data-icon="inline-start" />
          AI
        </Button>
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
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-xs" />}
        >
          <DotsVerticalIcon size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[160px]">
          <DropdownMenuItem onClick={() => downloadPortableDashboard(dashboard)} className="whitespace-nowrap">
            <DownloadIcon size={14} />
            Export as JSON
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

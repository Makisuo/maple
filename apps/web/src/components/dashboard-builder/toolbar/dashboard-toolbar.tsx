import { PlusIcon, PencilIcon, CheckIcon, GridIcon, ChatBubbleSparkleIcon, DotsVerticalIcon, DownloadIcon, HistoryIcon } from "@/components/icons"

import { Button } from "@maple/ui/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@maple/ui/components/ui/dropdown-menu"
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { useDashboardActions } from "@/components/dashboard-builder/dashboard-actions-context"
import { downloadPortableDashboard } from "@/components/dashboard-builder/portable-dashboard"
import type { Dashboard } from "@/components/dashboard-builder/types"

interface DashboardToolbarProps {
  dashboard: Dashboard
  onToggleEdit: () => void
  onAddWidget: () => void
  onOpenAi?: () => void
  onOpenHistory?: () => void
}

export function DashboardToolbar({
  dashboard,
  onToggleEdit,
  onAddWidget,
  onOpenAi,
  onOpenHistory,
}: DashboardToolbarProps) {
  const { mode, readOnly, autoLayoutWidgets } = useDashboardActions()
  const {
    state: { timeRange, resolvedTimeRange },
    actions: { setTimeRange },
  } = useDashboardTimeRange()

  const isEdit = mode === "edit"

  return (
    <div className="flex items-center gap-3">
      <TimeRangePicker
        startTime={resolvedTimeRange?.startTime}
        endTime={resolvedTimeRange?.endTime}
        presetValue={timeRange.type === "relative" ? timeRange.value : undefined}
        showLiveControls
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

      <div className="flex items-center gap-1">
        {isEdit && (
          <Button variant="outline" size="sm" onClick={onAddWidget} disabled={readOnly}>
            <PlusIcon size={14} data-icon="inline-start" />
            Add Widget
          </Button>
        )}
        {onOpenAi && (
          <Button variant="outline" size="sm" onClick={onOpenAi}>
            <ChatBubbleSparkleIcon size={14} data-icon="inline-start" />
            AI
          </Button>
        )}
        <Button
          variant={isEdit ? "default" : "outline"}
          size="sm"
          onClick={onToggleEdit}
          disabled={readOnly}
        >
          {isEdit ? <CheckIcon size={14} data-icon="inline-start" /> : <PencilIcon size={14} data-icon="inline-start" />}
          {isEdit ? "Done" : "Edit"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-xs" aria-label="More dashboard actions" />}
          >
            <DotsVerticalIcon size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            {isEdit && (
              <DropdownMenuItem
                onClick={autoLayoutWidgets}
                disabled={readOnly}
                className="whitespace-nowrap"
              >
                <GridIcon size={14} />
                Auto Layout
              </DropdownMenuItem>
            )}
            {onOpenHistory && (
              <DropdownMenuItem onClick={onOpenHistory} className="whitespace-nowrap">
                <HistoryIcon size={14} />
                Version history
              </DropdownMenuItem>
            )}
            {(isEdit || onOpenHistory) && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onClick={() => downloadPortableDashboard(dashboard)}
              className="whitespace-nowrap"
            >
              <DownloadIcon size={14} />
              Export as JSON
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

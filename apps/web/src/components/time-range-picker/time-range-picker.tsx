import { useState, useCallback } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { Button } from "@maple/ui/components/ui/button"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { Separator } from "@maple/ui/components/ui/separator"
import { ClockIcon } from "@/components/icons"

import { formatTimeRangeDisplay, presetLabel, type TimePreset, relativeToAbsolute } from "@/lib/time-utils"
import { useRecentlyUsedTimes, type RecentTimeRange } from "@/hooks/use-recently-used-times"

import type { TimeRangePickerProps, TimeRangeTab } from "./types"
import { PresetList } from "./preset-list"
import { QuickSelectGrid } from "./quick-select-grid"
import { ShorthandInput } from "./shorthand-input"
import { RecentlyUsed } from "./recently-used"
import { TimezoneDisplay } from "./timezone-display"
import { CustomRangePicker } from "./custom-range-picker"

export function TimeRangePicker({ startTime, endTime, presetValue, onChange }: TimeRangePickerProps) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<TimeRangeTab>("relative")
  const { recentTimes, addRecentTime } = useRecentlyUsedTimes()

  const displayText = presetValue
    ? presetLabel(presetValue)
    : formatTimeRangeDisplay(startTime, endTime)

  const handlePresetSelect = useCallback(
    (preset: TimePreset) => {
      const range = preset.getRange()
      onChange({ ...range, presetValue: preset.value })
      addRecentTime({
        label: preset.label,
        value: preset.value,
        ...range,
      })
      setOpen(false)
    },
    [onChange, addRecentTime]
  )

  const handleQuickSelect = useCallback(
    (range: { startTime: string; endTime: string }, value: string, label: string) => {
      onChange({ ...range, presetValue: value })
      addRecentTime({
        label: `Last ${label}`,
        value,
        ...range,
      })
      setOpen(false)
    },
    [onChange, addRecentTime]
  )

  const handleShorthandApply = useCallback(
    (range: { startTime: string; endTime: string }, value: string, label: string) => {
      onChange({ ...range, presetValue: value })
      addRecentTime({
        label,
        value,
        ...range,
      })
      setOpen(false)
    },
    [onChange, addRecentTime]
  )

  const handleRecentSelect = useCallback(
    (item: RecentTimeRange) => {
      // Refresh the time range based on the relative value
      const range = relativeToAbsolute(item.value)
      if (range) {
        onChange({ ...range, presetValue: item.value })
        addRecentTime({
          ...item,
          ...range,
        })
      } else {
        // Custom range - use stored values
        onChange({ startTime: item.startTime, endTime: item.endTime })
      }
      setOpen(false)
    },
    [onChange, addRecentTime]
  )

  const handleCustomApply = useCallback(
    (range: { startTime: string; endTime: string }) => {
      onChange(range)
      addRecentTime({
        label: "Custom range",
        value: `custom-${Date.now()}`,
        ...range,
      })
      setOpen(false)
      setTab("relative")
    },
    [onChange, addRecentTime]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="gap-2">
            <ClockIcon className="size-3.5" />
            <span>{displayText}</span>
          </Button>
        }
      />
      <PopoverContent
        align="end"
        className={tab === "custom" ? "w-auto p-4" : "w-[520px] p-0"}
      >
        {tab === "custom" ? (
          <CustomRangePicker
            startTime={startTime}
            endTime={endTime}
            onApply={handleCustomApply}
            onCancel={() => setTab("relative")}
          />
        ) : (
          <div className="flex">
            {/* Left column: Presets */}
            <ScrollArea className="h-[320px] w-[160px] border-r">
              <PresetList
                selectedValue={undefined}
                onSelect={handlePresetSelect}
                onCustomClick={() => setTab("custom")}
              />
            </ScrollArea>

            {/* Right column: Quick select, input, recent, timezone */}
            <div className="flex-1 p-3 space-y-4">
              <ShorthandInput onApply={handleShorthandApply} />

              <Separator />

              <QuickSelectGrid onSelect={handleQuickSelect} />

              {recentTimes.length > 0 && (
                <>
                  <Separator />
                  <RecentlyUsed recentTimes={recentTimes} onSelect={handleRecentSelect} />
                </>
              )}

              <Separator />

              <TimezoneDisplay />
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

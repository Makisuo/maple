import { Button } from "@maple/ui/components/ui/button"
import { Switch } from "@maple/ui/components/ui/switch"

import { ArrowPathIcon, RadioCheckedIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"

import { TimeRangePicker } from "./time-range-picker"
import { LIVE_REFRESH_INTERVAL_MS, usePageRefreshContext } from "./page-refresh-context"
import type { TimeRange } from "./types"

interface TimeRangeHeaderControlsProps {
  startTime?: string
  endTime?: string
  presetValue?: string
  onTimeChange: (range: TimeRange) => void
}

export function TimeRangeHeaderControls({
  startTime,
  endTime,
  presetValue,
  onTimeChange,
}: TimeRangeHeaderControlsProps) {
  const { liveEnabled, isReloading, reload, setLiveEnabled } = usePageRefreshContext()

  return (
    <div className="flex flex-wrap items-center gap-2">
      <TimeRangePicker
        startTime={startTime}
        endTime={endTime}
        presetValue={presetValue}
        onChange={onTimeChange}
      />
      <Button type="button" variant="outline" size="sm" onClick={reload} disabled={isReloading}>
        <ArrowPathIcon className={cn("size-3.5", isReloading && "animate-spin")} />
        <span>Reload</span>
      </Button>
      <label className="flex h-7 items-center gap-2 border border-border bg-background px-2.5 text-xs">
        <Switch
          size="sm"
          checked={liveEnabled}
          onCheckedChange={setLiveEnabled}
          aria-label="Enable live mode"
        />
        <span className="font-medium">Live</span>
        <span className="text-[10px] text-muted-foreground">
          {Math.floor(LIVE_REFRESH_INTERVAL_MS / 1000)}s
        </span>
        <RadioCheckedIcon
          className={cn(
            "size-3 text-severity-info transition-opacity",
            liveEnabled ? "opacity-100" : "opacity-0",
          )}
        />
      </label>
    </div>
  )
}

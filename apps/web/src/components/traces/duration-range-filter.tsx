import * as React from "react"
import { ChevronDownIcon } from "@/components/icons"

import { cn } from "@maple/ui/utils"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@maple/ui/components/ui/collapsible"

interface DurationRangeFilterProps {
  minValue: number | undefined
  maxValue: number | undefined
  onMinChange: (value: number | undefined) => void
  onMaxChange: (value: number | undefined) => void
  durationStats?: {
    minDurationMs: number
    maxDurationMs: number
    p50DurationMs: number
    p95DurationMs: number
  }
  defaultOpen?: boolean
}

export function DurationRangeFilter({
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
  durationStats,
  defaultOpen = true,
}: DurationRangeFilterProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen)

  const handleMinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    onMinChange(val === "" ? undefined : Number(val))
  }

  const handleMaxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    onMaxChange(val === "" ? undefined : Number(val))
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between py-2 text-sm font-medium hover:text-foreground text-muted-foreground transition-colors">
        <span>Duration (ms)</span>
        <ChevronDownIcon
          className={cn("size-4 transition-transform", isOpen && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-3">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Label htmlFor="min-duration" className="text-xs text-muted-foreground mb-1 block">
                Min
              </Label>
              <Input
                id="min-duration"
                type="number"
                min={0}
                placeholder={durationStats ? String(Math.floor(durationStats.minDurationMs)) : "0"}
                value={minValue ?? ""}
                onChange={handleMinChange}
              />
            </div>
            <span className="text-muted-foreground mt-5">-</span>
            <div className="flex-1">
              <Label htmlFor="max-duration" className="text-xs text-muted-foreground mb-1 block">
                Max
              </Label>
              <Input
                id="max-duration"
                type="number"
                min={0}
                placeholder={durationStats ? String(Math.ceil(durationStats.maxDurationMs)) : ""}
                value={maxValue ?? ""}
                onChange={handleMaxChange}
              />
            </div>
          </div>
          {durationStats && (
            <div className="text-xs text-muted-foreground space-y-1">
              <div className="flex justify-between">
                <span>p50:</span>
                <span className="tabular-nums">{formatDuration(durationStats.p50DurationMs)}</span>
              </div>
              <div className="flex justify-between">
                <span>p95:</span>
                <span className="tabular-nums">{formatDuration(durationStats.p95DurationMs)}</span>
              </div>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)}us`
  }
  if (ms < 1000) {
    return `${ms.toFixed(1)}ms`
  }
  return `${(ms / 1000).toFixed(2)}s`
}

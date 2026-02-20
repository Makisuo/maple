import { useState, useEffect } from "react"
import { Calendar } from "@maple/ui/components/ui/calendar"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { format, parse, isValid, setHours, setMinutes } from "date-fns"
import type { DateRange } from "react-day-picker"
import { formatForTinybird } from "@/lib/time-utils"

interface CustomRangePickerProps {
  startTime?: string
  endTime?: string
  onApply: (range: { startTime: string; endTime: string }) => void
  onCancel: () => void
}

export function CustomRangePicker({
  startTime,
  endTime,
  onApply,
  onCancel,
}: CustomRangePickerProps) {
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    const from = startTime ? new Date(startTime) : undefined
    const to = endTime ? new Date(endTime) : undefined
    return from || to ? { from, to } : undefined
  })

  const [startTimeInput, setStartTimeInput] = useState(() => {
    return startTime ? format(new Date(startTime), "HH:mm") : "00:00"
  })

  const [endTimeInput, setEndTimeInput] = useState(() => {
    return endTime ? format(new Date(endTime), "HH:mm") : "23:59"
  })

  useEffect(() => {
    const from = startTime ? new Date(startTime) : undefined
    const to = endTime ? new Date(endTime) : undefined

    if (from) {
      setStartTimeInput(format(from, "HH:mm"))
    }
    if (to) {
      setEndTimeInput(format(to, "HH:mm"))
    }

    if (from || to) {
      setDateRange({ from, to })
    }
  }, [startTime, endTime])

  const handleApply = () => {
    if (!dateRange?.from || !dateRange?.to) return

    const [startHour, startMin] = startTimeInput.split(":").map(Number)
    const [endHour, endMin] = endTimeInput.split(":").map(Number)

    let startDate = setHours(setMinutes(dateRange.from, startMin || 0), startHour || 0)
    let endDate = setHours(setMinutes(dateRange.to, endMin || 0), endHour || 0)

    onApply({
      startTime: formatForTinybird(startDate),
      endTime: formatForTinybird(endDate),
    })
  }

  const parseTimeInput = (input: string): { hours: number; minutes: number } | null => {
    const parsed = parse(input, "HH:mm", new Date())
    if (isValid(parsed)) {
      return { hours: parsed.getHours(), minutes: parsed.getMinutes() }
    }
    return null
  }

  const isValidRange = dateRange?.from && dateRange?.to &&
    parseTimeInput(startTimeInput) && parseTimeInput(endTimeInput)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-4">
        <Calendar
          mode="range"
          selected={dateRange}
          onSelect={setDateRange}
          numberOfMonths={2}
          disabled={{ after: new Date() }}
        />
      </div>

      <div className="flex gap-4 items-end">
        <div className="flex-1 space-y-1">
          <label className="text-xs text-muted-foreground">Start time</label>
          <Input
            type="time"
            value={startTimeInput}
            onChange={(e) => setStartTimeInput(e.target.value)}
            className="font-mono"
          />
        </div>
        <div className="flex-1 space-y-1">
          <label className="text-xs text-muted-foreground">End time</label>
          <Input
            type="time"
            value={endTimeInput}
            onChange={(e) => setEndTimeInput(e.target.value)}
            className="font-mono"
          />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleApply} disabled={!isValidRange}>
          Apply
        </Button>
      </div>
    </div>
  )
}

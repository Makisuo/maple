export interface TimeRange {
  startTime?: string
  endTime?: string
  presetValue?: string
}

export interface TimeRangePickerProps {
  startTime?: string
  endTime?: string
  presetValue?: string
  onChange: (range: TimeRange) => void
  showLiveControls?: boolean
}

export type TimeRangeTab = "relative" | "custom"

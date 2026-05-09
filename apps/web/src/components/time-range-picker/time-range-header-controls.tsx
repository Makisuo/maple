import { Button } from "@maple/ui/components/ui/button"

import { XmarkIcon } from "@/components/icons"

import { TimeRangePicker } from "./time-range-picker"
import { ReloadControls } from "./reload-controls"
import type { TimeRange } from "./types"

interface TimeRangeHeaderControlsProps {
	startTime?: string
	endTime?: string
	presetValue?: string
	defaultPreset?: string
	onTimeChange: (range: TimeRange) => void
}

export function TimeRangeHeaderControls({
	startTime,
	endTime,
	presetValue,
	defaultPreset = "12h",
	onTimeChange,
}: TimeRangeHeaderControlsProps) {
	const hasCustomRange = !presetValue && !!startTime

	return (
		<div className="flex flex-wrap items-center gap-2">
			<div className="flex items-center">
				<TimeRangePicker
					startTime={startTime}
					endTime={endTime}
					presetValue={presetValue}
					onChange={onTimeChange}
				/>
				{hasCustomRange && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="-ml-px size-7 p-0"
						onClick={() => onTimeChange({ presetValue: defaultPreset })}
						aria-label="Reset to default time range"
					>
						<XmarkIcon className="size-3" />
					</Button>
				)}
			</div>
			<ReloadControls />
		</div>
	)
}

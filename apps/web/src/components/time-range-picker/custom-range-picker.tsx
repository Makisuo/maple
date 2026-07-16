import { useState } from "react"
import { Calendar } from "@maple/ui/components/ui/calendar"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { parse, isValid } from "date-fns"
import type { DateRange } from "react-day-picker"
import type { TimeZoneId } from "@/hooks/use-time-format"
import {
	wallClockCalendarDay,
	wallClockTimeInput,
	wallClockToWarehouse,
	warehouseToWallClock,
} from "@/lib/time-range-tz"

interface CustomRangePickerProps {
	startTime?: string
	endTime?: string
	/** The display timezone the picked calendar day + time is interpreted in. */
	timeZone: TimeZoneId
	onApply: (range: { startTime: string; endTime: string }) => void
	onCancel: () => void
}

export function CustomRangePicker({
	startTime,
	endTime,
	timeZone,
	onApply,
	onCancel,
}: CustomRangePickerProps) {
	// Stored times are tz-less UTC warehouse strings; read them back as wall-clock
	// in the selected zone so the calendar day + time inputs reflect what the user
	// will actually query (rather than shifting by the browser offset).
	const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
		const from = startTime
			? wallClockCalendarDay(warehouseToWallClock(startTime, timeZone))
			: undefined
		const to = endTime ? wallClockCalendarDay(warehouseToWallClock(endTime, timeZone)) : undefined
		return from || to ? { from, to } : undefined
	})

	const [startTimeInput, setStartTimeInput] = useState(() => {
		return startTime ? wallClockTimeInput(warehouseToWallClock(startTime, timeZone)) : "00:00"
	})

	const [endTimeInput, setEndTimeInput] = useState(() => {
		return endTime ? wallClockTimeInput(warehouseToWallClock(endTime, timeZone)) : "23:59"
	})

	const handleApply = () => {
		if (!dateRange?.from || !dateRange?.to) return

		const [startHour, startMin] = startTimeInput.split(":").map(Number)
		const [endHour, endMin] = endTimeInput.split(":").map(Number)

		// Interpret each picked calendar day + HH:mm as wall-clock in `timeZone`,
		// then convert to the UTC warehouse string.
		const startWarehouse = wallClockToWarehouse(
			{
				year: dateRange.from.getFullYear(),
				month: dateRange.from.getMonth(),
				day: dateRange.from.getDate(),
				hours: startHour || 0,
				minutes: startMin || 0,
			},
			timeZone,
		)
		const endWarehouse = wallClockToWarehouse(
			{
				year: dateRange.to.getFullYear(),
				month: dateRange.to.getMonth(),
				day: dateRange.to.getDate(),
				hours: endHour || 0,
				minutes: endMin || 0,
			},
			timeZone,
		)

		onApply({
			startTime: startWarehouse,
			endTime: endWarehouse,
		})
	}

	const parseTimeInput = (input: string): { hours: number; minutes: number } | null => {
		const parsed = parse(input, "HH:mm", new Date())
		if (isValid(parsed)) {
			return { hours: parsed.getHours(), minutes: parsed.getMinutes() }
		}
		return null
	}

	const isValidRange =
		dateRange?.from && dateRange?.to && parseTimeInput(startTimeInput) && parseTimeInput(endTimeInput)

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

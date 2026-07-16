import { useCallback, useState } from "react"
import { Button } from "@maple/ui/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@maple/ui/components/ui/popover"

import { ClockIcon } from "@/components/icons"
import { useAppHotkey } from "@/hooks/use-app-hotkey"
import { useRecentlyUsedTimes, type RecentTimeRange } from "@/hooks/use-recently-used-times"
import { useTimeFormat } from "@/hooks/use-time-format"
import { formatTimeRangeDisplay, presetLabel, relativeToAbsolute, type TimePreset } from "@/lib/time-utils"

import { CustomRangePicker } from "./custom-range-picker"
import { PresetList } from "./preset-list"
import { QuickSelectGrid } from "./quick-select-grid"
import { RecentlyUsed } from "./recently-used"
import { ShorthandInput } from "./shorthand-input"
import { TimezoneCombobox } from "./timezone-combobox"
import type { TimeRangePickerProps, TimeRangeTab } from "./types"

export function TimeRangePicker({
	startTime,
	endTime,
	presetValue,
	onChange,
	hotkey = false,
}: TimeRangePickerProps) {
	const [open, setOpen] = useState(false)
	const [tab, setTab] = useState<TimeRangeTab>("relative")
	const { recentTimes, addRecentTime } = useRecentlyUsedTimes()
	const { timeZone } = useTimeFormat()

	// Only the page-level picker opts in (hotkey prop) so secondary pickers
	// (e.g. the widget builder's) don't double-register "D".
	useAppHotkey("time.open", () => setOpen(true), { enabled: hotkey })

	const displayText = presetValue
		? presetLabel(presetValue)
		: formatTimeRangeDisplay(startTime, endTime, timeZone)

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
		[onChange, addRecentTime],
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
		[onChange, addRecentTime],
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
		[onChange, addRecentTime],
	)

	const handleRecentSelect = useCallback(
		(item: RecentTimeRange) => {
			// Refresh the time range based on the relative value
			const range = relativeToAbsolute(item.value, timeZone)
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
		[onChange, addRecentTime, timeZone],
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
		[onChange, addRecentTime],
	)

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						variant="outline"
						size="sm"
						className="gap-2"
						title={hotkey ? "Time range (D)" : undefined}
					>
						<ClockIcon className="size-3.5" />
						<span>{displayText}</span>
					</Button>
				}
			/>
			<PopoverContent
				align="end"
				className={
					// Cap to the viewport so the popover never runs off-screen on
					// phones (the 520px relative pane is wider than a mobile viewport).
					tab === "custom"
						? "w-auto max-w-[calc(100vw-1.5rem)] p-4"
						: "w-[520px] max-w-[calc(100vw-1.5rem)] p-0"
				}
			>
				{tab === "custom" ? (
					<div className="-m-4 flex flex-col">
						<div className="p-4">
							<CustomRangePicker
								startTime={startTime}
								endTime={endTime}
								timeZone={timeZone}
								onApply={handleCustomApply}
								onCancel={() => setTab("relative")}
							/>
						</div>
						<TimezoneCombobox />
					</div>
				) : (
					<div className="flex flex-col">
						<div className="flex items-stretch">
							{/* Left rail: presets */}
							<div className="w-[168px] shrink-0 border-r border-border/70">
								<PresetList
									selectedValue={presetValue}
									onSelect={handlePresetSelect}
									onCustomClick={() => setTab("custom")}
								/>
							</div>

							{/* Right pane: shorthand input + quick select + recent.
							    min-w-0 lets it shrink below content width on narrow
							    viewports so the quick-select grid doesn't overflow. */}
							<div className="min-w-0 flex-1 space-y-5 p-4">
								<ShorthandInput onApply={handleShorthandApply} />
								<QuickSelectGrid onSelect={handleQuickSelect} />
								{recentTimes.length > 0 && (
									<RecentlyUsed recentTimes={recentTimes} onSelect={handleRecentSelect} />
								)}
							</div>
						</div>
						<TimezoneCombobox />
					</div>
				)}
			</PopoverContent>
		</Popover>
	)
}

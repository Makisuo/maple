import { useCallback, useState } from "react"
import { Button } from "@maple/ui/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { toast } from "sonner"

import { ClockIcon } from "@/components/icons"
import { useAppHotkey } from "@/hooks/use-app-hotkey"
import { useRecentlyUsedTimes, type RecentTimeRange } from "@/hooks/use-recently-used-times"
import {
	formatTimeRangeDisplay,
	isTimeRangeWithin,
	PRESET_OPTIONS,
	presetLabel,
	relativeToAbsolute,
	type TimePreset,
} from "@/lib/time-utils"

import { CustomRangePicker } from "./custom-range-picker"
import { PresetList } from "./preset-list"
import { QuickSelectGrid } from "./quick-select-grid"
import { RecentlyUsed } from "./recently-used"
import { ShorthandInput } from "./shorthand-input"
import { TimezoneDisplay } from "./timezone-display"
import type { TimeRangePickerProps, TimeRangeTab } from "./types"

export function TimeRangePicker({
	startTime,
	endTime,
	presetValue,
	onChange,
	hotkey = false,
	presets = PRESET_OPTIONS,
	maxRangeSeconds,
}: TimeRangePickerProps) {
	const [open, setOpen] = useState(false)
	const [tab, setTab] = useState<TimeRangeTab>("relative")
	const { recentTimes, addRecentTime } = useRecentlyUsedTimes()

	// Only the page-level picker opts in (hotkey prop) so secondary pickers
	// (e.g. the widget builder's) don't double-register "D".
	useAppHotkey("time.open", () => setOpen(true), { enabled: hotkey })

	const displayText = presetValue ? presetLabel(presetValue) : formatTimeRangeDisplay(startTime, endTime)
	const rangeAllowed = useCallback(
		(range: { startTime: string; endTime: string }) => {
			if (maxRangeSeconds == null) return true
			if (isTimeRangeWithin(range, maxRangeSeconds)) return true
			toast.error(`This page supports a maximum range of ${Math.round(maxRangeSeconds / 86400)} days`)
			return false
		},
		[maxRangeSeconds],
	)

	const handlePresetSelect = useCallback(
		(preset: TimePreset) => {
			const range = preset.getRange()
			if (!rangeAllowed(range)) return
			onChange({ ...range, presetValue: preset.value })
			addRecentTime({
				label: preset.label,
				value: preset.value,
				...range,
			})
			setOpen(false)
		},
		[onChange, addRecentTime, rangeAllowed],
	)

	const handleQuickSelect = useCallback(
		(range: { startTime: string; endTime: string }, value: string, label: string) => {
			if (!rangeAllowed(range)) return
			onChange({ ...range, presetValue: value })
			addRecentTime({
				label: `Last ${label}`,
				value,
				...range,
			})
			setOpen(false)
		},
		[onChange, addRecentTime, rangeAllowed],
	)

	const handleShorthandApply = useCallback(
		(range: { startTime: string; endTime: string }, value: string, label: string) => {
			if (!rangeAllowed(range)) return
			onChange({ ...range, presetValue: value })
			addRecentTime({
				label,
				value,
				...range,
			})
			setOpen(false)
		},
		[onChange, addRecentTime, rangeAllowed],
	)

	const handleRecentSelect = useCallback(
		(item: RecentTimeRange) => {
			// Refresh the time range based on the relative value
			const range = relativeToAbsolute(item.value)
			if (range) {
				if (!rangeAllowed(range)) return
				onChange({ ...range, presetValue: item.value })
				addRecentTime({
					...item,
					...range,
				})
			} else {
				// Custom range - use stored values
				if (!rangeAllowed({ startTime: item.startTime, endTime: item.endTime })) return
				onChange({ startTime: item.startTime, endTime: item.endTime })
			}
			setOpen(false)
		},
		[onChange, addRecentTime, rangeAllowed],
	)

	const handleCustomApply = useCallback(
		(range: { startTime: string; endTime: string }) => {
			if (!rangeAllowed(range)) return
			onChange(range)
			addRecentTime({
				label: "Custom range",
				value: `custom-${Date.now()}`,
				...range,
			})
			setOpen(false)
			setTab("relative")
		},
		[onChange, addRecentTime, rangeAllowed],
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
					<CustomRangePicker
						startTime={startTime}
						endTime={endTime}
						onApply={handleCustomApply}
						onCancel={() => setTab("relative")}
					/>
				) : (
					<div className="flex flex-col">
						<div className="flex items-stretch">
							{/* Left rail: presets */}
							<div className="w-[168px] shrink-0 border-r border-border/70">
								<PresetList
									presets={presets}
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
						<TimezoneDisplay />
					</div>
				)}
			</PopoverContent>
		</Popover>
	)
}

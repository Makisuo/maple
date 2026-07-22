// Sticky page toolbar family — search + result stats + time range + refresh.
// Data-agnostic: callers own the time-range presets and the refresh action.

import { useCallback, useRef, useState, type ReactNode } from "react"

import { ArrowRotateClockwiseIcon, ClockIcon, MagnifierIcon, XmarkIcon } from "./icons"
import { Button } from "./ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./ui/input-group"
import { NativeSelect, NativeSelectOption } from "./ui/native-select"
import { cn } from "../lib/utils"

export function Toolbar({ search, stats }: { search: ReactNode; stats: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
			{search}
			<div className="flex items-center gap-4">{stats}</div>
		</div>
	)
}

/** Manual reload button; the caller supplies the refetch action (it resolves when done). */
export function RefreshButton({
	onRefresh,
	className,
}: {
	onRefresh: () => Promise<unknown>
	className?: string
}) {
	const [spinning, setSpinning] = useState(false)

	const onClick = useCallback(() => {
		setSpinning(true)
		onRefresh().finally(() => setSpinning(false))
	}, [onRefresh])

	return (
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label="Reload"
			title="Reload"
			onClick={onClick}
			disabled={spinning}
			className={className}
		>
			<ArrowRotateClockwiseIcon className={cn("size-3.5", spinning && "animate-spin")} />
		</Button>
	)
}

export function ToolbarSearch({
	query,
	onSearch,
	placeholder,
	debounceMs = 300,
}: {
	query: string
	onSearch: (value: string | undefined) => void
	placeholder: string
	debounceMs?: number
}) {
	const [value, setValue] = useState(query)
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	// Keep the input in sync when the param changes elsewhere (e.g. Clear all).
	const [lastQuery, setLastQuery] = useState(query)
	if (query !== lastQuery) {
		setLastQuery(query)
		setValue(query)
	}

	const handleChange = useCallback(
		(next: string) => {
			setValue(next)
			if (debounceRef.current) clearTimeout(debounceRef.current)
			debounceRef.current = setTimeout(() => {
				onSearch(next.trim() || undefined)
			}, debounceMs)
		},
		[onSearch, debounceMs],
	)

	return (
		<InputGroup className="max-w-sm">
			<InputGroupAddon>
				<MagnifierIcon />
			</InputGroupAddon>
			<InputGroupInput
				value={value}
				onChange={(e) => handleChange(e.target.value)}
				placeholder={placeholder}
			/>
			{value && (
				<InputGroupAddon align="inline-end">
					<InputGroupButton aria-label="Clear search" onClick={() => handleChange("")}>
						<XmarkIcon />
					</InputGroupButton>
				</InputGroupAddon>
			)}
		</InputGroup>
	)
}

export function ToolbarStat({
	value,
	label,
	dot,
	danger,
}: {
	value: number
	label: string
	dot?: boolean
	danger?: boolean
}) {
	return (
		<span className="flex items-center gap-1.5 text-sm">
			{dot ? <span className="size-1.5 rounded-full bg-success" /> : null}
			<span className={cn("font-medium tabular-nums", danger && value > 0 && "text-destructive")}>
				{value.toLocaleString()}
			</span>
			<span className="text-muted-foreground">{label}</span>
		</span>
	)
}

export interface TimeRangeOption {
	key: string
	label: string
}

export function TimeRangeSelect({
	ranges,
	value,
	onChange,
}: {
	ranges: ReadonlyArray<TimeRangeOption>
	value: string
	onChange: (next: string) => void
}) {
	return (
		<div className="flex items-center gap-1.5">
			<ClockIcon strokeWidth={2} className="size-3.5 text-muted-foreground" />
			<NativeSelect size="sm" value={value} onChange={(e) => onChange(e.target.value)}>
				{ranges.map((range) => (
					<NativeSelectOption key={range.key} value={range.key}>
						{range.label}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</div>
	)
}

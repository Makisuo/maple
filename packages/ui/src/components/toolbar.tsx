// Sticky page toolbar family — search + result stats + time range + refresh.
// Data-agnostic: callers own the time-range presets and the refresh action.

import { useCallback, useRef, useState, type ReactNode } from "react"

import { ArrowRotateClockwiseIcon, ClockIcon, MagnifierIcon, XmarkIcon } from "./icons"
import { Button } from "./ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./ui/input-group"
import { NativeSelect, NativeSelectOption } from "./ui/native-select"
import { useMountEffect } from "../hooks/use-mount-effect"
import { cn } from "../lib/utils"

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3",
				className,
			)}
		>
			{children}
		</div>
	)
}

/** Right-hand cluster of `ToolbarStat`s. */
export function ToolbarStats({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn("flex items-center gap-4", className)}>{children}</div>
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
	className,
}: {
	query: string
	onSearch: (value: string | undefined) => void
	placeholder: string
	debounceMs?: number
	className?: string
}) {
	const [value, setValue] = useState(query)
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	// The trimmed value we last pushed to `onSearch`, in the form it comes back as
	// `query`. Lets us tell an external `query` change (Clear all, back/forward) from
	// our own debounced search echoing back, so a resync never clobbers keystrokes
	// typed during the round-trip.
	const lastSentRef = useRef(query)

	// Keep the input in sync when the param changes elsewhere (e.g. Clear all) —
	// during render, and never for our own echo.
	const [lastQuery, setLastQuery] = useState(query)
	if (query !== lastQuery) {
		setLastQuery(query)
		if (query !== lastSentRef.current) {
			setValue(query)
		}
	}

	// Cancel a pending debounce if the toolbar unmounts mid-type, so it can't fire a
	// search after the page it belongs to is gone.
	useMountEffect(() => () => {
		if (debounceRef.current) clearTimeout(debounceRef.current)
	})

	const handleChange = useCallback(
		(next: string) => {
			setValue(next)
			if (debounceRef.current) clearTimeout(debounceRef.current)
			debounceRef.current = setTimeout(() => {
				const trimmed = next.trim() || undefined
				lastSentRef.current = trimmed ?? ""
				onSearch(trimmed)
			}, debounceMs)
		},
		[onSearch, debounceMs],
	)

	return (
		<InputGroup className={cn("max-w-sm", className)}>
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
		<span className="flex items-center gap-1.5 whitespace-nowrap text-sm">
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

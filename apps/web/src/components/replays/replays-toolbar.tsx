import { useCallback, useEffect, useRef, useState } from "react"

import { MagnifierIcon, XmarkIcon } from "@/components/icons"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { cn } from "@maple/ui/utils"

interface ReplaysToolbarProps {
	/** Current `q` search param (URL substring filter). */
	query: string
	onSearch: (value: string | undefined) => void
	totalSessions: number
	activeSessions: number
	errorSessions: number
	/** Dim the stats while the list is refetching. */
	waiting?: boolean
}

export function ReplaysToolbar({
	query,
	onSearch,
	totalSessions,
	activeSessions,
	errorSessions,
	waiting = false,
}: ReplaysToolbarProps) {
	const [value, setValue] = useState(query)
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	// Keep the input in sync when the param changes elsewhere (e.g. Clear all).
	useEffect(() => {
		setValue(query)
	}, [query])

	const handleChange = useCallback(
		(next: string) => {
			setValue(next)
			if (debounceRef.current) clearTimeout(debounceRef.current)
			debounceRef.current = setTimeout(() => {
				onSearch(next.trim() || undefined)
			}, 300)
		},
		[onSearch],
	)

	return (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<InputGroup className="w-full sm:max-w-sm">
				<InputGroupAddon>
					<MagnifierIcon />
				</InputGroupAddon>
				<InputGroupInput
					value={value}
					onChange={(e) => handleChange(e.target.value)}
					placeholder="Search by URL…"
				/>
				{value && (
					<InputGroupAddon align="inline-end">
						<InputGroupButton aria-label="Clear search" onClick={() => handleChange("")}>
							<XmarkIcon />
						</InputGroupButton>
					</InputGroupAddon>
				)}
			</InputGroup>

			<div
				className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-sm transition-opacity", waiting && "opacity-60")}
			>
				<Stat label="sessions" value={totalSessions} />
				<span className="flex items-center gap-1.5 whitespace-nowrap">
					<span className="size-1.5 rounded-full bg-success" />
					<span className="font-medium tabular-nums">{activeSessions.toLocaleString()}</span>
					<span className="text-muted-foreground">active</span>
				</span>
				<span className="flex items-center gap-1.5 whitespace-nowrap">
					<span className={cn("font-medium tabular-nums", errorSessions > 0 && "text-destructive")}>
						{errorSessions.toLocaleString()}
					</span>
					<span className="text-muted-foreground">with errors</span>
				</span>
			</div>
		</div>
	)
}

function Stat({ label, value }: { label: string; value: number }) {
	return (
		<span className="flex items-center gap-1.5 whitespace-nowrap">
			<span className="font-medium tabular-nums">{value.toLocaleString()}</span>
			<span className="text-muted-foreground">{label}</span>
		</span>
	)
}

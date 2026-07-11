import { useCallback, useRef, useState } from "react"

import { useMountEffect } from "@/hooks/use-mount-effect"
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
	const [prevQuery, setPrevQuery] = useState(query)
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	// The trimmed value we last pushed to `onSearch`, in the form it comes back as
	// `query`. Lets us tell an external `q` change (Clear all, back/forward) from
	// our own debounced search echoing through the URL, so a resync never clobbers
	// keystrokes typed since.
	const lastSentRef = useRef(query)

	// Resync the input when `q` changes from outside — during render (no double
	// commit), and never for our own echo.
	if (query !== prevQuery) {
		setPrevQuery(query)
		if (query !== lastSentRef.current) {
			setValue(query)
		}
	}

	// Cancel a pending debounce if the toolbar unmounts mid-type.
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

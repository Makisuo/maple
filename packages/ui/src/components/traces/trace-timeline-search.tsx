import * as React from "react"
import { MagnifierIcon, XmarkIcon } from "../icons"

interface TraceTimelineSearchProps {
	query: string
	onQueryChange: (query: string) => void
	matchCount: number
	totalCount: number
	/** 1-based index of the current match, or 0 when none is active. */
	currentMatch: number
	/** Step to the next (+1) / previous (-1) match. */
	onNavigate: (direction: 1 | -1) => void
	inputRef: React.RefObject<HTMLInputElement | null>
}

export function TraceTimelineSearch({
	query,
	onQueryChange,
	matchCount,
	totalCount,
	currentMatch,
	onNavigate,
	inputRef,
}: TraceTimelineSearchProps) {
	return (
		<div className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5">
			<MagnifierIcon size={13} className="text-muted-foreground shrink-0" />
			<input
				ref={inputRef}
				type="text"
				value={query}
				onChange={(e) => onQueryChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && matchCount > 0) {
						e.preventDefault()
						e.stopPropagation()
						onNavigate(e.shiftKey ? -1 : 1)
					}
				}}
				placeholder="Search spans... (Enter next · ⇧Enter prev)"
				className="flex-1 bg-transparent text-xs font-mono text-foreground placeholder:text-muted-foreground/50 outline-none"
			/>
			{query && (
				<>
					<span className="text-[10px] font-mono text-muted-foreground shrink-0 tabular-nums">
						{currentMatch > 0 ? `${currentMatch}/${matchCount}` : `${matchCount} of ${totalCount}`}
					</span>
					<button
						type="button"
						onClick={() => onQueryChange("")}
						className="text-muted-foreground hover:text-foreground shrink-0"
					>
						<XmarkIcon size={12} />
					</button>
				</>
			)}
		</div>
	)
}

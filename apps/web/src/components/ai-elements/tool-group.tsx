import { useState, type ReactNode } from "react"
import { ChevronDownIcon, ChevronRightIcon, CircleCheckIcon, CircleXmarkIcon } from "@/components/icons"
import { ThinkingOrbIcon } from "./thinking-orb-icon"
import { toolOrbState } from "./tool-metadata"

interface ToolGroupProps {
	count: number
	runningCount: number
	errorCount: number
	/** Label of the tool currently running, shown in the live header. */
	currentLabel?: string
	/** Raw name of that same call, so the header's orb matches what's actually in flight. */
	currentToolName?: string
	/** How many calls in the group have finished, for the `done/total` counter. */
	completedCount: number
	children: ReactNode
}

export function ToolGroup({
	count,
	runningCount,
	errorCount,
	currentLabel,
	currentToolName,
	completedCount,
	children,
}: ToolGroupProps) {
	// Collapsed by default — even mid-burst. The header carries live progress so a
	// 30-call run stays a single line instead of a wall of cards.
	const [open, setOpen] = useState(false)
	const running = runningCount > 0

	return (
		<div className="overflow-hidden rounded-lg border border-border/60 bg-muted/20 text-sm">
			<button
				type="button"
				className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/40"
				onClick={() => setOpen((v) => !v)}
			>
				{/* The orb tracks the call actually in flight, so the header reads as one live line:
				    a scanning globe for `search_traces`, a scrambling cube for `run_sql`. Settled
				    glyphs match its 20px so the header doesn't jump when the last call lands. */}
				{running ? (
					<ThinkingOrbIcon state={toolOrbState(currentToolName ?? "")} />
				) : errorCount > 0 ? (
					<CircleXmarkIcon className="size-5 shrink-0 text-destructive" />
				) : (
					<CircleCheckIcon className="size-5 shrink-0 text-severity-info" />
				)}
				{running ? (
					// No "Running…" prefix and no generic code glyph: the orb already says running, and
					// the tool's own name says more than either. Just what's happening, and how far in.
					<span className="min-w-0 flex-1 truncate font-medium text-foreground">
						{currentLabel ?? "Working"}
						<span className="ml-1.5 font-normal text-muted-foreground/60 tabular-nums">
							{completedCount}/{count}
						</span>
					</span>
				) : (
					<span className="min-w-0 flex-1 truncate font-medium text-foreground">
						Used {count} tools
						{errorCount > 0 ? (
							<span className="ml-1 font-normal text-destructive tabular-nums">
								· {errorCount} failed
							</span>
						) : null}
					</span>
				)}
				{open ? (
					<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
				) : (
					<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
				)}
			</button>
			{open && (
				<div className="max-h-[55vh] divide-y divide-border/30 overflow-y-auto border-t border-border/50">
					{children}
				</div>
			)}
		</div>
	)
}

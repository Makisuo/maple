import { useState, type ReactNode } from "react"
import {
	ChevronDownIcon,
	ChevronRightIcon,
	CircleCheckIcon,
	CircleXmarkIcon,
	LoaderIcon,
	CodeIcon,
} from "@/components/icons"

interface ToolGroupProps {
	count: number
	runningCount: number
	errorCount: number
	/** Label of the tool currently running, shown in the live header. */
	currentLabel?: string
	/** How many calls in the group have finished, for the `done/total` counter. */
	completedCount: number
	children: ReactNode
}

export function ToolGroup({
	count,
	runningCount,
	errorCount,
	currentLabel,
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
				{running ? (
					<LoaderIcon className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
				) : errorCount > 0 ? (
					<CircleXmarkIcon className="size-4 shrink-0 text-destructive" />
				) : (
					<CircleCheckIcon className="size-4 shrink-0 text-severity-info" />
				)}
				<CodeIcon className="size-4 shrink-0 text-muted-foreground" />
				{running ? (
					<span className="min-w-0 flex-1 truncate font-medium text-foreground">
						Running…
						{currentLabel ? (
							<span className="ml-1 font-normal text-muted-foreground">{currentLabel}</span>
						) : null}
						<span className="ml-1 font-normal text-muted-foreground/60 tabular-nums">
							· {completedCount}/{count}
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

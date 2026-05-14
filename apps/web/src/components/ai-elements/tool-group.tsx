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
	defaultOpen?: boolean
	children: ReactNode
}

export function ToolGroup({ count, runningCount, errorCount, defaultOpen = false, children }: ToolGroupProps) {
	const [open, setOpen] = useState(defaultOpen)
	const completed = runningCount === 0

	return (
		<div className="my-2 overflow-hidden rounded-lg border border-border/60 bg-muted/30 text-xs">
			<button
				type="button"
				className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
				onClick={() => setOpen((v) => !v)}
			>
				<CodeIcon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="font-medium">
					{completed ? `Used ${count} tools` : `Using ${count} tools`}
				</span>
				<span className="ml-auto flex items-center gap-1.5">
					{runningCount > 0 && <LoaderIcon className="size-3 animate-spin text-muted-foreground" />}
					{completed && errorCount > 0 && <CircleXmarkIcon className="size-3.5 text-destructive" />}
					{completed && errorCount === 0 && <CircleCheckIcon className="size-3.5 text-severity-info" />}
					{open ? (
						<ChevronDownIcon className="size-3 text-muted-foreground" />
					) : (
						<ChevronRightIcon className="size-3 text-muted-foreground" />
					)}
				</span>
			</button>
			{open && <div className="space-y-0 border-t border-border/50 p-1.5">{children}</div>}
		</div>
	)
}

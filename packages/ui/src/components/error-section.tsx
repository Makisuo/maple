// The error alert banner shared by span detail panels and log detail views.
// Previously four near-identical copies across web and local-ui; parameterize
// on the title, an optional exception-type chip, and the "Copy as prompt"
// payload instead of forking the markup again.

import { useState } from "react"

import { ChevronDownIcon, ChevronUpIcon, CircleWarningIcon } from "./icons"
import { Alert, AlertDescription, AlertTitle } from "./ui/alert"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible"
import { CopyButton } from "./ui/copy-button"
import { formatErrorPrompt } from "../lib/error-prompt"
import { cn } from "../lib/utils"

export interface ErrorSectionProps {
	message: string
	/** Banner heading; e.g. "Fatal" for fatal-severity logs. */
	title?: string
	/** Monospace chip beside the title — typically `exception.type`. */
	badge?: string
	/**
	 * Telemetry context for the "Copy as prompt" action; the button renders only
	 * when this is present. `message` is included automatically.
	 */
	prompt?: {
		serviceName: string
		/** Span name / operation. Omitted for logs that aren't tied to an operation. */
		operation?: string
		attributes?: Record<string, string>
	}
	className?: string
}

export function ErrorSection({ message, title = "Error", badge, prompt, className }: ErrorSectionProps) {
	const [expanded, setExpanded] = useState(false)
	const isLong = message.length > 120 || message.includes("\n")

	return (
		<Alert variant="error" className={cn("mx-3 my-2 rounded-md border-destructive/30", className)}>
			<CircleWarningIcon size={14} />
			<AlertTitle className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
				<span className="flex items-center gap-2">
					{title}
					{badge && (
						<span className="font-mono text-[10px] break-all text-destructive/80">{badge}</span>
					)}
				</span>
				{prompt && (
					<CopyButton
						value={() => formatErrorPrompt({ message, ...prompt })}
						label="Error prompt"
						idleLabel="Copy as prompt"
						iconSize={10}
						className="h-5 px-1.5 text-[10px] text-destructive hover:bg-destructive/10 hover:text-destructive/80"
					/>
				)}
			</AlertTitle>
			<AlertDescription>
				{isLong ? (
					<Collapsible open={expanded} onOpenChange={setExpanded}>
						{!expanded && (
							<p className="font-mono text-[11px] break-words line-clamp-2">{message}</p>
						)}
						<CollapsibleTrigger className="mt-1 flex items-center gap-1 text-[10px] text-destructive hover:text-destructive/80">
							{expanded ? "Show less" : "Show full error"}
							{expanded ? <ChevronUpIcon size={10} /> : <ChevronDownIcon size={10} />}
						</CollapsibleTrigger>
						<CollapsibleContent>
							<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-destructive/5 p-2 font-mono text-[11px]">
								{message}
							</pre>
						</CollapsibleContent>
					</Collapsible>
				) : (
					<p className="font-mono text-[11px] break-words">{message}</p>
				)}
			</AlertDescription>
		</Alert>
	)
}

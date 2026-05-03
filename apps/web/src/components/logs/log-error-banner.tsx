import { useState } from "react"
import { CircleWarningIcon, ChevronDownIcon, ChevronUpIcon } from "@/components/icons"

import { Alert, AlertTitle, AlertDescription } from "@maple/ui/components/ui/alert"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@maple/ui/components/ui/collapsible"
import type { Log } from "@/api/tinybird/logs"

interface LogErrorBannerProps {
	log: Log
}

function getErrorMessage(log: Log): string {
	return log.logAttributes["exception.message"] ?? log.logAttributes["error.message"] ?? log.body ?? ""
}

export function LogErrorBanner({ log }: LogErrorBannerProps) {
	const [expanded, setExpanded] = useState(false)
	const message = getErrorMessage(log)
	const isFatal = log.severityText.toUpperCase() === "FATAL"
	const title = isFatal ? "Fatal" : "Error"
	const isLong = message.length > 120 || message.includes("\n")
	const exceptionType = log.logAttributes["exception.type"] ?? log.logAttributes["error.type"]

	if (!message) return null

	return (
		<Alert variant="destructive" className="mx-3 my-2 rounded-md border-destructive/30">
			<CircleWarningIcon size={14} />
			<AlertTitle className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
				<span>{title}</span>
				{exceptionType && (
					<span className="font-mono text-[10px] text-destructive/80 break-all">{exceptionType}</span>
				)}
			</AlertTitle>
			<AlertDescription>
				{isLong ? (
					<Collapsible open={expanded} onOpenChange={setExpanded}>
						{!expanded && <p className="font-mono text-[11px] line-clamp-2 break-words">{message}</p>}
						<CollapsibleTrigger className="text-[10px] text-destructive hover:text-destructive/80 mt-1 flex items-center gap-1">
							{expanded ? "Show less" : "Show full error"}
							{expanded ? <ChevronUpIcon size={10} /> : <ChevronDownIcon size={10} />}
						</CollapsibleTrigger>
						<CollapsibleContent>
							<pre className="font-mono text-[11px] whitespace-pre-wrap break-all mt-2 p-2 bg-destructive/5 rounded max-h-48 overflow-auto">
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

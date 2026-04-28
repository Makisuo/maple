import { useState } from "react"
import { XmarkIcon, ChevronDownIcon, ChevronUpIcon } from "@/components/icons"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { SheetClose } from "@maple/ui/components/ui/sheet"
import { Tooltip, TooltipTrigger, TooltipContent } from "@maple/ui/components/ui/tooltip"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@maple/ui/components/ui/collapsible"
import { cn } from "@maple/ui/utils"
import { CopyableValue } from "@/components/attributes"
import { SeverityBadge } from "./severity-badge"
import type { Log } from "@/api/tinybird/logs"

const HERO_TONE: Record<string, string> = {
	TRACE: "bg-severity-trace/5 border-severity-trace/20",
	DEBUG: "bg-severity-debug/5 border-severity-debug/20",
	INFO: "bg-severity-info/5 border-severity-info/20",
	WARN: "bg-severity-warn/5 border-severity-warn/20",
	WARNING: "bg-severity-warn/5 border-severity-warn/20",
	ERROR: "bg-severity-error/5 border-severity-error/20",
	FATAL: "bg-severity-fatal/5 border-severity-fatal/20",
}

const BODY_LINE_THRESHOLD = 280

interface LogHeroHeaderProps {
	log: Log
}

export function LogHeroHeader({ log }: LogHeroHeaderProps) {
	const [expanded, setExpanded] = useState(false)
	const tone = HERO_TONE[log.severityText.toUpperCase()] ?? "border-border"
	const body = log.body ?? ""
	const isLong = body.length > BODY_LINE_THRESHOLD || body.includes("\n")

	return (
		<div className={cn("border-b px-4 py-3 shrink-0", tone)}>
			<div className="flex items-center gap-2">
				<Tooltip>
					<TooltipTrigger render={<span className="cursor-help inline-flex" />}>
						<SeverityBadge severity={log.severityText} />
					</TooltipTrigger>
					<TooltipContent side="bottom">OTel severity number {log.severityNumber}</TooltipContent>
				</Tooltip>
				<Badge variant="outline" className="font-mono text-[10px]">
					<CopyableValue value={log.serviceName}>{log.serviceName}</CopyableValue>
				</Badge>
				<SheetClose render={<Button variant="ghost" size="icon" className="ml-auto shrink-0" />}>
					<XmarkIcon size={16} />
				</SheetClose>
			</div>

			<div className="mt-2.5">
				{isLong ? (
					<Collapsible open={expanded} onOpenChange={setExpanded}>
						{!expanded && (
							<CopyableValue value={body}>
								<p className="font-mono text-sm leading-relaxed whitespace-pre-wrap break-words line-clamp-4">
									{body}
								</p>
							</CopyableValue>
						)}
						<CollapsibleContent>
							<CopyableValue value={body}>
								<p className="font-mono text-sm leading-relaxed whitespace-pre-wrap break-words">
									{body}
								</p>
							</CopyableValue>
						</CollapsibleContent>
						<CollapsibleTrigger className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors">
							{expanded ? "Show less" : "Show full message"}
							{expanded ? <ChevronUpIcon size={10} /> : <ChevronDownIcon size={10} />}
						</CollapsibleTrigger>
					</Collapsible>
				) : (
					<CopyableValue value={body}>
						<p className="font-mono text-sm leading-relaxed whitespace-pre-wrap break-words">
							{body}
						</p>
					</CopyableValue>
				)}
			</div>
		</div>
	)
}

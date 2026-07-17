import { useMemo, useState } from "react"
import { XmarkIcon, ChevronDownIcon, ChevronUpIcon } from "@/components/icons"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { SheetClose } from "@maple/ui/components/ui/sheet"
import { Tooltip, TooltipTrigger, TooltipContent } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/utils"
import { CopyableValue, tryParseJson } from "@/components/attributes"
import { highlightCode } from "@/lib/sugar-high"
import { SeverityBadge } from "@maple/ui/components/logs/severity-badge"
import type { Log } from "@/api/warehouse/logs"
import { ServiceDot } from "@maple/ui/components/service-dot"

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
	/**
	 * Render the drawer close button. Must be `false` outside a `Sheet`
	 * (e.g. the standalone `/logs/$logId` page) — `SheetClose` throws when
	 * rendered without a `Sheet` ancestor.
	 */
	showClose?: boolean
}

export function LogHeroHeader({ log, showClose = true }: LogHeroHeaderProps) {
	const [expanded, setExpanded] = useState(false)
	const tone = HERO_TONE[log.severityText.toUpperCase()] ?? "border-border"
	const body = log.body ?? ""

	// A JSON body (object/array) is pretty-printed and syntax-highlighted, like
	// the Raw panel; anything else renders as plain text.
	const parsed = tryParseJson(body)
	const isJson = parsed !== null
	const formatted = useMemo(
		() => (parsed !== null ? JSON.stringify(parsed, null, 2) : body),
		[parsed, body],
	)
	const highlighted = useMemo(() => (isJson ? highlightCode(formatted) : ""), [isJson, formatted])
	const copyValue = isJson ? formatted : body
	const isLong = formatted.length > BODY_LINE_THRESHOLD || formatted.includes("\n")

	// `clamp` truncates the collapsed preview; JSON gets a few more lines since
	// pretty-printing spreads it out vertically.
	const message = (clamp: boolean) =>
		isJson ? (
			<pre
				className={cn(
					"font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words",
					clamp && "line-clamp-6",
				)}
			>
				<code dangerouslySetInnerHTML={{ __html: highlighted }} />
			</pre>
		) : (
			<p
				className={cn(
					"font-mono text-sm leading-relaxed whitespace-pre-wrap break-words",
					clamp && "line-clamp-4",
				)}
			>
				{body}
			</p>
		)

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
					<ServiceDot serviceName={log.serviceName} className="size-1.5" />
					<CopyableValue value={log.serviceName}>{log.serviceName}</CopyableValue>
				</Badge>
				{showClose && (
					<SheetClose render={<Button variant="ghost" size="icon" className="ml-auto shrink-0" />}>
						<XmarkIcon size={16} />
					</SheetClose>
				)}
			</div>

			{/*
			 * A single message node whose clamp simply toggles — no Collapsible.
			 * The earlier dual-render (separate clamped preview + animated
			 * CollapsibleContent, each with its own dangerouslySetInnerHTML)
			 * flickered on toggle as the two nodes swapped mid-animation.
			 */}
			<div className="mt-3">
				<CopyableValue value={copyValue}>{message(isLong && !expanded)}</CopyableValue>
				{isLong && (
					<button
						type="button"
						onClick={() => setExpanded((v) => !v)}
						className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
					>
						{expanded ? "Show less" : "Show full message"}
						{expanded ? <ChevronUpIcon size={10} /> : <ChevronDownIcon size={10} />}
					</button>
				)}
			</div>
		</div>
	)
}

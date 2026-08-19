// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
// Intentionally divergent from the web app's `@/components/logs/log-detail-sheet`:
// that one is wired to effect-atom (trace timeline, correlated logs) and a wider
// sub-component family local mode doesn't have. The shareable pieces (AttributesSection,
// SeverityBadge, severity/format libs) already come from @maple/ui.

import { useMemo, useState } from "react"
import { Sheet, SheetContent, SheetTitle } from "@maple/ui/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@maple/ui/components/ui/tabs"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { SeverityBadge } from "@maple/ui/components/logs/severity-badge"
import {
	CircleInfoIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	ClockIcon,
	CodeIcon,
	PulseIcon,
	XmarkIcon,
} from "@maple/ui/components/icons"
import { CopyableValue, AttributesSection, ResourceAttributesSection } from "@maple/ui/components/attributes"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { cn } from "@maple/ui/lib/utils"
import type { LocalLog } from "../lib/log-shape"
import { navigate } from "../lib/router"
import { ErrorSection } from "@maple/ui/components/error-section"
import { SearchInput } from "@maple/ui/components/ui/search-input"
import { highlightJson } from "../lib/highlight"

interface LogDetailSheetProps {
	log: LocalLog | null
	open: boolean
	onOpenChange: (open: boolean) => void
}

/**
 * Slide-out drawer for a single log, mirroring the web app's `LogDetailSheet`:
 * a tone-tinted hero, a meta strip with trace/span links, an error banner for
 * ERROR/FATAL, and Attributes / Trace / Raw tabs. The list row already carries
 * the full (decoded) attribute maps, so no extra fetch is needed.
 */
export function LogDetailSheet({ log, open, onOpenChange }: LogDetailSheetProps) {
	if (!log) return null

	const sev = log.severityText.toUpperCase()
	const showErrorBanner = sev === "ERROR" || sev === "FATAL"
	// Identity used to remount the attributes panel (resets its search) per log.
	const logKey = `${log.timestamp}-${log.spanId}-${log.body.slice(0, 24)}`

	const openTrace = () => {
		if (!log.traceId) return
		navigate(`/traces/${encodeURIComponent(log.traceId)}`)
		onOpenChange(false)
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex flex-col p-0 sm:max-w-2xl" showCloseButton={false}>
				<SheetTitle className="sr-only">Log: {log.body.slice(0, 80)}</SheetTitle>

				<LogHeroHeader log={log} onClose={() => onOpenChange(false)} />
				<LogMetaStrip log={log} onOpenTrace={openTrace} />
				{showErrorBanner && <LogErrorBanner log={log} />}

				<Tabs defaultValue="attributes" className="flex min-h-0 flex-1 flex-col">
					<TabsList variant="underline" className="shrink-0 px-4">
						<TabsTrigger value="attributes">
							<CircleInfoIcon size={14} /> Attributes
						</TabsTrigger>
						{log.traceId && (
							<TabsTrigger value="trace">
								<PulseIcon size={14} /> Trace
							</TabsTrigger>
						)}
						<TabsTrigger value="raw">
							<CodeIcon size={14} /> Raw
						</TabsTrigger>
					</TabsList>

					<TabsContent value="attributes" className="mt-0 min-h-0 flex-1">
						<ScrollArea className="h-full">
							<div className="p-3">
								<LogAttributesPanel key={logKey} log={log} />
							</div>
						</ScrollArea>
					</TabsContent>

					{log.traceId && (
						<TabsContent value="trace" className="mt-0 min-h-0 flex-1">
							<ScrollArea className="h-full">
								<div className="p-3">
									<LogTracePanel log={log} onOpenTrace={openTrace} />
								</div>
							</ScrollArea>
						</TabsContent>
					)}

					<TabsContent value="raw" className="mt-0 min-h-0 flex-1">
						<ScrollArea className="h-full">
							<div className="p-3">
								<LogRawPanel log={log} />
							</div>
						</ScrollArea>
					</TabsContent>
				</Tabs>
			</SheetContent>
		</Sheet>
	)
}

const HERO_TONE: Record<string, string> = {
	TRACE: "bg-severity-trace/5 border-severity-trace/20",
	DEBUG: "bg-severity-debug/5 border-severity-debug/20",
	INFO: "bg-severity-info/5 border-severity-info/20",
	WARN: "bg-severity-warn/5 border-severity-warn/20",
	WARNING: "bg-severity-warn/5 border-severity-warn/20",
	ERROR: "bg-severity-error/5 border-severity-error/20",
	FATAL: "bg-severity-fatal/5 border-severity-fatal/20",
} satisfies Record<string, string>

const BODY_LINE_THRESHOLD = 280

function tryParse(value: string): unknown | null {
	const trimmed = value.trimStart()
	if (trimmed[0] !== "{" && trimmed[0] !== "[") return null
	try {
		return JSON.parse(value)
	} catch {
		return null
	}
}

function LogHeroHeader({ log, onClose }: { log: LocalLog; onClose: () => void }) {
	const [expanded, setExpanded] = useState(false)
	const tone = HERO_TONE[log.severityText.toUpperCase()] ?? "border-border"
	const body = log.body ?? ""

	const parsed = tryParse(body)
	const isJson = parsed !== null
	const formatted = useMemo(
		() => (parsed !== null ? JSON.stringify(parsed, null, 2) : body),
		[parsed, body],
	)
	const highlighted = useMemo(() => (isJson ? highlightJson(formatted) : ""), [isJson, formatted])
	const copyValue = isJson ? formatted : body
	const isLong = formatted.length > BODY_LINE_THRESHOLD || formatted.includes("\n")

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
		<div className={cn("shrink-0 border-b px-4 py-3", tone)}>
			<div className="flex items-center gap-2">
				<SeverityBadge severity={log.severityText} />
				<Badge variant="outline" className="font-mono text-[10px]">
					<CopyableValue value={log.serviceName}>{log.serviceName}</CopyableValue>
				</Badge>
				<Button variant="ghost" size="icon" className="ml-auto shrink-0" onClick={onClose}>
					<XmarkIcon size={16} />
				</Button>
			</div>

			<div className="mt-3">
				<CopyableValue value={copyValue}>{message(isLong && !expanded)}</CopyableValue>
				{isLong && (
					<button
						type="button"
						onClick={() => setExpanded((v) => !v)}
						className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
					>
						{expanded ? "Show less" : "Show full message"}
						{expanded ? <ChevronUpIcon size={10} /> : <ChevronDownIcon size={10} />}
					</button>
				)}
			</div>
		</div>
	)
}

function LogMetaStrip({ log, onOpenTrace }: { log: LocalLog; onOpenTrace: () => void }) {
	return (
		<div className="flex shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b px-4 py-1.5 text-xs">
			<div className="flex shrink-0 items-center gap-1.5">
				<ClockIcon size={12} className="text-muted-foreground" />
				<span className="font-mono">
					<CopyableValue value={log.timestamp}>{log.timestamp}</CopyableValue>
				</span>
			</div>

			{log.traceId && (
				<button
					type="button"
					onClick={onOpenTrace}
					className="inline-flex shrink-0 items-center gap-1 rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 font-mono text-[11px] text-primary transition-colors hover:bg-primary/10"
					title={`View trace ${log.traceId}`}
				>
					<PulseIcon size={10} />
					trace:{log.traceId.slice(0, 8)}
				</button>
			)}

			{log.spanId && (
				<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
					<CopyableValue value={log.spanId}>span:{log.spanId.slice(0, 8)}</CopyableValue>
				</span>
			)}

			<div className="ml-auto flex shrink-0 items-center gap-0.5">
				<CopyButton value={() => buildLogJsonPayload(log)} label="Log JSON" iconSize={13} tooltip />
			</div>
		</div>
	)
}

function getErrorMessage(log: LocalLog): string {
	return log.logAttributes["exception.message"] ?? log.logAttributes["error.message"] ?? log.body ?? ""
}

function LogErrorBanner({ log }: { log: LocalLog }) {
	const message = getErrorMessage(log)
	if (!message) return null

	return (
		<ErrorSection
			message={message}
			title={log.severityText.toUpperCase() === "FATAL" ? "Fatal" : "Error"}
			badge={log.logAttributes["exception.type"] ?? log.logAttributes["error.type"]}
			prompt={{ serviceName: log.serviceName, attributes: log.logAttributes }}
		/>
	)
}

function LogAttributesPanel({ log }: { log: LocalLog }) {
	const [attrSearch, setAttrSearch] = useState("")

	const hasAttributes =
		Object.keys(log.logAttributes).length > 0 || Object.keys(log.resourceAttributes).length > 0

	return (
		<div className="space-y-3">
			{hasAttributes && (
				<SearchInput
					value={attrSearch}
					onValueChange={setAttrSearch}
					placeholder="Search attributes..."
				/>
			)}

			<AttributesSection
				attributes={log.logAttributes}
				title="Log Attributes"
				searchQuery={attrSearch}
				groupByNamespace
			/>
			<ResourceAttributesSection
				attributes={log.resourceAttributes}
				searchQuery={attrSearch}
				groupByNamespace
			/>
		</div>
	)
}

function LogTracePanel({ log, onOpenTrace }: { log: LocalLog; onOpenTrace: () => void }) {
	return (
		<div className="space-y-3">
			<div className="rounded-md border p-2 text-xs space-y-1">
				<div className="flex justify-between gap-3">
					<span className="text-muted-foreground">Trace ID</span>
					<span className="truncate font-mono">
						<CopyableValue value={log.traceId}>{log.traceId}</CopyableValue>
					</span>
				</div>
				{log.spanId && (
					<div className="flex justify-between gap-3">
						<span className="text-muted-foreground">Span ID</span>
						<span className="truncate font-mono">
							<CopyableValue value={log.spanId}>{log.spanId}</CopyableValue>
						</span>
					</div>
				)}
			</div>
			<Button variant="outline" size="sm" className="w-full gap-1.5" onClick={onOpenTrace}>
				<PulseIcon size={14} />
				Open trace
			</Button>
		</div>
	)
}

/** Pretty-printed JSON of the full log, with a copy control. */
function buildLogJsonPayload(log: LocalLog): string {
	return JSON.stringify(
		{
			timestamp: log.timestamp,
			severityText: log.severityText,
			severityNumber: log.severityNumber,
			serviceName: log.serviceName,
			body: log.body,
			traceId: log.traceId || undefined,
			spanId: log.spanId || undefined,
			logAttributes: log.logAttributes,
			resourceAttributes: log.resourceAttributes,
		},
		null,
		2,
	)
}

function LogRawPanel({ log }: { log: LocalLog }) {
	const jsonPayload = buildLogJsonPayload(log)
	const highlighted = useMemo(() => highlightJson(jsonPayload), [jsonPayload])

	return (
		<div>
			<div className="mb-2 flex items-center justify-between">
				<span className="text-xs font-medium text-muted-foreground">JSON Payload</span>
				<CopyButton
					value={jsonPayload}
					label="Log JSON"
					idleLabel="Copy"
					iconSize={10}
					className="h-5 px-1.5 text-[10px]"
				/>
			</div>
			<pre className="whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
				<code dangerouslySetInnerHTML={{ __html: highlighted }} />
			</pre>
		</div>
	)
}

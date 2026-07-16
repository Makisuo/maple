import { useState, type ReactNode } from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	XmarkIcon,
	ClockIcon,
	CircleWarningIcon,
	CircleInfoIcon,
	SquareTerminalIcon,
	ServerIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	CopyIcon,
} from "@/components/icons"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"

import { Button } from "@maple/ui/components/ui/button"
import { Alert, AlertTitle, AlertDescription } from "@maple/ui/components/ui/alert"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@maple/ui/components/ui/collapsible"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@maple/ui/components/ui/tabs"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { type Log, type LogsResponse } from "@/api/warehouse/logs"
import { LogDetailSheet } from "@/components/logs/log-detail-sheet"
import { formatDuration } from "@/lib/format"
import { cn } from "@maple/ui/utils"
import { getCacheInfo, cacheResultStyles } from "@maple/ui/lib/cache"
import { getCloudPlatform, outcomeBadgeStyle } from "@maple/ui/lib/cloud-platforms"
import { GlobeIcon } from "@maple/ui/components/icons"
import { getServiceLegendColor } from "@maple/ui/lib/colors"
import type { SpanNode, SpanDetailResult } from "@/api/warehouse/traces"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { getSpanDetailResultAtom, listLogsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { CopyableValue, AttributesTable, ResourceAttributesSection } from "@/components/attributes"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { getActiveInfraCorrelations } from "@/components/infra/infra-correlations"
import { InfraCorrelationPanel, infraCorrelationWindow } from "@/components/infra/infra-correlation-panel"

interface SpanDetailPanelProps {
	span: SpanNode
	services: string[]
	onClose: () => void
}

const statusStyles: Record<string, string> = {
	Ok: "bg-severity-info/15 text-severity-info border-severity-info/30",
	Error: "bg-severity-error/15 text-severity-error border-severity-error/30",
	Unset: "bg-muted text-muted-foreground border-border",
}

const kindLabels: Record<string, string> = {
	SPAN_KIND_SERVER: "Server",
	SPAN_KIND_CLIENT: "Client",
	SPAN_KIND_PRODUCER: "Producer",
	SPAN_KIND_CONSUMER: "Consumer",
	SPAN_KIND_INTERNAL: "Internal",
}

/**
 * Label/value row that survives a narrow panel: the label holds its width, the value takes the rest
 * and ellipsises. Values are click-to-copy, so a truncated display still yields the full string.
 */
function PlatformRow({
	label,
	children,
	className,
}: {
	label: string
	children: ReactNode
	className?: string
}) {
	return (
		<div className={cn("flex items-center justify-between gap-2 min-w-0", className)}>
			<span className="text-muted-foreground shrink-0">{label}</span>
			<span className="font-mono truncate text-right">{children}</span>
		</div>
	)
}

const severityStyles: Record<string, string> = {
	TRACE: "text-severity-trace",
	DEBUG: "text-severity-debug",
	INFO: "text-severity-info",
	WARN: "text-severity-warn",
	ERROR: "text-severity-error",
	FATAL: "text-severity-fatal",
}

function LogEntry({ log, timeZone, onClick }: { log: Log; timeZone: string; onClick?: (log: Log) => void }) {
	const severityStyle = severityStyles[log.severityText] ?? "text-severity-trace"

	return (
		<div
			className="border-b p-2 last:border-b-0 hover:bg-muted/30 cursor-pointer"
			onClick={() => onClick?.(log)}
		>
			<div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-1">
				<span>{formatTimestampInTimezone(log.timestamp, { timeZone })}</span>
				<Badge variant="outline" className={cn("text-[10px] px-1 py-0", severityStyle)}>
					{log.severityText}
				</Badge>
			</div>
			<p className="font-mono text-xs whitespace-pre-wrap break-all line-clamp-3">{log.body}</p>
		</div>
	)
}

interface ErrorSectionProps {
	message: string
	serviceName: string
	spanName: string
	attributes?: Record<string, string>
}

function formatErrorPrompt({ message, serviceName, spanName, attributes }: ErrorSectionProps): string {
	const relevantKeys = [
		"http.method",
		"http.url",
		"http.route",
		"http.status_code",
		"db.system.name",
		"db.system",
		"db.query.text",
		"db.statement",
		"rpc.method",
		"rpc.service",
		"messaging.system",
		"messaging.operation",
	]

	const contextLines: string[] = []
	if (attributes) {
		for (const key of relevantKeys) {
			if (attributes[key]) {
				contextLines.push(`- ${key}: ${attributes[key]}`)
			}
		}
	}

	return `I'm debugging an error in my distributed system. Please help me understand and fix this issue.

**Service:** ${serviceName}
**Operation:** ${spanName}

**Error:**
\`\`\`
${message}
\`\`\`
${
	contextLines.length > 0
		? `
**Context:**
${contextLines.join("\n")}
`
		: ""
}
What could be causing this error and how can I fix it?`
}

function ErrorSection({ message, serviceName, spanName, attributes }: ErrorSectionProps) {
	const promptCopy = useCopyToClipboard("Error prompt")
	const [expanded, setExpanded] = useState(false)
	const isLong = message.length > 120 || message.includes("\n")

	const handleCopyPrompt = () =>
		promptCopy.copy(formatErrorPrompt({ message, serviceName, spanName, attributes }))

	return (
		<Alert variant="error" className="mx-3 my-2 rounded-md border-destructive/30">
			<CircleWarningIcon size={14} />
			<AlertTitle className="flex items-center justify-between">
				<span>Error</span>
				<Button
					variant="ghost"
					size="sm"
					className="h-5 px-1.5 text-[10px] text-destructive hover:text-destructive/80 hover:bg-destructive/10"
					onClick={handleCopyPrompt}
				>
					<CopyIcon size={10} className="mr-1" />
					Copy as prompt
				</Button>
			</AlertTitle>
			<AlertDescription>
				{isLong ? (
					<Collapsible open={expanded} onOpenChange={setExpanded}>
						{!expanded && <p className="font-mono text-[11px] line-clamp-2">{message}</p>}
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
					<p className="font-mono text-[11px]">{message}</p>
				)}
			</AlertDescription>
		</Alert>
	)
}

function SpanLogs({ traceId, spanId, timeZone }: { traceId: string; spanId: string; timeZone: string }) {
	const [selectedLog, setSelectedLog] = useState<Log | null>(null)
	const [sheetOpen, setSheetOpen] = useState(false)

	const handleLogClick = (log: Log) => {
		setSelectedLog(log)
		setSheetOpen(true)
	}

	const logsResult = useAtomValue(
		traceId && spanId
			? listLogsResultAtom({ data: { traceId, spanId, limit: 100 } })
			: disabledResultAtom<LogsResponse>(),
	)

	return (
		<>
			{Result.builder(logsResult)
				.onInitial(() => (
					<div className="space-y-2 p-2">
						{Array.from({ length: 3 }).map((_, i) => (
							<div key={i} className="space-y-1">
								<Skeleton className="h-3 w-24" />
								<Skeleton className="h-4 w-full" />
							</div>
						))}
					</div>
				))
				.onError(() => (
					<div className="p-4 text-center text-sm text-destructive">Failed to load logs</div>
				))
				.onSuccess((data) => {
					const logs = data.data

					if (logs.length === 0) {
						return (
							<div className="p-4 text-center text-sm text-muted-foreground">
								No logs found for this span
							</div>
						)
					}

					return (
						<div className="divide-y">
							{logs.map((log, i) => (
								<LogEntry
									key={`${log.timestamp}-${i}`}
									log={log}
									timeZone={timeZone}
									onClick={handleLogClick}
								/>
							))}
						</div>
					)
				})
				.render()}
			<LogDetailSheet log={selectedLog} open={sheetOpen} onOpenChange={setSheetOpen} />
		</>
	)
}

export function SpanDetailPanel({ span, services, onClose }: SpanDetailPanelProps) {
	const { effectiveTimezone } = useTimezonePreference()
	const cacheInfo = getCacheInfo(span.spanAttributes)
	const statusStyle = statusStyles[span.statusCode] ?? statusStyles.Unset
	const kindLabel = kindLabels[span.spanKind] ?? span.spanKind?.replace("SPAN_KIND_", "") ?? "Unknown"
	const logsResult = useAtomValue(
		span.traceId && span.spanId
			? listLogsResultAtom({ data: { traceId: span.traceId, spanId: span.spanId, limit: 100 } })
			: disabledResultAtom<LogsResponse>(),
	)
	const logCount = Result.isSuccess(logsResult) ? logsResult.value.data.length : null

	// Full attribute maps are loaded lazily here — the span hierarchy query only
	// returns the trimmed keys the tree views render. span.startTime is a
	// timestamp inside the trace, used to narrow the partition scan.
	const detailResult = useAtomValue(
		span.traceId && span.spanId && !span.isMissing
			? getSpanDetailResultAtom({
					data: { traceId: span.traceId, spanId: span.spanId, timestamp: span.startTime },
				})
			: disabledResultAtom<SpanDetailResult>(),
	)
	const detailAttrs = Result.isSuccess(detailResult) ? detailResult.value : null

	// Prefer the lazily-loaded full resource map; fall back to the trimmed span
	// map so the tab can appear before the detail query resolves.
	const infraAttrs = detailAttrs?.resourceAttributes ?? span.resourceAttributes
	const hasInfra = getActiveInfraCorrelations(infraAttrs).length > 0

	// Serverless/cloud platform annotations (Cloudflare, Vercel, …). The
	// hierarchy query only projects a few keys (edge/outcome); the full field set
	// arrives with the lazily-loaded detail attrs.
	const platform = getCloudPlatform(detailAttrs?.spanAttributes ?? span.spanAttributes)

	return (
		<div className="flex flex-col h-full border-l bg-background overflow-hidden">
			{/* Header */}
			<div className="flex items-center justify-between border-b px-3 py-2 shrink-0">
				<div className="flex-1 min-w-0 mr-2 overflow-hidden">
					<CopyableValue value={span.spanName} className="block min-w-0 overflow-hidden">
						<div className="min-w-0">
							<HttpSpanLabel
								spanName={span.spanName}
								spanAttributes={span.spanAttributes}
								spanKind={span.spanKind}
								textClassName="font-semibold text-sm"
							/>
						</div>
					</CopyableValue>
					<div className="flex items-center gap-2 mt-0.5">
						<Badge
							variant="outline"
							className="font-mono text-[10px]"
							style={{ color: getServiceLegendColor(span.serviceName, services) }}
						>
							<CopyableValue value={span.serviceName}>{span.serviceName}</CopyableValue>
						</Badge>
						<span className="text-[10px] text-muted-foreground">{kindLabel}</span>
					</div>
				</div>
				<Button variant="ghost" size="icon" onClick={onClose} className="shrink-0">
					<XmarkIcon size={16} />
				</Button>
			</div>

			{/* Summary stats */}
			<div className="flex items-center gap-4 border-b px-3 py-1.5 text-xs shrink-0">
				<div className="flex items-center gap-1.5">
					<ClockIcon size={12} className="text-muted-foreground" />
					<span className="font-mono">
						<CopyableValue value={formatDuration(span.durationMs)}>
							{formatDuration(span.durationMs)}
						</CopyableValue>
					</span>
				</div>
				{cacheInfo?.result ? (
					<Badge
						variant="outline"
						className={cn("text-[10px] font-medium", cacheResultStyles[cacheInfo.result])}
					>
						{cacheInfo.result === "hit" ? "HIT" : "MISS"}
					</Badge>
				) : (
					<Badge variant="outline" className={cn("text-[10px] font-medium", statusStyle)}>
						{span.statusCode || "Unset"}
					</Badge>
				)}
			</div>

			{/* Cache summary */}
			{cacheInfo && (
				<div className="flex items-center gap-3 border-b px-3 py-1.5 text-xs shrink-0">
					{cacheInfo.system && (
						<Badge variant="outline" className="text-[10px] font-mono">
							{cacheInfo.system}
						</Badge>
					)}
					{cacheInfo.operation && (
						<span className="font-mono text-muted-foreground uppercase">
							{cacheInfo.operation}
						</span>
					)}
					{cacheInfo.name && (
						<span className="font-mono text-muted-foreground truncate" title={cacheInfo.name}>
							{cacheInfo.name}
						</span>
					)}
				</div>
			)}

			{/* Cloud platform summary (Cloudflare, Vercel, …) */}
			{platform && (
				<div className="@container/platform border-b px-3 py-2 text-xs shrink-0 space-y-1.5">
					<div className="flex items-center gap-1.5">
						<platform.Icon size={12} className={cn("shrink-0", platform.accentClassName)} />
						<span className="font-medium">{platform.label}</span>
						{platform.outcome && (
							<Badge
								variant="outline"
								className={cn(
									"text-[10px] font-medium ml-auto",
									outcomeBadgeStyle(platform.outcome.bad),
								)}
							>
								{platform.outcome.value}
							</Badge>
						)}
					</div>
					{/* Two columns only once the panel is wide enough for them to hold real values. */}
					<div className="grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] @min-[22rem]/platform:grid-cols-2">
						{platform.edge && (
							<PlatformRow label="Edge">
								<span className="inline-flex items-center gap-1">
									<GlobeIcon size={10} className="shrink-0" />
									{platform.edge}
								</span>
							</PlatformRow>
						)}
						{platform.location && <PlatformRow label="Location">{platform.location}</PlatformRow>}
						{platform.fields.map((field) => (
							<PlatformRow
								key={field.label}
								label={field.label}
								className={field.wide ? "@min-[22rem]/platform:col-span-2" : undefined}
							>
								{field.copyable ? (
									<CopyableValue value={field.value}>
										{field.display ?? field.value}
									</CopyableValue>
								) : (
									(field.display ?? field.value)
								)}
							</PlatformRow>
						))}
					</div>
				</div>
			)}

			{/* Error section */}
			{span.statusCode === "Error" && span.statusMessage && (
				<ErrorSection
					message={span.statusMessage}
					serviceName={span.serviceName}
					spanName={span.spanName}
					attributes={detailAttrs?.spanAttributes ?? span.spanAttributes}
				/>
			)}

			{/* Tabs content */}
			<Tabs defaultValue="details" className="flex-1 flex flex-col min-h-0">
				{/* TabsList is w-fit, so in a narrow panel it would overflow and the last tab would be
				    clipped out of reach — cap it and let it scroll instead. */}
				<TabsList variant="underline" className="shrink-0 max-w-full overflow-x-auto px-4">
					<TabsTrigger value="details">
						<CircleInfoIcon size={14} /> Details
					</TabsTrigger>
					<TabsTrigger value="logs">
						<SquareTerminalIcon size={14} /> Logs
						{logCount !== null && logCount > 0 && (
							<Badge variant="secondary" className="text-[10px] ml-1 px-1.5 py-0">
								{logCount}
							</Badge>
						)}
					</TabsTrigger>
					{hasInfra && (
						<TabsTrigger value="infrastructure">
							<ServerIcon size={14} /> Infrastructure
						</TabsTrigger>
					)}
				</TabsList>

				<TabsContent value="details" className="flex-1 min-h-0 mt-0">
					<ScrollArea className="h-full">
						<div className="p-3 space-y-3">
							{/* Timing info */}
							<div className="space-y-1">
								<h4 className="text-xs font-medium text-muted-foreground">Timing</h4>
								<div className="rounded-md border p-2 space-y-1 text-xs">
									<PlatformRow label="Start Time">
										<CopyableValue value={span.startTime}>
											{formatTimestampInTimezone(span.startTime, {
												timeZone: effectiveTimezone,
												withMilliseconds: true,
											})}
										</CopyableValue>
									</PlatformRow>
									<PlatformRow label="Duration">
										<CopyableValue value={formatDuration(span.durationMs)}>
											{formatDuration(span.durationMs)}
										</CopyableValue>
									</PlatformRow>
								</div>
							</div>

							{/* IDs */}
							<div className="space-y-1">
								<h4 className="text-xs font-medium text-muted-foreground">Identifiers</h4>
								<div className="rounded-md border p-2 space-y-1 text-xs">
									<PlatformRow label="Span ID">
										<CopyableValue value={span.spanId}>{span.spanId}</CopyableValue>
									</PlatformRow>
									<PlatformRow label="Trace ID">
										<CopyableValue value={span.traceId}>{span.traceId}</CopyableValue>
									</PlatformRow>
									{span.parentSpanId && (
										<PlatformRow label="Parent Span ID">
											<CopyableValue value={span.parentSpanId}>
												{span.parentSpanId}
											</CopyableValue>
										</PlatformRow>
									)}
								</div>
							</div>

							{/* Span + Resource Attributes — loaded lazily for the
							    selected span (see detailResult above) */}
							{span.isMissing ? (
								<AttributesTable
									attributes={span.spanAttributes ?? {}}
									title="Span Attributes"
								/>
							) : (
								Result.builder(detailResult)
									.onInitial(() => (
										<div className="space-y-2">
											<Skeleton className="h-4 w-32" />
											<Skeleton className="h-24 w-full" />
											<Skeleton className="h-4 w-32" />
											<Skeleton className="h-24 w-full" />
										</div>
									))
									.onError(() => (
										<>
											<AttributesTable
												attributes={span.spanAttributes ?? {}}
												title="Span Attributes"
											/>
											<ResourceAttributesSection
												attributes={span.resourceAttributes ?? {}}
											/>
										</>
									))
									.onSuccess((detail) => (
										<>
											<AttributesTable
												attributes={detail.spanAttributes}
												title="Span Attributes"
											/>
											<ResourceAttributesSection
												attributes={detail.resourceAttributes}
											/>
										</>
									))
									.render()
							)}
						</div>
					</ScrollArea>
				</TabsContent>

				<TabsContent value="logs" className="flex-1 min-h-0 mt-0">
					<ScrollArea className="h-full">
						<SpanLogs traceId={span.traceId} spanId={span.spanId} timeZone={effectiveTimezone} />
					</ScrollArea>
				</TabsContent>

				{hasInfra && (
					<TabsContent value="infrastructure" className="flex-1 min-h-0 mt-0">
						<ScrollArea className="h-full">
							<div className="p-3">
								<InfraCorrelationPanel
									resourceAttributes={infraAttrs}
									{...infraCorrelationWindow(span.startTime, {
										spanDurationMs: span.durationMs,
									})}
								/>
							</div>
						</ScrollArea>
					</TabsContent>
				)}
			</Tabs>
		</div>
	)
}

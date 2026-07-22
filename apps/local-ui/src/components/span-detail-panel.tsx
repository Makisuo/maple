// Intentionally divergent from the web app's `@/components/traces/span-detail-panel`:
// that one is wired to effect-atom, infra correlation, and timezone preferences local
// mode doesn't have. The shareable pieces (AttributesTable, SeverityBadge,
// HttpSpanLabel, format/colors libs) already come from @maple/ui.

import { useState } from "react"
import { toast } from "sonner"
import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { SeverityBadge } from "@maple/ui/components/logs/severity-badge"
import { Button } from "@maple/ui/components/ui/button"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@maple/ui/components/ui/tabs"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { Alert, AlertTitle, AlertDescription } from "@maple/ui/components/ui/alert"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@maple/ui/components/ui/collapsible"
import {
	XmarkIcon,
	ClockIcon,
	CircleInfoIcon,
	CircleWarningIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	CopyIcon,
	CodeIcon,
} from "@maple/ui/components/icons"
import { CopyableValue, AttributesTable, ResourceAttributesSection } from "@maple/ui/components/attributes"
import { useClipboard } from "@maple/ui/hooks/use-clipboard"
import { getCacheInfo, cacheResultStyles } from "@maple/ui/lib/cache"
import { getServiceColor } from "@maple/ui/lib/colors"
import { formatDuration } from "@maple/ui/format"
import { cn } from "@maple/ui/utils"
import type { SpanNode } from "@maple/ui/types"
import { useLocalSpanDetail } from "../hooks/use-local-span-detail"
import { useLocalSpanLogs } from "../hooks/use-local-span-logs"
import { formatErrorPrompt } from "../lib/error-prompt"
import type { LocalLog } from "../lib/log-shape"
import { LogDetailSheet } from "./log-detail-sheet"

interface SpanDetailPanelProps {
	span: SpanNode
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

export function SpanDetailPanel({ span, onClose }: SpanDetailPanelProps) {
	const cacheInfo = getCacheInfo(span.spanAttributes)
	const statusStyle = statusStyles[span.statusCode] ?? statusStyles.Unset
	const kindLabel = kindLabels[span.spanKind] ?? span.spanKind?.replace("SPAN_KIND_", "") ?? "Unknown"

	const logs = useLocalSpanLogs(span.traceId, span.spanId)
	const logCount = logs.data?.length ?? null

	// Full attribute maps load lazily — the hierarchy query only returns the
	// trimmed keys the tree renders. Missing (placeholder) spans have no row to
	// look up, so we fall back to whatever the tree carried.
	const detail = useLocalSpanDetail(
		span.isMissing ? undefined : span.traceId,
		span.isMissing ? undefined : span.spanId,
	)

	return (
		<aside className="flex h-full w-[28rem] shrink-0 flex-col overflow-hidden border-l bg-background">
			{/* Header */}
			<div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
				<div className="mr-2 min-w-0 flex-1 overflow-hidden">
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
					<div className="mt-0.5 flex items-center gap-2">
						<Badge
							variant="outline"
							className="font-mono text-[10px]"
							style={{ color: getServiceColor(span.serviceName) }}
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
			<div className="flex shrink-0 items-center gap-4 border-b px-3 py-1.5 text-xs">
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

			{/* Error section */}
			{span.statusCode === "Error" && span.statusMessage && (
				<ErrorSection
					message={span.statusMessage}
					serviceName={span.serviceName}
					spanName={span.spanName}
					attributes={detail.data?.spanAttributes ?? span.spanAttributes}
				/>
			)}

			{/* Tabs */}
			<Tabs defaultValue="details" className="flex min-h-0 flex-1 flex-col">
				<TabsList variant="underline" className="shrink-0 px-4">
					<TabsTrigger value="details">
						<CircleInfoIcon size={14} /> Details
					</TabsTrigger>
					<TabsTrigger value="logs">
						<CodeIcon size={14} /> Logs
						{logCount !== null && logCount > 0 && (
							<Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px]">
								{logCount}
							</Badge>
						)}
					</TabsTrigger>
				</TabsList>

				<TabsContent value="details" className="mt-0 min-h-0 flex-1">
					<ScrollArea className="h-full">
						<div className="space-y-3 p-3">
							<div className="space-y-1">
								<h4 className="text-xs font-medium text-muted-foreground">Timing</h4>
								<div className="space-y-1 rounded-md border p-2 text-xs">
									<div className="flex justify-between">
										<span className="text-muted-foreground">Start Time</span>
										<span className="font-mono">
											<CopyableValue value={span.startTime}>
												{span.startTime}
											</CopyableValue>
										</span>
									</div>
									<div className="flex justify-between">
										<span className="text-muted-foreground">Duration</span>
										<span className="font-mono">
											<CopyableValue value={formatDuration(span.durationMs)}>
												{formatDuration(span.durationMs)}
											</CopyableValue>
										</span>
									</div>
								</div>
							</div>

							<div className="space-y-1">
								<h4 className="text-xs font-medium text-muted-foreground">Identifiers</h4>
								<div className="space-y-1 rounded-md border p-2 text-xs">
									<div className="flex justify-between gap-3">
										<span className="text-muted-foreground">Span ID</span>
										<span className="truncate font-mono">
											<CopyableValue value={span.spanId}>{span.spanId}</CopyableValue>
										</span>
									</div>
									<div className="flex justify-between gap-3">
										<span className="text-muted-foreground">Trace ID</span>
										<span className="truncate font-mono">
											<CopyableValue value={span.traceId}>{span.traceId}</CopyableValue>
										</span>
									</div>
									{span.parentSpanId && (
										<div className="flex justify-between gap-3">
											<span className="text-muted-foreground">Parent Span ID</span>
											<span className="truncate font-mono">
												<CopyableValue value={span.parentSpanId}>
													{span.parentSpanId}
												</CopyableValue>
											</span>
										</div>
									)}
								</div>
							</div>

							{span.isMissing ? (
								<AttributesTable
									attributes={span.spanAttributes ?? {}}
									title="Span Attributes"
									groupByNamespace
								/>
							) : detail.isPending ? (
								<div className="space-y-2">
									<Skeleton className="h-4 w-32" />
									<Skeleton className="h-24 w-full" />
									<Skeleton className="h-4 w-32" />
									<Skeleton className="h-24 w-full" />
								</div>
							) : (
								<>
									<AttributesTable
										attributes={detail.data?.spanAttributes ?? span.spanAttributes ?? {}}
										title="Span Attributes"
										groupByNamespace
									/>
									<ResourceAttributesSection
										attributes={
											detail.data?.resourceAttributes ?? span.resourceAttributes ?? {}
										}
										groupByNamespace
									/>
								</>
							)}
						</div>
					</ScrollArea>
				</TabsContent>

				<TabsContent value="logs" className="mt-0 min-h-0 flex-1">
					<ScrollArea className="h-full">
						<SpanLogs logs={logs.data ?? []} isPending={logs.isPending} isError={logs.isError} />
					</ScrollArea>
				</TabsContent>
			</Tabs>
		</aside>
	)
}

interface ErrorSectionProps {
	message: string
	serviceName: string
	spanName: string
	attributes?: Record<string, string>
}

function ErrorSection({ message, serviceName, spanName, attributes }: ErrorSectionProps) {
	const clipboard = useClipboard()
	const [expanded, setExpanded] = useState(false)
	const isLong = message.length > 120 || message.includes("\n")

	const handleCopyPrompt = () => {
		clipboard.copy(formatErrorPrompt({ message, serviceName, operation: spanName, attributes }))
		toast.success("Copied error prompt to clipboard")
	}

	return (
		<Alert variant="error" className="mx-3 my-2 rounded-md border-destructive/30">
			<CircleWarningIcon size={14} />
			<AlertTitle className="flex items-center justify-between">
				<span>Error</span>
				<Button
					variant="ghost"
					size="sm"
					className="h-5 px-1.5 text-[10px] text-destructive hover:bg-destructive/10 hover:text-destructive/80"
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
					<p className="font-mono text-[11px]">{message}</p>
				)}
			</AlertDescription>
		</Alert>
	)
}

function SpanLogs({
	logs,
	isPending,
	isError,
}: {
	logs: ReadonlyArray<LocalLog>
	isPending: boolean
	isError: boolean
}) {
	const [selectedLog, setSelectedLog] = useState<LocalLog | null>(null)
	const [sheetOpen, setSheetOpen] = useState(false)

	if (isPending) {
		return (
			<div className="space-y-2 p-2">
				{Array.from({ length: 3 }).map((_, i) => (
					<div key={i} className="space-y-1">
						<Skeleton className="h-3 w-24" />
						<Skeleton className="h-4 w-full" />
					</div>
				))}
			</div>
		)
	}

	if (isError) {
		return <div className="p-4 text-center text-sm text-destructive">Failed to load logs</div>
	}

	if (logs.length === 0) {
		return (
			<div className="p-4 text-center text-sm text-muted-foreground">No logs found for this span</div>
		)
	}

	return (
		<>
			<div className="divide-y">
				{logs.map((log, i) => (
					<button
						key={`${log.timestamp}-${i}`}
						type="button"
						className="flex w-full cursor-pointer flex-col gap-1 p-2 text-left last:border-b-0 hover:bg-muted/30"
						onClick={() => {
							setSelectedLog(log)
							setSheetOpen(true)
						}}
					>
						<div className="flex items-center gap-2 text-[10px] text-muted-foreground">
							<span className="font-mono">{log.timestamp}</span>
							<SeverityBadge severity={log.severityText} className="shrink-0" />
						</div>
						<p className="line-clamp-3 whitespace-pre-wrap break-all font-mono text-xs">
							{log.body}
						</p>
					</button>
				))}
			</div>
			<LogDetailSheet log={selectedLog} open={sheetOpen} onOpenChange={setSheetOpen} />
		</>
	)
}

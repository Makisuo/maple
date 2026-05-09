import { useState, useEffect, useMemo, useRef } from "react"
import { toast } from "sonner"
import {
	CircleInfoIcon,
	PulseIcon,
	SquareTerminalIcon,
	CopyIcon,
	MagnifierIcon,
	XmarkIcon,
} from "@/components/icons"
import { useClipboard } from "@maple/ui/hooks/use-clipboard"
import { Input } from "@maple/ui/components/ui/input"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Sheet, SheetContent, SheetTitle } from "@maple/ui/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@maple/ui/components/ui/tabs"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/utils"
import { getSeverityColor } from "@/lib/severity"
import type { Log, LogsResponse } from "@/api/tinybird/logs"
import type { SpanHierarchyResponse } from "@/api/tinybird/traces"
import { AttributesTable, ResourceAttributesSection } from "@/components/attributes"
import { listLogsResultAtom, getSpanHierarchyResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { LogHeroHeader } from "./log-hero-header"
import { LogMetaStrip } from "./log-meta-strip"
import { LogErrorBanner } from "./log-error-banner"

function formatRelativeMs(ms: number): string {
	if (ms < 1) return "+0ms"
	if (ms < 1000) return `+${Math.round(ms)}ms`
	if (ms < 10000) return `+${(ms / 1000).toFixed(1)}s`
	return `+${Math.round(ms / 1000)}s`
}

function isCurrentLog(log: Log, currentLog: Log): boolean {
	return (
		log.timestamp === currentLog.timestamp &&
		log.spanId === currentLog.spanId &&
		log.body === currentLog.body
	)
}

function TraceTimeline({ currentLog, onLogSelect }: { currentLog: Log; onLogSelect: (log: Log) => void }) {
	const logsResult = useAtomValue(
		currentLog.traceId
			? listLogsResultAtom({ data: { traceId: currentLog.traceId, limit: 200 } })
			: disabledResultAtom<LogsResponse>(),
	)
	const spansResult = useAtomValue(
		currentLog.traceId
			? getSpanHierarchyResultAtom({
					data: { traceId: currentLog.traceId, timestamp: currentLog.timestamp },
				})
			: disabledResultAtom<SpanHierarchyResponse>(),
	)
	const currentLogRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (currentLogRef.current) {
			currentLogRef.current.scrollIntoView({ block: "nearest" })
		}
	}, [currentLog])

	if (!currentLog.traceId) return null

	return (
		<div className="space-y-1.5">
			{Result.builder(logsResult)
				.onInitial(() => (
					<>
						<h4 className="text-xs font-medium text-muted-foreground">Trace Timeline</h4>
						<div className="rounded-md border overflow-hidden">
							{Array.from({ length: 5 }).map((_, i) => (
								<div
									key={i}
									className="flex items-center gap-2 px-2 py-1.5 border-b last:border-b-0"
								>
									<Skeleton className="h-3 w-10 shrink-0" />
									<Skeleton className="h-3 w-16 shrink-0" />
									<Skeleton className="h-3 flex-1" />
								</div>
							))}
						</div>
					</>
				))
				.onError(() => (
					<>
						<h4 className="text-xs font-medium text-muted-foreground">Trace Timeline</h4>
						<div className="p-3 text-center text-xs text-destructive">
							Failed to load trace logs
						</div>
					</>
				))
				.onSuccess((data) => {
					const logs = data.data.toSorted((a, b) => a.timestamp.localeCompare(b.timestamp))

					if (logs.length <= 1) {
						return (
							<>
								<h4 className="text-xs font-medium text-muted-foreground">Trace Timeline</h4>
								<div className="p-3 text-center text-xs text-muted-foreground">
									No other logs in this trace
								</div>
							</>
						)
					}

					const traceStart = new Date(logs[0].timestamp).getTime()

					const spanNameMap = new Map<string, string>()
					if (Result.isSuccess(spansResult)) {
						for (const span of spansResult.value.spans) {
							spanNameMap.set(span.spanId, span.spanName)
						}
					}

					return (
						<>
							<h4 className="text-xs font-medium text-muted-foreground">
								Trace Timeline
								<span className="ml-1 text-muted-foreground/60">{logs.length}</span>
							</h4>
							<div className="rounded-md border overflow-hidden">
								{logs.map((log, i) => {
									const isCurrent = isCurrentLog(log, currentLog)
									const relativeMs = new Date(log.timestamp).getTime() - traceStart
									const prevLog = i > 0 ? logs[i - 1] : null
									const spanChanged = prevLog && prevLog.spanId !== log.spanId && log.spanId

									return (
										<div key={`${log.timestamp}-${log.spanId}-${log.body.slice(0, 20)}`}>
											{spanChanged && (
												<div className="flex items-center gap-2 px-2 py-0.5 bg-muted/30">
													<div className="h-px flex-1 bg-border" />
													<span className="text-[9px] font-mono text-muted-foreground/60 shrink-0 truncate max-w-[200px]">
														{spanNameMap.get(log.spanId) ??
															log.spanId.slice(0, 8)}
													</span>
													<div className="h-px flex-1 bg-border" />
												</div>
											)}
											<div
												ref={isCurrent ? currentLogRef : undefined}
												style={{
													borderLeftColor: getSeverityColor(log.severityText),
												}}
												className={cn(
													"border-l-2 flex items-center gap-1.5 px-2 py-1 text-xs font-mono cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/50 transition-colors",
													isCurrent && "bg-primary/8",
												)}
												onClick={() => {
													if (!isCurrent) onLogSelect(log)
												}}
											>
												<span className="text-[10px] text-muted-foreground tabular-nums shrink-0 w-[52px] text-right">
													{formatRelativeMs(relativeMs)}
												</span>
												{log.serviceName !== currentLog.serviceName && (
													<span className="text-[10px] text-muted-foreground/60 truncate max-w-[72px] shrink-0">
														{log.serviceName}
													</span>
												)}
												<span
													className={cn(
														"min-w-0 flex-1 truncate text-[11px]",
														isCurrent ? "text-foreground" : "text-foreground/80",
													)}
												>
													{log.body}
												</span>
											</div>
										</div>
									)
								})}
							</div>
						</>
					)
				})
				.render()}
		</div>
	)
}

interface LogDetailSheetProps {
	log: Log | null
	open: boolean
	onOpenChange: (open: boolean) => void
}

export function LogDetailSheet({ log, open, onOpenChange }: LogDetailSheetProps) {
	const { effectiveTimezone } = useTimezonePreference()
	const [viewedLog, setViewedLog] = useState<Log | null>(log)
	const [attrSearch, setAttrSearch] = useState("")
	const clipboard = useClipboard()

	useEffect(() => {
		if (log) setViewedLog(log)
	}, [log])

	useEffect(() => {
		setAttrSearch("")
	}, [viewedLog])

	const jsonPayload = useMemo(() => {
		if (!viewedLog) return ""
		return JSON.stringify(
			{
				timestamp: viewedLog.timestamp,
				severityText: viewedLog.severityText,
				severityNumber: viewedLog.severityNumber,
				serviceName: viewedLog.serviceName,
				body: viewedLog.body,
				traceId: viewedLog.traceId || undefined,
				spanId: viewedLog.spanId || undefined,
				logAttributes: viewedLog.logAttributes,
				resourceAttributes: viewedLog.resourceAttributes,
			},
			null,
			2,
		)
	}, [viewedLog])

	if (!viewedLog) return null

	const sev = viewedLog.severityText.toUpperCase()
	const showErrorBanner = sev === "ERROR" || sev === "FATAL"
	const hasAttributes =
		Object.keys(viewedLog.logAttributes).length > 0 ||
		Object.keys(viewedLog.resourceAttributes).length > 0

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="p-0 sm:max-w-2xl" showCloseButton={false}>
				<SheetTitle className="sr-only">Log: {viewedLog.body.slice(0, 80)}</SheetTitle>

				<LogHeroHeader log={viewedLog} />

				<LogMetaStrip log={viewedLog} timeZone={effectiveTimezone} jsonPayload={jsonPayload} />

				{showErrorBanner && <LogErrorBanner log={viewedLog} />}

				<Tabs defaultValue="attributes" className="flex-1 flex flex-col min-h-0">
					<TabsList variant="line" className="shrink-0 px-4">
						<TabsTrigger value="attributes">
							<CircleInfoIcon size={14} /> Attributes
						</TabsTrigger>
						{viewedLog.traceId && (
							<TabsTrigger value="trace">
								<PulseIcon size={14} /> Trace
							</TabsTrigger>
						)}
						<TabsTrigger value="raw">
							<SquareTerminalIcon size={14} /> Raw
						</TabsTrigger>
					</TabsList>

					<TabsContent value="attributes" className="flex-1 min-h-0 mt-0">
						<ScrollArea className="h-full">
							<div className="p-3 space-y-3">
								{hasAttributes && (
									<div className="relative">
										<MagnifierIcon
											strokeWidth={2}
											className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none"
										/>
										<Input
											type="text"
											value={attrSearch}
											onChange={(e) => setAttrSearch(e.target.value)}
											placeholder="Search attributes..."
											className="h-7 pl-7 pr-7 text-xs"
										/>
										{attrSearch && (
											<button
												type="button"
												onClick={() => setAttrSearch("")}
												className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
											>
												<XmarkIcon strokeWidth={2} className="size-3" />
											</button>
										)}
									</div>
								)}

								<AttributesTable
									attributes={viewedLog.logAttributes}
									title="Log Attributes"
									searchQuery={attrSearch}
									groupByNamespace
								/>

								<ResourceAttributesSection
									attributes={viewedLog.resourceAttributes}
									searchQuery={attrSearch}
									groupByNamespace
								/>
							</div>
						</ScrollArea>
					</TabsContent>

					{viewedLog.traceId && (
						<TabsContent value="trace" className="flex-1 min-h-0 mt-0">
							<ScrollArea className="h-full">
								<div className="p-3">
									<TraceTimeline currentLog={viewedLog} onLogSelect={setViewedLog} />
								</div>
							</ScrollArea>
						</TabsContent>
					)}

					<TabsContent value="raw" className="flex-1 min-h-0 mt-0">
						<ScrollArea className="h-full">
							<div className="p-3">
								<div className="flex items-center justify-between mb-2">
									<span className="text-xs font-medium text-muted-foreground">
										JSON Payload
									</span>
									<button
										type="button"
										onClick={() => {
											clipboard.copy(jsonPayload)
											toast.success("Copied log as JSON")
										}}
										className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
									>
										<CopyIcon size={10} />
										Copy
									</button>
								</div>
								<pre className="rounded-md border bg-muted/30 p-2 font-mono text-[11px] whitespace-pre-wrap break-all">
									{jsonPayload}
								</pre>
							</div>
						</ScrollArea>
					</TabsContent>
				</Tabs>
			</SheetContent>
		</Sheet>
	)
}

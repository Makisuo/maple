import { useEffect, useRef } from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/utils"
import { getSeverityColor } from "@maple/ui/lib/severity"
import type { Log, LogsResponse } from "@/api/warehouse/logs"
import type { SpanHierarchyResponse } from "@/api/warehouse/traces"
import { listLogsResultAtom, getSpanHierarchyResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { computeTraceTimeWindow } from "@/lib/trace-time-window"
import { ServiceDot } from "@maple/ui/components/service-dot"

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

interface LogTraceTimelineProps {
	currentLog: Log
	onLogSelect: (log: Log) => void
}

/**
 * Timeline of every log in the current log's trace, with span boundaries.
 * Depends only on query atoms — usable in the drawer and on the standalone
 * `/logs/$logId` page alike.
 */
export function LogTraceTimeline({ currentLog, onLogSelect }: LogTraceTimelineProps) {
	// Bound the trace's logs to a window around this log so ClickHouse can prune
	// partitions (and so logs older than the default 24h window still resolve),
	// mirroring the span-hierarchy query below.
	const window = computeTraceTimeWindow(currentLog.timestamp)
	const logsResult = useAtomValue(
		currentLog.traceId
			? listLogsResultAtom({ data: { traceId: currentLog.traceId, limit: 200, ...window } })
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
													<span className="flex max-w-[72px] shrink-0 items-center gap-1 truncate text-[10px] text-muted-foreground/60">
														<ServiceDot serviceName={log.serviceName} className="size-1.5" />
														<span className="truncate">{log.serviceName}</span>
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

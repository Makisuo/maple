import { useState } from "react"
import { CircleInfoIcon, PulseIcon, ServerIcon, SquareTerminalIcon } from "@/components/icons"
import { Sheet, SheetContent, SheetTitle } from "@maple/ui/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@maple/ui/components/ui/tabs"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import type { Log } from "@/api/warehouse/logs"
import { getActiveInfraCorrelations } from "@/components/infra/infra-correlations"
import { InfraCorrelationPanel, infraCorrelationWindow } from "@/components/infra/infra-correlation-panel"
import { LogHeroHeader } from "./log-hero-header"
import { LogMetaStrip } from "./log-meta-strip"
import { LogErrorBanner } from "./log-error-banner"
import { LogTraceTimeline } from "./log-trace-timeline"
import { LogAttributesPanel } from "./log-attributes-panel"
import { LogRawPanel } from "./log-raw-panel"

interface LogDetailSheetProps {
	log: Log | null
	open: boolean
	onOpenChange: (open: boolean) => void
}

/**
 * Slide-out drawer for a single log. Composes the shared log panels
 * (`LogHeroHeader`, `LogMetaStrip`, `LogErrorBanner`, attributes / trace / raw)
 * into a tabbed layout. The same panels back the standalone `/logs/$logId`
 * page; only the chrome (drawer vs. full page) differs.
 */
export function LogDetailSheet({ log, open, onOpenChange }: LogDetailSheetProps) {
	// `viewedLog` may diverge from `log` when the user clicks through the trace
	// timeline. Sync it from the incoming prop during render (no effect).
	const [viewedLog, setViewedLog] = useState<Log | null>(log)
	const [syncedLog, setSyncedLog] = useState<Log | null>(log)
	if (log !== syncedLog) {
		setSyncedLog(log)
		if (log) setViewedLog(log)
	}

	if (!viewedLog) return null

	const sev = viewedLog.severityText.toUpperCase()
	const showErrorBanner = sev === "ERROR" || sev === "FATAL"
	// Identity used to remount panels (resets attribute search) on log change.
	const logKey = `${viewedLog.timestamp}-${viewedLog.spanId}-${viewedLog.body.slice(0, 24)}`
	const hasInfra = getActiveInfraCorrelations(viewedLog.resourceAttributes).length > 0

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="p-0 sm:max-w-2xl" showCloseButton={false}>
				<SheetTitle className="sr-only">Log: {viewedLog.body.slice(0, 80)}</SheetTitle>

				<LogHeroHeader log={viewedLog} />

				<LogMetaStrip log={viewedLog} />

				{showErrorBanner && <LogErrorBanner log={viewedLog} />}

				<Tabs defaultValue="attributes" className="flex-1 flex flex-col min-h-0">
					<TabsList variant="underline" className="shrink-0 px-4">
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
						{hasInfra && (
							<TabsTrigger value="infrastructure">
								<ServerIcon size={14} /> Infrastructure
							</TabsTrigger>
						)}
					</TabsList>

					<TabsContent value="attributes" className="flex-1 min-h-0 mt-0">
						<ScrollArea className="h-full">
							<div className="p-3">
								<LogAttributesPanel key={logKey} log={viewedLog} />
							</div>
						</ScrollArea>
					</TabsContent>

					{viewedLog.traceId && (
						<TabsContent value="trace" className="flex-1 min-h-0 mt-0">
							<ScrollArea className="h-full">
								<div className="p-3">
									<LogTraceTimeline currentLog={viewedLog} onLogSelect={setViewedLog} />
								</div>
							</ScrollArea>
						</TabsContent>
					)}

					<TabsContent value="raw" className="flex-1 min-h-0 mt-0">
						<ScrollArea className="h-full">
							<div className="p-3">
								<LogRawPanel log={viewedLog} />
							</div>
						</ScrollArea>
					</TabsContent>

					{hasInfra && (
						<TabsContent value="infrastructure" className="flex-1 min-h-0 mt-0">
							<ScrollArea className="h-full">
								<div className="p-3">
									<InfraCorrelationPanel
										key={logKey}
										resourceAttributes={viewedLog.resourceAttributes}
										{...infraCorrelationWindow(viewedLog.timestamp)}
									/>
								</div>
							</ScrollArea>
						</TabsContent>
					)}
				</Tabs>
			</SheetContent>
		</Sheet>
	)
}

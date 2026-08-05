import { useCallback, useMemo, useRef, useState } from "react"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import type { AgentTraceEventData, AgentTraceSummaryData } from "./agent-trace-model"
import { buildAgentTraceModel } from "./agent-trace-model"
import {
	AgentTraceIdentity,
	AgentTracePrivacyBanner,
	AgentTraceStatStrip,
	AgentTraceSystemPrompt,
	AgentTraceTimeBand,
} from "./agent-trace-header"
import { AgentTraceRail } from "./agent-trace-rail"
import { AgentTraceTimeline, type AgentTraceTimelineHandle } from "./agent-trace-timeline"

/**
 * The agent trace detail view: an overview header, a pinned system prompt, the
 * chronological timeline, and a context rail. Two live regions of state are
 * shared between the timeline and the rail — which rows are on screen (so the
 * agent trace map can shade the viewport) and which row the map last asked for —
 * so both live here rather than in either component.
 */
export function AgentTraceDetail({
	agentTraceId,
	summary,
	events,
	truncated,
	windowParam,
}: {
	agentTraceId: string
	summary: AgentTraceSummaryData | null
	events: ReadonlyArray<AgentTraceEventData>
	truncated: boolean
	windowParam: string | undefined
}) {
	const model = useMemo(() => buildAgentTraceModel(events, summary), [events, summary])
	const [visibleRowIds, setVisibleRowIds] = useState<ReadonlySet<string>>(() => new Set())

	const handleVisibleRows = useCallback((ids: ReadonlySet<string>) => setVisibleRowIds(ids), [])

	// Scrolling is the click's effect, so it happens in the handler — there is no
	// "selected row" for the page to hold, only a place to move the viewport to.
	// The timeline does the moving, because the row may first have to be revealed
	// out of a collapsed group or an active filter, and only it knows about those.
	const timelineRef = useRef<AgentTraceTimelineHandle | null>(null)
	const handleSelectRow = useCallback((rowId: string) => timelineRef.current?.revealRow(rowId), [])

	const isLive = summary?.status === "running"
	const traceId = events.find((event) => event.traceId.length > 0)?.traceId ?? null

	return (
		<>
			<DashboardLayout.Content>
				<DashboardLayout.Scroll>
					<div className="flex flex-col gap-6 pb-10">
						<AgentTraceIdentity
							agentTraceId={agentTraceId}
							summary={summary}
							model={model}
							traceId={traceId}
							windowParam={windowParam}
						/>
						<AgentTraceStatStrip summary={summary} model={model} />
						<AgentTraceTimeBand model={model} running={isLive} />

						{(model.allContentAbsent || model.contentInEvents) && (
							<AgentTracePrivacyBanner contentInEvents={model.contentInEvents} />
						)}

						<AgentTraceSystemPrompt
							event={model.systemPrompt}
							promptTokens={model.systemPrompt?.inputTokens ?? null}
						/>

						<AgentTraceTimeline
							ref={timelineRef}
							model={model}
							isLive={isLive}
							truncated={truncated}
							onVisibleRowsChange={handleVisibleRows}
						/>
					</div>
				</DashboardLayout.Scroll>
			</DashboardLayout.Content>

			<DashboardLayout.RightPanel title="AgentTrace" width="w-80">
				<AgentTraceRail
					model={model}
					summary={summary}
					visibleRowIds={visibleRowIds}
					onSelectRow={handleSelectRow}
				/>
			</DashboardLayout.RightPanel>
		</>
	)
}

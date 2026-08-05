import { useCallback, useMemo, useRef, useState } from "react"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import type { JourneyEventData, JourneySummaryData } from "./journey-model"
import { buildJourneyModel } from "./journey-model"
import {
	JourneyIdentity,
	JourneyPrivacyBanner,
	JourneyStatStrip,
	JourneySystemPrompt,
	JourneyTimeBand,
} from "./journey-header"
import { JourneyRail } from "./journey-rail"
import { JourneyTimeline, type JourneyTimelineHandle } from "./journey-timeline"

/**
 * The journey detail view: an overview header, a pinned system prompt, the
 * chronological timeline, and a context rail. Two live regions of state are
 * shared between the timeline and the rail — which rows are on screen (so the
 * journey map can shade the viewport) and which row the map last asked for —
 * so both live here rather than in either component.
 */
export function JourneyDetail({
	journeyId,
	summary,
	events,
	truncated,
	windowParam,
}: {
	journeyId: string
	summary: JourneySummaryData | null
	events: ReadonlyArray<JourneyEventData>
	truncated: boolean
	windowParam: string | undefined
}) {
	const model = useMemo(() => buildJourneyModel(events, summary), [events, summary])
	const [visibleRowIds, setVisibleRowIds] = useState<ReadonlySet<string>>(() => new Set())

	const handleVisibleRows = useCallback((ids: ReadonlySet<string>) => setVisibleRowIds(ids), [])

	// Scrolling is the click's effect, so it happens in the handler — there is no
	// "selected row" for the page to hold, only a place to move the viewport to.
	// The timeline does the moving, because the row may first have to be revealed
	// out of a collapsed group or an active filter, and only it knows about those.
	const timelineRef = useRef<JourneyTimelineHandle | null>(null)
	const handleSelectRow = useCallback((rowId: string) => timelineRef.current?.revealRow(rowId), [])

	const isLive = summary?.status === "running"
	const traceId = events.find((event) => event.traceId.length > 0)?.traceId ?? null

	return (
		<>
			<DashboardLayout.Content>
				<DashboardLayout.Scroll>
					<div className="flex flex-col gap-6 pb-10">
						<JourneyIdentity
							journeyId={journeyId}
							summary={summary}
							model={model}
							traceId={traceId}
							windowParam={windowParam}
						/>
						<JourneyStatStrip summary={summary} model={model} />
						<JourneyTimeBand model={model} running={isLive} />

						{(model.allContentAbsent || model.contentInEvents) && (
							<JourneyPrivacyBanner contentInEvents={model.contentInEvents} />
						)}

						<JourneySystemPrompt
							event={model.systemPrompt}
							promptTokens={model.systemPrompt?.inputTokens ?? null}
						/>

						<JourneyTimeline
							ref={timelineRef}
							model={model}
							isLive={isLive}
							truncated={truncated}
							onVisibleRowsChange={handleVisibleRows}
						/>
					</div>
				</DashboardLayout.Scroll>
			</DashboardLayout.Content>

			<DashboardLayout.RightPanel title="Journey" width="w-80">
				<JourneyRail
					model={model}
					summary={summary}
					visibleRowIds={visibleRowIds}
					onSelectRow={handleSelectRow}
				/>
			</DashboardLayout.RightPanel>
		</>
	)
}

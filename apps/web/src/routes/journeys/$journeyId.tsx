import { useCallback, useMemo } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { formatWarehouseDateTime, warehouseDateTimeToIso } from "@maple/query-engine"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import {
	getJourneySummaryResultAtom,
	getJourneyTimelineResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { JourneyDetail } from "@/components/journeys/detail/journey-detail"
import { JourneyDetailSkeleton } from "@/components/journeys/detail/journey-detail-skeleton"

// ---------------------------------------------------------------------------
// /journeys/$journeyId — one agent conversation, end to end.
//
// `t` is a partition-pruning hint (any warehouse timestamp inside the journey),
// set by the list row. It is deliberately optional: a journey id is the whole
// identity of this page, and a hand-built URL carrying only that id has to
// work. Absent, both queries fall back to a wide window — a journey clipped at
// the edge of a 7-day scan is a worse answer than nothing at all, but a
// required search param that 404s every deep link is worse than either.
// ---------------------------------------------------------------------------

const detailSearchSchema = Schema.Struct({
	t: Schema.optional(Schema.String),
})

/** 1h of slack each side of the hint absorbs clock skew and late-arriving spans. */
const WINDOW_MARGIN_MS = 60 * 60 * 1000
/** A journey is a conversation, not a session — 24h is a generous upper bound on one. */
const MAX_JOURNEY_MS = 24 * 60 * 60 * 1000

interface JourneyWindow {
	readonly windowStart: string
	readonly windowEnd: string
}

function journeyWindow(hint: string | undefined): JourneyWindow | undefined {
	if (!hint) return undefined
	const startMs = Date.parse(warehouseDateTimeToIso(hint))
	if (Number.isNaN(startMs)) return undefined
	return {
		windowStart: formatWarehouseDateTime(startMs - WINDOW_MARGIN_MS),
		windowEnd: formatWarehouseDateTime(startMs + MAX_JOURNEY_MS),
	}
}

export const Route = createFileRoute("/journeys/$journeyId")({
	component: JourneyDetailPage,
	validateSearch: Schema.toStandardSchemaV1(detailSearchSchema),
	loaderDeps: ({ search }) => ({ t: search.t }),
	loader: ({ context, params, deps }) => {
		const hint = typeof deps.t === "string" ? deps.t : undefined
		const data = { journeyId: params.journeyId, ...journeyWindow(hint) }
		context.effectRegistry.mount(getJourneySummaryResultAtom({ data }))
		context.effectRegistry.mount(getJourneyTimelineResultAtom({ data }))
	},
})

function JourneyDetailPage() {
	const { journeyId } = Route.useParams()
	const search = Route.useSearch()
	const hint = typeof search.t === "string" ? search.t : undefined

	// Recompute the same window the loader prefetched with, so every read keys
	// to the identical atom-family entry rather than kicking off a second fetch.
	const data = useMemo(() => ({ journeyId, ...journeyWindow(hint) }), [journeyId, hint])

	const summaryAtom = getJourneySummaryResultAtom({ data })
	const timelineAtom = getJourneyTimelineResultAtom({ data })
	const summaryResult = useAtomValue(summaryAtom)
	const timelineResult = useAtomValue(timelineAtom)
	const combined = Result.all([summaryResult, timelineResult])

	// A running journey is still being written. Both atom keys are stable (the id
	// plus a window derived from `t`, not from `now`), so refreshing them keeps
	// Success as Success with `waiting: true` — the page fills in rather than
	// flashing its skeleton, which is what the pulsing "Running" pill promises.
	const refreshSummary = useAtomRefresh(summaryAtom)
	const refreshTimeline = useAtomRefresh(timelineAtom)
	const refresh = useCallback(() => {
		refreshSummary()
		refreshTimeline()
	}, [refreshSummary, refreshTimeline])
	const isRunning = Result.isSuccess(summaryResult) && summaryResult.value.data?.status === "running"
	useIntervalRefresh(refresh, { intervalMs: 8_000, enabled: isRunning })

	const breadcrumbs = [{ label: "Agentic Journeys", href: "/journeys" }, { label: journeyId.slice(0, 12) }]

	return Result.builder(combined)
		.onInitial(() => (
			<Shell breadcrumbs={breadcrumbs} title="Loading journey…">
				<JourneyDetailSkeleton />
			</Shell>
		))
		.onError((error) => (
			<Shell breadcrumbs={breadcrumbs} title="Error">
				<QueryErrorState error={error} titleOverride="Failed to load journey" />
			</Shell>
		))
		.onSuccess(([summary, timeline]) => {
			// A journey with no spans in the window isn't an error — the id may be
			// real but older than the scan, which is a different sentence to "that
			// journey does not exist".
			if (timeline.events.length === 0 && summary.data == null) {
				return (
					<Shell
						breadcrumbs={breadcrumbs}
						title="Journey not found"
						description="No GenAI spans for this id in the searched window."
					>
						<div className="rounded-xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
							Nothing for journey <span className="font-mono">{journeyId}</span>. It may have
							fallen outside the default 7-day window — deep-link with a{" "}
							<span className="font-mono">?t=</span> timestamp inside the conversation to widen
							the scan.
						</div>
					</Shell>
				)
			}

			return (
				<DashboardLayout.Root>
					<DashboardLayout.Breadcrumbs items={breadcrumbs} />
					<DashboardLayout.Body>
						<JourneyDetail
							journeyId={journeyId}
							summary={summary.data}
							events={timeline.events}
							truncated={timeline.truncated}
							windowParam={hint}
						/>
					</DashboardLayout.Body>
				</DashboardLayout.Root>
			)
		})
		.render()
}

function Shell({
	breadcrumbs,
	title,
	description,
	children,
}: {
	breadcrumbs: Array<{ label: string; href?: string }>
	title: string
	description?: string
	children: React.ReactNode
}) {
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={breadcrumbs} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header title={title} description={description} />
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>{children}</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

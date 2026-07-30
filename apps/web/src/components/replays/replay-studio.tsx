import { ReplaySurface, ReplayTransport } from "@/components/replays/replay-player"
import { ReplayPlayerProvider } from "@/components/replays/replay-player-context"
import { ReplayEditorTimeline, type SessionTraceSummary } from "@/components/replays/replay-editor-timeline"
import { SessionRail, type EventRow } from "@/components/replays/session-events-panel"
import { recordedMarker, type ReplayPartitionWindow } from "@/components/replays/replay-format"
import { Reveal, SessionIdentityBar } from "@/components/replays/session-detail-parts"

// ---------------------------------------------------------------------------
// Replay studio
//
// The shared layout for the session-replay detail page, rendered by both the
// live route (`/replays/$sessionId`) and the placeholder-data preview
// (`/replays/preview`) so the two never drift.
//
// Player-first layout (lg+): a single-line identity bar on top, then the
// recording with its transport docked directly beneath (one unit) and the
// multi-track trace timeline below — all in a left column that scrolls
// internally. The right rail carries everything else as tabs: the event stream
// (Events), the correlated backend traces (Traces) and the session metadata
// (Session). The page itself never scrolls (`DashboardLayout.Fill`). Below lg
// the rail drops under the stage column and the left column's scroller owns
// the page.
// ---------------------------------------------------------------------------

/** The session metadata the studio renders. Structurally satisfied by both the
 *  warehouse `getReplayResult` row (branded + nullable columns) and the preview
 *  fixture (plain literals). */
interface ReplayStudioSession {
	readonly userId?: string | null
	readonly urlInitial: string
	readonly startTime: string
	readonly durationMs: number | null
	/** Engaged time (ms), computed server-side from session_events gaps. Omitted
	 *  on the preview fixture; null when the session has no distilled events. */
	readonly activeTimeMs?: number | null
	/** Idle time (ms) — the long-gap complement of active time. */
	readonly idleTimeMs?: number | null
	readonly clickCount: number
	readonly pageViews?: number | null
	readonly errorCount: number
	readonly browserName?: string | null
	readonly osName?: string | null
	readonly deviceType?: string | null
	readonly country?: string | null
	readonly serviceName?: string | null
	readonly userAgent?: string | null
	readonly status?: string
	/** JSON-encoded `session_replays.ResourceAttributes`; carries the SDK's
	 *  `maple.session.recorded` marker. Omitted on the preview fixture. */
	readonly resourceAttributes?: string | null
}

/** Placeholder-data bundle for the preview route — bypasses every warehouse fetch. */
interface ReplayStudioPreview {
	readonly rrwebEvents: ReadonlyArray<unknown>
	readonly traceSummaries: ReadonlyArray<SessionTraceSummary>
	readonly transcript: ReadonlyArray<EventRow>
}

export function ReplayStudio({
	sessionId,
	session,
	traceIds,
	preview,
	window,
}: {
	sessionId: string
	session: ReplayStudioSession
	traceIds: ReadonlyArray<string>
	preview?: ReplayStudioPreview
	/** Partition-pruning window threaded into the detail atoms (matches the
	 *  route prefetch key). Omitted on the preview route, which bypasses fetches. */
	window?: ReplayPartitionWindow
}) {
	const isActive = session.status === "active"
	const label = session.userId || "Anonymous session"
	const recorded = recordedMarker(session.resourceAttributes)

	return (
		<ReplayPlayerProvider
			sessionId={sessionId}
			previewEvents={preview?.rrwebEvents}
			window={window}
			recorded={recorded}
			sessionActive={isActive}
		>
			<div className="flex min-h-0 flex-1 flex-col lg:flex-row">
				{/* Stage column — identity, player + docked transport, timeline. Owns
				    the scrolling so the rail can stay a fixed-height sibling. */}
				<div className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4">
					<Reveal>
						<SessionIdentityBar
							sessionId={sessionId}
							label={label}
							urlInitial={session.urlInitial}
							startTime={session.startTime}
							isActive={isActive}
							durationMs={session.durationMs}
							errorCount={session.errorCount}
						/>
					</Reveal>

					<div className="flex flex-col">
						<ReplaySurface url={session.urlInitial} detachedTransport docked />
						<ReplayTransport docked />
					</div>

					<Reveal delay={0.08}>
						<ReplayEditorTimeline
							traceIds={traceIds}
							previewSummaries={preview?.traceSummaries}
							window={window}
						/>
					</Reveal>
				</div>

				{/* Right rail: Events / Traces / Session tabs. Fixed width beside the
				    stage on lg+, stacked with a height cap below. */}
				<SessionRail
					sessionId={sessionId}
					session={{ ...session, recorded }}
					traceIds={traceIds}
					previewEvents={preview?.transcript}
					previewSummaries={preview?.traceSummaries}
					window={window}
					className="shrink-0 border-t max-lg:h-96 lg:w-84 lg:border-t-0 lg:border-l"
				/>
			</div>
		</ReplayPlayerProvider>
	)
}

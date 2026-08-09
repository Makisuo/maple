import { ReplaySurface, ReplayTransport } from "@/components/replays/replay-player"
import { ReplayPlayerProvider } from "@/components/replays/replay-player-context"
import { ReplayEditorTimeline } from "@/components/replays/replay-editor-timeline"
import { SessionRail } from "@/components/replays/session-events-panel"
import { recordedMarker, type ReplayPartitionWindow } from "@/components/replays/replay-format"
import { Reveal, SessionIdentityBar } from "@/components/replays/session-detail-parts"

// ---------------------------------------------------------------------------
// Replay studio
//
// The shared layout for the session-replay detail page.
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

/** The session metadata the studio renders from the warehouse `getReplayResult` row. */
interface ReplayStudioSession {
	readonly userId?: string | null
	readonly urlInitial: string
	readonly startTime: string
	readonly durationMs: number | null
	/** Engaged time (ms), computed server-side from session_events gaps. */
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
	 *  `maple.session.recorded` marker. */
	readonly resourceAttributes?: string | null
	// Analytics dimensions, passed straight through to the rail's Session tab.
	// All optional because pre-migration-0011 sessions have none.
	readonly visitorId?: string | null
	readonly visitorIsNew?: boolean
	readonly groupName?: string | null
	readonly userEmail?: string | null
	readonly entryPath?: string | null
	readonly exitPath?: string | null
	readonly referrerHost?: string | null
	readonly utmSource?: string | null
	readonly utmMedium?: string | null
	readonly utmCampaign?: string | null
}

export function ReplayStudio({
	sessionId,
	session,
	traceIds,
	window,
}: {
	sessionId: string
	session: ReplayStudioSession
	traceIds: ReadonlyArray<string>
	/** Partition-pruning window threaded into the detail atoms; matches the route prefetch key. */
	window?: ReplayPartitionWindow
}) {
	const isActive = session.status === "active"
	const label = session.userId || "Anonymous session"
	const recorded = recordedMarker(session.resourceAttributes)

	return (
		<ReplayPlayerProvider
			sessionId={sessionId}
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
						<ReplayEditorTimeline traceIds={traceIds} window={window} />
					</Reveal>
				</div>

				{/* Right rail: Events / Traces / Session tabs. Fixed width beside the
				    stage on lg+, stacked with a height cap below. */}
				<SessionRail
					sessionId={sessionId}
					session={{ ...session, recorded }}
					traceIds={traceIds}
					window={window}
					className="shrink-0 border-t max-lg:h-96 lg:w-84 lg:border-t-0 lg:border-l"
				/>
			</div>
		</ReplayPlayerProvider>
	)
}

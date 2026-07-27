import type { ReactNode } from "react"
import { cn } from "@maple/ui/utils"
import { ReplaySurface, ReplayTransport } from "@/components/replays/replay-player"
import { ReplayPlayerProvider } from "@/components/replays/replay-player-context"
import { ReplayEditorTimeline, type SessionTraceSummary } from "@/components/replays/replay-editor-timeline"
import { SessionEventsPanel, type EventRow } from "@/components/replays/session-events-panel"
import {
	formatDuration,
	recordedMarker,
	type ReplayPartitionWindow,
} from "@/components/replays/replay-format"
import { CopyButton, Reveal, SessionIdentityHeader } from "@/components/replays/session-detail-parts"

// ---------------------------------------------------------------------------
// Replay studio
//
// The shared layout for the session-replay detail page, rendered by both the
// live route (`/replays/$sessionId`) and the placeholder-data preview
// (`/replays/preview`) so the two never drift.
//
// Studio layout (lg+): the player is a full-width stage on top. The dock below
// it starts at the trace timeline (left) with the Console / Network / Errors
// stream docked to its right. All session metadata (summary stats + browser /
// device / country / service) lives in the header, so the dock stays focused
// on the timeline and the event stream. Below lg everything stacks and the
// page scrolls.
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

	return (
		<div className="flex flex-col gap-4">
			<Reveal>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
						<div className="min-w-0 flex-1">
							<SessionIdentityHeader
								sessionId={sessionId}
								label={label}
								urlInitial={session.urlInitial}
								startTime={session.startTime}
								isActive={isActive}
							/>
						</div>
						<StatStrip session={session} />
					</div>
					<SessionMetaLine session={session} />
				</div>
			</Reveal>

			<ReplayPlayerProvider
				sessionId={sessionId}
				previewEvents={preview?.rrwebEvents}
				window={window}
				recorded={recordedMarker(session.resourceAttributes)}
				sessionActive={isActive}
			>
				{/* Browser chrome + video next to the event stream. The transport is
				    detached (rendered below) so the events panel matches the height of
				    the video block exactly — no dead space. */}
				<div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,64rem)_minmax(20rem,1fr)] lg:items-stretch">
					<div className="min-w-0">
						<ReplaySurface url={session.urlInitial} detachedTransport />
					</div>
					{/* Absolute-fill inside a relative cell: a long event list never
					    inflates the grid row, so the row height stays driven by the video
					    block and the panel scrolls internally instead. */}
					<div className="relative min-w-0">
						<SessionEventsPanel
							sessionId={sessionId}
							previewEvents={preview?.transcript}
							window={window}
							className="h-[clamp(20rem,60vh,28rem)] lg:absolute lg:inset-0 lg:h-auto"
						/>
					</div>
				</div>

				{/* Transport (scrubber + speed + legend) — full width below the video. */}
				<ReplayTransport />

				{/* Trace timeline — full width below. */}
				<Reveal delay={0.08}>
					<ReplayEditorTimeline
						traceIds={traceIds}
						previewSummaries={preview?.traceSummaries}
						window={window}
					/>
				</Reveal>
			</ReplayPlayerProvider>
		</div>
	)
}

/** Unified vitals strip for the header — Duration / Active / Idle / Clicks /
 *  Pages / Errors, divided into one cohesive cluster. Active + Idle split the
 *  wall-clock duration into engaged vs idle time (shown only when the warehouse
 *  supplied them). Only an error count > 0 takes colour. */
function StatStrip({ session }: { session: ReplayStudioSession }) {
	const items = [
		{ label: "Duration", value: formatDuration(session.durationMs) },
		// `activeTimeMs === undefined` only on the preview fixture; a real session
		// with no distilled events sends `null`, which renders as "—".
		...(session.activeTimeMs !== undefined
			? [{ label: "Active", value: formatDuration(session.activeTimeMs) }]
			: []),
		...(session.idleTimeMs !== undefined
			? [{ label: "Idle", value: formatDuration(session.idleTimeMs) }]
			: []),
		{ label: "Clicks", value: String(session.clickCount) },
		{ label: "Pages", value: String(session.pageViews || 1) },
		{ label: "Errors", value: String(session.errorCount), error: session.errorCount > 0 },
	]
	return (
		<dl className="flex shrink-0 items-stretch">
			{items.map((it) => (
				<div
					key={it.label}
					className="flex flex-col items-center border-l border-border/60 px-4 leading-tight first:border-l-0 first:pl-0 last:pr-0"
				>
					<dd
						className={cn(
							"font-display text-xl font-semibold tabular-nums",
							it.error ? "text-destructive" : "text-foreground",
						)}
					>
						{it.value}
					</dd>
					<dt
						className={cn(
							"text-[10px] font-medium uppercase tracking-wider",
							it.error ? "text-destructive/80" : "text-muted-foreground",
						)}
					>
						{it.label}
					</dt>
				</div>
			))}
		</dl>
	)
}

/** Compact one-line session details under the header (browser / device / country / service). */
function SessionMetaLine({ session }: { session: ReplayStudioSession }) {
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border/60 pt-3 text-xs text-muted-foreground">
			<MetaItem label="Browser">
				<span className="text-foreground">{session.browserName || "—"}</span>
				{session.osName ? ` · ${session.osName}` : ""}
			</MetaItem>
			<MetaItem label="Device">
				<span className="capitalize text-foreground">{session.deviceType || "—"}</span>
			</MetaItem>
			<MetaItem label="Country">
				<span className="text-foreground">{session.country || "—"}</span>
			</MetaItem>
			<MetaItem label="Service">
				<span className="inline-flex items-center gap-1">
					<span className="font-mono text-foreground">{session.serviceName || "—"}</span>
					{session.serviceName && (
						<CopyButton value={session.serviceName} label="Copy service name" />
					)}
				</span>
			</MetaItem>
		</div>
	)
}

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="inline-flex items-center gap-1.5">
			<span className="text-[10px] font-medium uppercase tracking-wider opacity-60">{label}</span>
			{children}
		</div>
	)
}

import * as React from "react"
import { Link } from "@tanstack/react-router"
import { cn } from "@maple/ui/lib/utils"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	getSessionTranscriptResultAtom,
	getSessionTraceSummariesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { parseAttributes } from "@maple/ui/lib/span-tree"
import { DetailRail } from "@maple/ui/components/detail-rail"
import { ExternalLinkIcon } from "@/components/icons"
import { formatClock, formatSessionDuration, type ReplayPartitionWindow } from "./replay-format"
import { useReplayPlayer } from "./replay-player-context"
import { parseChTimestampMs } from "./replay-timeline"
import type { SessionTraceSummary } from "./replay-editor-timeline"

export type EventRow = {
	readonly timestamp: string
	readonly type: string
	readonly url: string
	readonly traceId: string | null
	readonly level: string
	readonly message: string
	readonly targetSelector: string
	readonly targetText: string
	readonly netMethod: string
	readonly netUrl: string
	readonly netStatus: number
	readonly netDurationMs: number
	readonly errorStack: string
	/** `track()` props on a `custom` event, JSON-encoded. Absent on fixtures. */
	readonly attributes?: string
}

/** The session metadata rendered by the rail's Session tab. */
export interface SessionRailSession {
	readonly durationMs: number | null
	readonly activeTimeMs?: number | null
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
	/** From `recordedMarker()`: true/false when the SDK stamped the session, undefined when unknown. */
	readonly recorded?: boolean
	// Analytics dimensions. Optional because sessions written before migration 0011 have none.
	/** Persistent per-browser id — the same value on this visitor's other sessions,
	 *  including anonymous ones on the marketing site. */
	readonly visitorId?: string | null
	readonly visitorIsNew?: boolean
	readonly groupName?: string | null
	readonly userEmail?: string | null
	/** Entry pathname; the session's first page rather than its latest URL. */
	readonly entryPath?: string | null
	readonly exitPath?: string | null
	/** Gateway-normalized. `""` means direct *or* suppressed by Referrer-Policy. */
	readonly referrerHost?: string | null
	readonly utmSource?: string | null
	readonly utmMedium?: string | null
	readonly utmCampaign?: string | null
}

type RailTab = "events" | "traces" | "session"
type EventFilter = "all" | "custom" | "console" | "network" | "error"

const EVENT_FILTERS: ReadonlyArray<{ id: EventFilter; label: string }> = [
	{ id: "all", label: "All" },
	// Product events from `track()`. First after All because they are the ones
	// someone reading a session for *behaviour* is looking for.
	{ id: "custom", label: "Product" },
	{ id: "console", label: "Console" },
	{ id: "network", label: "Network" },
	{ id: "error", label: "Errors" },
]

/**
 * The detail page's right rail: a tabbed panel over the distilled
 * `session_events` stream (Events), the correlated backend traces (Traces) and
 * the session metadata (Session). Event and trace rows seek the player to their
 * moment; rows with a trace id link through to the backend trace.
 */
export function SessionRail({
	sessionId,
	session,
	traceIds,
	window,
	className,
}: {
	sessionId: string
	session: SessionRailSession
	traceIds: ReadonlyArray<string>
	/** Partition-pruning window; must match the route prefetch key (see $sessionId.tsx). */
	window?: ReplayPartitionWindow
	className?: string
}) {
	const [tab, setTab] = React.useState<RailTab>("events")

	return (
		<section className={cn("flex min-h-0 flex-col overflow-hidden border-border bg-card", className)}>
			<div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
				<RailTabButton active={tab === "events"} onClick={() => setTab("events")}>
					Events
				</RailTabButton>
				<RailTabButton
					active={tab === "traces"}
					onClick={() => setTab("traces")}
					count={traceIds.length}
				>
					Traces
				</RailTabButton>
				<RailTabButton active={tab === "session"} onClick={() => setTab("session")}>
					Session
				</RailTabButton>
			</div>

			{tab === "events" && <EventsTab sessionId={sessionId} window={window} />}
			{tab === "traces" && <TracesTab traceIds={traceIds} window={window} />}
			{tab === "session" && <SessionTab sessionId={sessionId} session={session} />}
		</section>
	)
}

function RailTabButton({
	active,
	onClick,
	count,
	children,
}: {
	active: boolean
	onClick: () => void
	count?: number | null
	children: React.ReactNode
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={cn(
				"flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
				active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
			{count != null && (
				<span className="font-mono text-[10px] tabular-nums text-muted-foreground">{count}</span>
			)}
		</button>
	)
}

/** Seek the player to a warehouse event timestamp. */
function useSeekToTimestamp() {
	const { timeline, recordingStartEpochMs, realTotalMs, seekDisplay } = useReplayPlayer()
	return React.useCallback(
		(ts: string) => {
			const epoch = parseChTimestampMs(ts)
			if (Number.isNaN(epoch)) return
			const realOffset = Math.max(0, Math.min(epoch - recordingStartEpochMs, realTotalMs))
			seekDisplay(timeline.toDisplay(realOffset))
		},
		[recordingStartEpochMs, realTotalMs, seekDisplay, timeline],
	)
}

/** Clock offset of a warehouse timestamp within the recording ("04:12"), for row gutters. */
function useClockAt() {
	const { recordingStartEpochMs, realTotalMs, timeline } = useReplayPlayer()
	return React.useCallback(
		(ts: string) => {
			const epoch = parseChTimestampMs(ts)
			if (Number.isNaN(epoch)) return "—"
			const realOffset = Math.max(0, Math.min(epoch - recordingStartEpochMs, realTotalMs))
			return formatClock(timeline.toDisplay(realOffset))
		},
		[recordingStartEpochMs, realTotalMs, timeline],
	)
}

// --- Events tab -------------------------------------------------------------

function EventsTab({ sessionId, window }: { sessionId: string; window?: ReplayPartitionWindow }) {
	const result = useAtomValue(getSessionTranscriptResultAtom({ data: { sessionId, ...window } }))
	const [filter, setFilter] = React.useState<EventFilter>("all")

	const renderBody = (events: ReadonlyArray<EventRow>) => {
		const counts = {
			all: events.length,
			custom: events.filter((e) => e.type === "custom").length,
			console: events.filter((e) => e.type === "console").length,
			network: events.filter((e) => e.type === "network").length,
			error: events.filter((e) => e.type === "error").length,
		}
		const rows = filter === "all" ? events : events.filter((e) => e.type === filter)
		return (
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<div className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-card px-3 py-2">
					{EVENT_FILTERS.map((f) => (
						<button
							key={f.id}
							type="button"
							onClick={() => setFilter(f.id)}
							aria-pressed={filter === f.id}
							className={cn(
								"rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors",
								filter === f.id
									? "bg-foreground text-background"
									: f.id === "error" && counts.error > 0
										? "border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15"
										: "border border-border text-muted-foreground hover:text-foreground",
							)}
						>
							{f.label}{" "}
							<span className="font-mono tabular-nums opacity-70">{counts[f.id]}</span>
						</button>
					))}
				</div>
				{rows.length === 0 ? (
					<div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
						No {filter === "all" ? "" : `${filter === "custom" ? "product" : filter} `}events in
						this session.
					</div>
				) : (
					<ul className="divide-y divide-border font-mono text-xs">
						{rows.map((ev, i) => (
							<EventLine key={i} ev={ev} showNetworkBar={filter === "network"} />
						))}
					</ul>
				)}
			</div>
		)
	}

	return Result.builder(result)
		.onInitial(() => <Skeleton className="m-3 min-h-0 flex-1 rounded-lg" />)
		.onError(() => (
			<div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
				Couldn't load session events.
			</div>
		))
		.onSuccess((data) => renderBody(data.data as ReadonlyArray<EventRow>))
		.orElse(() => <Skeleton className="m-3 min-h-0 flex-1 rounded-lg" />)
}

function statusTone(status: number): string {
	if (status >= 500 || status === 0) return "text-destructive"
	if (status >= 400) return "text-warning-foreground"
	return "text-success-foreground"
}

/** Uppercase type tag + tone for the row gutter, per event kind. */
function eventTag(ev: EventRow): { label: string; tone: string } {
	switch (ev.type) {
		case "nav":
			return { label: "NAV", tone: "text-success-foreground" }
		case "click":
			return { label: "CLICK", tone: "text-warning-foreground" }
		case "network":
			return {
				label: ev.netMethod || "NET",
				tone: isFailedRequest(ev) ? "text-destructive" : "text-info-foreground",
			}
		case "error":
			return { label: "ERROR", tone: "text-destructive" }
		case "custom":
			// Not "CUSTOM": in the transcript these read as product events, and the
			// gutter is only wide enough for a short word.
			return { label: "EVENT", tone: "text-primary" }
		case "console": {
			const level = (ev.level || "log").toUpperCase()
			if (ev.level === "error") return { label: level, tone: "text-destructive" }
			if (ev.level === "warn") return { label: level, tone: "text-warning-foreground" }
			return { label: level, tone: "text-muted-foreground" }
		}
		default:
			return { label: ev.type.toUpperCase(), tone: "text-muted-foreground" }
	}
}

/**
 * A custom event's `track()` props. The column is a JSON-encoded
 * `Map(String, String)`; anything unparseable is skipped rather than rendered as
 * a raw blob — the event name above already carries the meaning.
 */
function EventProps({ attributes }: { attributes?: string }) {
	const entries = React.useMemo(() => {
		if (!attributes) return []
		try {
			const parsed: unknown = JSON.parse(attributes)
			if (!parsed || typeof parsed !== "object") return []
			return Object.entries(parsed as Record<string, unknown>).map(
				([key, value]) => [key, String(value)] as const,
			)
		} catch {
			return []
		}
	}, [attributes])

	if (entries.length === 0) return null
	return (
		<span className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
			{entries.map(([key, value]) => (
				<span key={key}>
					{key}=<span className="text-foreground/80">{value}</span>
				</span>
			))}
		</span>
	)
}

function isFailedRequest(ev: EventRow): boolean {
	return ev.type === "network" && (ev.netStatus >= 500 || ev.netStatus === 0)
}

function EventLine({ ev, showNetworkBar }: { ev: EventRow; showNetworkBar: boolean }) {
	const seekTo = useSeekToTimestamp()
	const clockAt = useClockAt()
	const tag = eventTag(ev)
	const isError = ev.type === "error" || isFailedRequest(ev)

	return (
		<li
			className={cn(
				"relative flex items-start gap-2.5 px-3 py-2 hover:bg-muted/50",
				isError && "bg-destructive/5",
			)}
		>
			{isError && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-destructive" />}
			<button
				type="button"
				onClick={() => seekTo(ev.timestamp)}
				className="w-10 shrink-0 text-left tabular-nums text-muted-foreground hover:text-foreground"
				title="Seek replay to this moment"
			>
				{clockAt(ev.timestamp)}
			</button>
			<span className={cn("w-11 shrink-0 text-[10px] font-semibold leading-4", tag.tone)}>
				{tag.label}
			</span>
			<div className="min-w-0 flex-1">
				{ev.type === "console" && (
					<span className={cn(ev.level === "error" && "text-destructive")}>{ev.message}</span>
				)}
				{ev.type === "network" && (
					<span className="flex flex-col gap-1">
						<span className="flex items-center gap-2">
							<span className="min-w-0 truncate">{ev.netUrl}</span>
							<span className={cn("ml-auto shrink-0 font-semibold", statusTone(ev.netStatus))}>
								{ev.netStatus || "ERR"}
							</span>
							<span
								className={cn(
									"shrink-0",
									isError ? "font-semibold text-destructive" : "opacity-60",
								)}
							>
								{formatNetDuration(ev.netDurationMs)}
							</span>
						</span>
						{showNetworkBar && <NetDurationBar durationMs={ev.netDurationMs} failed={isError} />}
					</span>
				)}
				{ev.type === "error" && (
					<span className="text-destructive">
						{ev.message}
						{ev.errorStack && (
							<span className="mt-0.5 block whitespace-pre-wrap text-[11px] text-muted-foreground">
								{ev.errorStack.split("\n").slice(0, 3).join("\n")}
							</span>
						)}
					</span>
				)}
				{ev.type === "click" && <span>{ev.targetText || ev.targetSelector || "click"}</span>}
				{ev.type === "nav" && <span>{ev.url}</span>}
				{ev.type === "custom" && (
					<span className="flex flex-col gap-0.5">
						<span className="text-foreground">{ev.message}</span>
						<EventProps attributes={ev.attributes} />
					</span>
				)}
				{ev.type !== "console" &&
					ev.type !== "network" &&
					ev.type !== "error" &&
					ev.type !== "click" &&
					ev.type !== "custom" &&
					ev.type !== "nav" && <span>{ev.message || ev.url}</span>}
			</div>
			{ev.traceId && (
				<Link
					to="/traces/$traceId"
					params={{ traceId: ev.traceId }}
					// Carry the event timestamp so the span-hierarchy query narrows the
					// ClickHouse partition scan instead of reading the full retention.
					search={{ t: ev.timestamp }}
					className="shrink-0 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
					title="Open backend trace"
				>
					trace
				</Link>
			)}
		</li>
	)
}

const NET_BAR_MAX_MS = 3000

function formatNetDuration(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
	return `${ms}ms`
}

/** Relative-duration micro-bar for the Network view — slow requests jump out
 *  without reading every number. Log-free linear scale capped at 3s. */
function NetDurationBar({ durationMs, failed }: { durationMs: number; failed: boolean }) {
	const pct = Math.min(100, Math.max(2, (durationMs / NET_BAR_MAX_MS) * 100))
	const slow = durationMs >= 1000
	return (
		<span className="block h-[3px] w-full overflow-hidden rounded-full bg-muted">
			<span
				className={cn(
					"block h-full rounded-full",
					failed ? "bg-destructive" : slow ? "bg-warning" : "bg-chart-1",
				)}
				style={{ width: `${pct}%` }}
			/>
		</span>
	)
}

// --- Traces tab -------------------------------------------------------------

function TracesTab({
	traceIds,
	window,
}: {
	traceIds: ReadonlyArray<string>
	window?: ReplayPartitionWindow
}) {
	if (traceIds.length === 0) {
		return (
			<p className="p-4 text-xs leading-relaxed text-muted-foreground">
				No backend traces were linked to this session. Correlation populates automatically when the
				page is instrumented with <span className="font-mono">@maple-dev/browser</span> tracing.
			</p>
		)
	}
	return <TracesTabLive traceIds={traceIds} window={window} />
}

function TracesTabLive({
	traceIds,
	window,
}: {
	traceIds: ReadonlyArray<string>
	window?: ReplayPartitionWindow
}) {
	const result = useAtomValue(getSessionTraceSummariesResultAtom({ data: { traceIds, ...window } }))
	return Result.builder(result)
		.onInitial(() => (
			<div className="space-y-2 p-4">
				<Skeleton className="h-4 w-2/3" />
				<Skeleton className="h-4 w-1/2" />
			</div>
		))
		.onError(() => <p className="p-4 text-xs text-destructive">Couldn't load correlated traces.</p>)
		.onSuccess((res) => {
			const summaries: ReadonlyArray<SessionTraceSummary> = res.data
			if (summaries.length === 0) {
				return (
					<p className="p-4 text-xs text-muted-foreground">
						Linked traces aren't available yet — they may still be ingesting.
					</p>
				)
			}
			return <TraceList summaries={summaries} />
		})
		.render()
}

function TraceList({ summaries }: { summaries: ReadonlyArray<SessionTraceSummary> }) {
	return (
		<ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
			{summaries.map((s) => (
				<TraceListRow key={s.traceId} summary={s} />
			))}
		</ul>
	)
}

function TraceListRow({ summary }: { summary: SessionTraceSummary }) {
	const seekTo = useSeekToTimestamp()
	const clockAt = useClockAt()
	const isError = summary.hasError > 0
	return (
		<li
			className={cn(
				"relative flex flex-col gap-0.5 px-3 py-2.5 hover:bg-muted/50",
				isError && "bg-destructive/5",
			)}
		>
			{isError && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-destructive" />}
			<div className="flex items-center gap-2.5">
				<button
					type="button"
					onClick={() => seekTo(summary.startTime)}
					className="w-10 shrink-0 text-left font-mono text-xs tabular-nums text-muted-foreground hover:text-foreground"
					title="Seek replay to this trace"
				>
					{clockAt(summary.startTime)}
				</button>
				{/* Same method-chip + route-path label the timeline and trace views use,
				    so a trace reads identically everywhere. */}
				<HttpSpanLabel
					spanName={summary.rootSpanName || "trace"}
					spanAttributes={parseAttributes(summary.rootSpanAttributes)}
					spanKind={summary.rootSpanKind}
					className="min-w-0 flex-1"
					textClassName={cn(
						"truncate text-xs font-medium",
						isError ? "text-destructive" : "text-foreground",
					)}
				/>
				<span
					className={cn(
						"shrink-0 font-mono text-[11px] tabular-nums",
						isError ? "font-semibold text-destructive" : "text-muted-foreground",
					)}
				>
					{formatNetDuration(Math.round(summary.durationMs))}
				</span>
			</div>
			<div className="flex items-center gap-2 pl-[3.125rem]">
				<span className="min-w-0 truncate text-[11px] text-muted-foreground">
					{summary.rootServiceName} · {summary.spanCount} span{summary.spanCount === 1 ? "" : "s"}
					{isError ? " · error" : ""}
				</span>
				<Link
					to="/traces/$traceId"
					params={{ traceId: summary.traceId }}
					search={{ t: summary.startTime }}
					target="_blank"
					rel="noreferrer"
					className="inline-flex shrink-0 items-center gap-1 text-[11px] text-info-foreground underline-offset-2 hover:underline"
				>
					open
					<ExternalLinkIcon className="size-3" />
				</Link>
			</div>
		</li>
	)
}

// --- Session tab ------------------------------------------------------------

function SessionTab({ sessionId, session }: { sessionId: string; session: SessionRailSession }) {
	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<DetailRail.Group label="Session">
				<DetailRail.Row label="Duration">
					<Value mono>{formatSessionDuration(session.durationMs)}</Value>
				</DetailRail.Row>
				{session.activeTimeMs !== undefined && (
					<DetailRail.Row label="Active">
						<Value mono>{formatSessionDuration(session.activeTimeMs)}</Value>
					</DetailRail.Row>
				)}
				{session.idleTimeMs !== undefined && (
					<DetailRail.Row label="Idle">
						<Value mono>{formatSessionDuration(session.idleTimeMs)}</Value>
					</DetailRail.Row>
				)}
				<DetailRail.Row label="Pages">
					<Value mono>{String(session.pageViews || 1)}</Value>
				</DetailRail.Row>
				<DetailRail.Row label="Clicks">
					<Value mono>{String(session.clickCount)}</Value>
				</DetailRail.Row>
				<DetailRail.Row label="Errors">
					<span
						className={cn(
							"font-mono text-xs tabular-nums",
							session.errorCount > 0 ? "font-semibold text-destructive" : "text-foreground",
						)}
					>
						{session.errorCount}
					</span>
				</DetailRail.Row>
			</DetailRail.Group>

			{session.visitorId ? (
				<DetailRail.Group label="Visitor">
					<DetailRail.Row label="Visitor ID" title={session.visitorId}>
						{/* The link is the point of this group: one visitor id spans this
						    person's anonymous marketing sessions and their signed-in ones,
						    so this is how you walk from a signup back to the campaign. */}
						<Link
							to="/replays"
							search={{ visitorId: session.visitorId }}
							className="truncate font-mono text-xs text-primary underline-offset-2 hover:underline"
							title="All sessions from this visitor"
						>
							{session.visitorId.slice(0, 12)}…
						</Link>
					</DetailRail.Row>
					<DetailRail.Row label="Visitor">
						<Value mono>{session.visitorIsNew ? "New" : "Returning"}</Value>
					</DetailRail.Row>
					{session.groupName && (
						<DetailRail.Row label="Group">
							<Value mono className="truncate">
								{session.groupName}
							</Value>
						</DetailRail.Row>
					)}
					{session.userEmail && (
						<DetailRail.Row label="Email" title={session.userEmail}>
							<Value mono className="truncate">
								{session.userEmail}
							</Value>
						</DetailRail.Row>
					)}
				</DetailRail.Group>
			) : null}

			{session.entryPath || session.referrerHost || session.utmSource ? (
				<DetailRail.Group label="Acquisition">
					{session.entryPath && (
						<DetailRail.Row label="Entry" title={session.entryPath}>
							<Value mono className="truncate">
								{session.entryPath}
							</Value>
						</DetailRail.Row>
					)}
					{session.exitPath && (
						<DetailRail.Row label="Exit" title={session.exitPath}>
							<Value mono className="truncate">
								{session.exitPath}
							</Value>
						</DetailRail.Row>
					)}
					<DetailRail.Row label="Referrer">
						{/* '' is direct *or* a referrer the browser suppressed — "Direct"
						    would assert more than the column knows. */}
						<Value mono className="truncate">
							{session.referrerHost || "None"}
						</Value>
					</DetailRail.Row>
					{session.utmSource && (
						<DetailRail.Row label="Source">
							<Value mono className="truncate">
								{[session.utmSource, session.utmMedium].filter(Boolean).join(" / ")}
							</Value>
						</DetailRail.Row>
					)}
					{session.utmCampaign && (
						<DetailRail.Row label="Campaign" title={session.utmCampaign}>
							<Value mono className="truncate">
								{session.utmCampaign}
							</Value>
						</DetailRail.Row>
					)}
				</DetailRail.Group>
			) : null}

			<DetailRail.Group label="Environment">
				<DetailRail.Row label="Browser">
					<Value mono>{session.browserName || "—"}</Value>
				</DetailRail.Row>
				<DetailRail.Row label="OS">
					<Value mono>{session.osName || "—"}</Value>
				</DetailRail.Row>
				<DetailRail.Row label="Device">
					<Value mono className="capitalize">
						{session.deviceType || "—"}
					</Value>
				</DetailRail.Row>
				<DetailRail.Row label="Country">
					<Value mono>{session.country || "—"}</Value>
				</DetailRail.Row>
			</DetailRail.Group>

			<DetailRail.Group label="Context">
				{session.serviceName && (
					<DetailRail.Row label="Service">
						<span className="flex min-w-0 items-center gap-1">
							<Value mono className="truncate">
								{session.serviceName}
							</Value>
							<CopyButton
								value={session.serviceName}
								label="Service name"
								iconSize={12}
								className="size-5"
								toast={false}
							/>
						</span>
					</DetailRail.Row>
				)}
				<DetailRail.Row label="Session ID" title={sessionId}>
					<span className="flex min-w-0 items-center gap-1">
						<Value mono className="truncate">
							{sessionId.slice(0, 12)}…
						</Value>
						<CopyButton
							value={sessionId}
							label="Session ID"
							iconSize={12}
							className="size-5"
							toast={false}
						/>
					</span>
				</DetailRail.Row>
				{session.recorded !== undefined && (
					<DetailRail.Row label="Recording">
						<span
							className={cn(
								"font-mono text-xs",
								session.recorded ? "text-success-foreground" : "text-muted-foreground",
							)}
						>
							{session.recorded ? "Complete" : "Not recorded"}
						</span>
					</DetailRail.Row>
				)}
				{session.userAgent && (
					<div className="flex flex-col gap-1 pt-1">
						<span className="text-xs text-muted-foreground">User agent</span>
						<span className="break-words font-mono text-[10px] leading-[15px] text-foreground/80">
							{session.userAgent}
						</span>
					</div>
				)}
			</DetailRail.Group>
		</div>
	)
}

function Value({
	mono,
	className,
	children,
}: {
	mono?: boolean
	className?: string
	children: React.ReactNode
}) {
	return (
		<span className={cn("text-xs text-foreground", mono && "font-mono tabular-nums", className)}>
			{children}
		</span>
	)
}

import { useCallback } from "react"
import { Link } from "@tanstack/react-router"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { formatRelativeTimeOrDate, toEpochMs } from "@maple/ui/lib/time-format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { SquareSparkleIcon } from "@/components/icons"
import { vendorIcon } from "@/lib/agent-sessions/vendor-icon"
import { sessionRowId } from "@/lib/agent-sessions/session-window"
import { vendorLabel } from "@/lib/agent-sessions/vendor-label"

/** The wire row from `listAiSessions` — one AI agent session, newest first. */
export interface AgentSessionRow {
	readonly sessionId: string
	readonly vendorId: string
	readonly vendorVersion: string
	readonly traceCount: number
	readonly spanCount: number
	readonly errorSpanCount: number
	readonly serviceNames: ReadonlyArray<string>
	readonly startTime: string
	readonly endTime: string
	readonly durationMs: number
}

function absoluteTs(startTime: string): string {
	const parsed = toEpochMs(startTime)
	return Number.isNaN(parsed) ? startTime : new Date(parsed).toLocaleString()
}

interface AgentSessionsListProps {
	sessions: ReadonlyArray<AgentSessionRow>
	/** Fetch the next page — invoked when the bottom sentinel scrolls into view. */
	onReachEnd?: () => void
	/** Whether more pages remain (renders the sentinel + footer). */
	hasMore?: boolean
	/** Whether a next page is currently in flight. */
	loadingMore?: boolean
	/** The client retention guard stopped pagination before the backend ended. */
	isCapped?: boolean
}

function observeReachEnd(element: HTMLDivElement, onReachEnd: () => void): () => void {
	const observer = new IntersectionObserver(
		(entries) => {
			if (entries[0]?.isIntersecting) onReachEnd()
		},
		{ rootMargin: "400px 0px" },
	)
	observer.observe(element)
	return () => observer.disconnect()
}

function SessionsSentinel({
	onReachEnd,
	loadingMore,
}: Pick<AgentSessionsListProps, "onReachEnd" | "loadingMore">) {
	const elementRef = useCallback(
		(element: HTMLDivElement | null) => {
			if (!element) return
			return observeReachEnd(element, () => {
				if (!loadingMore) onReachEnd?.()
			})
		},
		[loadingMore, onReachEnd],
	)

	return <div ref={elementRef} aria-hidden className="h-px w-full" />
}

export function AgentSessionsList({
	sessions,
	onReachEnd,
	hasMore = false,
	loadingMore = false,
	isCapped = false,
}: AgentSessionsListProps) {
	if (sessions.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<SquareSparkleIcon />
					</EmptyMedia>
					<EmptyTitle>No agent sessions yet</EmptyTitle>
					<EmptyDescription>
						Trace your AI agents with a supported framework, or emit OpenTelemetry{" "}
						<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">gen_ai</code>{" "}
						spans, and their sessions will show up here. A framework that groups its turns with a{" "}
						<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">
							maple_ai.session.id
						</code>{" "}
						attribute gets one session across every trace; anything else gets one per trace.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		)
	}

	return (
		<div className="@container">
			{sessions.map((session) => {
				const hasErrors = session.errorSpanCount > 0
				const VendorIcon = vendorIcon(session.vendorId)
				const vendor = vendorLabel(session.vendorId)
				const secondary =
					session.vendorVersion && session.vendorVersion !== "0"
						? `${vendor} · v${session.vendorVersion}`
						: vendor
				return (
					<Link
						key={session.sessionId}
						to="/agent-sessions/$sessionId"
						params={{ sessionId: session.sessionId }}
						// The session's own bounds, not this page's time range: the list
						// query aggregates each qualifying trace in full, so the detail
						// page can read straight from these.
						search={{ t: session.startTime, end: session.endTime }}
						className="relative flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @2xl:gap-4"
					>
						{/* Errored sessions get a left accent so they can be picked out
						    while scanning — same signal as the replays list. */}
						{hasErrors && (
							<span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-destructive" />
						)}

						{/* Identity lane: session id, framework underneath */}
						<div className="min-w-0 flex-1 overflow-hidden">
							<div className="flex items-center gap-2">
								<span
									className="min-w-0 truncate font-mono text-sm font-medium"
									title={session.sessionId}
								>
									{sessionRowId(session.sessionId)}
								</span>
								{/* On phones the right-hand lanes are gone, so the timestamp
								    anchors the top-right corner of the stacked row. */}
								<span
									className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground @2xl:hidden"
									title={absoluteTs(session.startTime)}
								>
									{formatRelativeTimeOrDate(session.startTime)}
								</span>
							</div>
							<div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
								<VendorIcon size={13} className="shrink-0" aria-hidden />
								<span className="truncate">{secondary}</span>
							</div>
							{hasErrors && (
								<div className="mt-1.5 flex items-center gap-1.5 @2xl:hidden">
									<ErrorChip count={session.errorSpanCount} />
								</div>
							)}
						</div>

						{/* Services lane */}
						<div className="hidden w-[11rem] shrink-0 overflow-hidden @2xl:block">
							<span
								className="block truncate text-xs text-muted-foreground"
								title={session.serviceNames.join(", ")}
							>
								{session.serviceNames.join(" · ")}
							</span>
						</div>

						{/* Activity lane: duration + traces/spans */}
						<div className="hidden w-[13.5rem] shrink-0 items-baseline gap-2 overflow-hidden whitespace-nowrap @3xl:flex">
							<span className="font-mono text-[13px] font-semibold tabular-nums">
								{formatSessionDuration(session.durationMs)}
							</span>
							<span className="truncate text-xs text-muted-foreground">
								{session.traceCount} trace{session.traceCount === 1 ? "" : "s"} ·{" "}
								{session.spanCount} span{session.spanCount === 1 ? "" : "s"}
							</span>
						</div>

						{/* Signal lane: error chip */}
						<div className="hidden w-[8.75rem] shrink-0 items-center gap-1.5 overflow-hidden @2xl:flex">
							{hasErrors && <ErrorChip count={session.errorSpanCount} />}
						</div>

						{/* Time lane */}
						<div className="hidden shrink-0 items-center @2xl:flex">
							<span
								className="whitespace-nowrap text-xs text-muted-foreground"
								title={absoluteTs(session.startTime)}
							>
								{formatRelativeTimeOrDate(session.startTime)}
							</span>
						</div>
					</Link>
				)
			})}

			{hasMore && <SessionsSentinel onReachEnd={onReachEnd} loadingMore={loadingMore} />}

			{isCapped && (
				<p className="py-3 text-sm text-muted-foreground">
					Showing the {sessions.length.toLocaleString()} most recent sessions — narrow the time
					range to see older ones
				</p>
			)}

			{loadingMore && (
				<div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
					<span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
					Loading more sessions…
				</div>
			)}
		</div>
	)
}

function ErrorChip({ count }: { count: number }) {
	return (
		<span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums text-destructive">
			<span className="size-1 rounded-full bg-destructive" aria-hidden />
			{count} error{count === 1 ? "" : "s"}
		</span>
	)
}

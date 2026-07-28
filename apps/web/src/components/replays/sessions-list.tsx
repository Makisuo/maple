import { formatRelativeTimeOrDate, toEpochMs } from "@maple/ui/time-format"
import { useCallback, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@maple/ui/utils"
import { EyeIcon } from "@/components/icons"
import { browserIconFor, deviceIconFor } from "./session-icons"
import { formatSessionDuration, gradientFor, hostFromUrl } from "./replay-format"

export interface SessionRow {
	readonly sessionId: string
	readonly startTime: string
	readonly durationMs: number | null
	readonly status: string
	readonly userId: string | null
	readonly urlInitial: string
	readonly browserName: string
	readonly osName: string
	readonly deviceType: string
	readonly country: string
	readonly serviceName: string
	readonly pageViews: number
	readonly clickCount: number
	readonly errorCount: number
	readonly traceCount: number
	/** `"false"` when the SDK recorded no rrweb chunks for this session. `""` on
	 *  sessions written before the marker existed — unknown, so no badge. */
	readonly recorded: string
}

function absoluteTs(startTime: string): string {
	const parsed = toEpochMs(startTime)
	return Number.isNaN(parsed) ? startTime : new Date(parsed).toLocaleString()
}

function identity(session: SessionRow): { label: string; initial: string; gradient: string } {
	const label = session.userId || "Anonymous"
	return {
		label,
		initial: (label[0] ?? "?").toUpperCase(),
		gradient: gradientFor(session.sessionId),
	}
}

interface SessionsListProps {
	sessions: ReadonlyArray<SessionRow>
	/** Fetch the next page — invoked when the bottom sentinel scrolls into view. */
	onReachEnd?: () => void
	/** Whether more pages remain (renders the sentinel + footer). */
	hasMore?: boolean
	/** Whether a next page is currently in flight. */
	loadingMore?: boolean
	/** The client retention guard stopped pagination before the backend ended. */
	isCapped?: boolean
	/** p95 session duration (ms) from the facets query — sessions above it get a
	 *  "long" chip beside their duration. No chip when unavailable. */
	durationP95?: number
}

function SessionsSentinel({
	onReachEnd,
	loadingMore,
}: Pick<SessionsListProps, "onReachEnd" | "loadingMore">) {
	const elementRef = useCallback(
		(element: HTMLDivElement | null) => {
			if (!element) return
			const observer = new IntersectionObserver(
				(entries) => {
					if (entries[0]?.isIntersecting && !loadingMore) onReachEnd?.()
				},
				{ rootMargin: "400px 0px" },
			)
			// React Doctor does not yet recognize React 19 callback-ref cleanup.
			// oxlint-disable-next-line react-doctor/effect-needs-cleanup
			observer.observe(element)
			return () => observer.disconnect()
		},
		[loadingMore, onReachEnd],
	)

	return <div ref={elementRef} aria-hidden className="h-px w-full" />
}

export function SessionsList({
	sessions,
	onReachEnd,
	hasMore = false,
	loadingMore = false,
	isCapped = false,
	durationP95,
}: SessionsListProps) {
	const navigate = useNavigate()
	const [listElement, setListElement] = useState<HTMLDivElement | null>(null)
	const scrollElement = listElement?.closest<HTMLDivElement>('[data-slot="page-scroll-area"]') ?? null
	const virtualizer = useVirtualizer({
		count: sessions.length,
		getScrollElement: () => scrollElement,
		estimateSize: () => 65,
		overscan: 8,
		scrollMargin: listElement?.offsetTop ?? 0,
	})
	const virtualItems = virtualizer.getVirtualItems()

	if (sessions.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-20 text-center">
				<div className="mb-4 grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
					<EyeIcon className="size-6" />
				</div>
				<p className="text-sm font-medium">No sessions recorded yet</p>
				<p className="mt-1.5 max-w-md text-sm text-muted-foreground">
					Install{" "}
					<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">
						@maple-dev/browser
					</code>{" "}
					and call{" "}
					<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">
						MapleBrowser.init()
					</code>{" "}
					to start capturing what your users see.
				</p>
			</div>
		)
	}

	return (
		<div className="@container">
			<div
				ref={setListElement}
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualItems.map((virtualRow) => {
					const session = sessions[virtualRow.index]!
					const id = identity(session)
					const isActive = session.status === "active"
					const isUnrecorded = session.recorded === "false"
					const hasErrors = session.errorCount > 0
					const BrowserIcon = browserIconFor(session.browserName)
					const DeviceIcon = deviceIconFor(session.deviceType)
					return (
						<div
							key={session.sessionId}
							data-index={virtualRow.index}
							ref={virtualizer.measureElement}
							className="absolute top-0 left-0 w-full"
							style={{
								transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
							}}
						>
							<button
								type="button"
								onClick={() =>
									navigate({
										to: "/replays/$sessionId",
										params: { sessionId: session.sessionId },
										search: { t: session.startTime },
									})
								}
								className="group relative flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @2xl:gap-4"
							>
								{/* Errored sessions get a left accent so they can be picked out
								    while scanning — the strongest "watch this one first" signal. */}
								{hasErrors && (
									<span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-destructive" />
								)}

								<div
									className={cn(
										"grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold",
										isUnrecorded
											? "bg-muted text-muted-foreground"
											: `bg-gradient-to-br ${id.gradient} text-white shadow-sm`,
									)}
								>
									{id.initial}
								</div>

								{/* Identity lane */}
								<div className="min-w-0 flex-1 overflow-hidden">
									<div className="flex items-center gap-2">
										<span
											className={cn(
												"min-w-0 truncate text-sm font-medium",
												isUnrecorded && "text-muted-foreground",
											)}
										>
											{id.label}
										</span>
										{isActive && <LivePill />}
										{/* On phones the right-hand lanes are gone, so the timestamp
										    anchors the top-right corner of the stacked row. */}
										<span
											className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground @2xl:hidden"
											title={absoluteTs(session.startTime)}
										>
											{formatRelativeTimeOrDate(session.startTime)}
										</span>
									</div>
									<div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
										{session.sessionId.slice(0, 8)} · {hostFromUrl(session.urlInitial)}
									</div>
									{(session.traceCount > 0 || hasErrors || isUnrecorded) && (
										<div className="mt-1.5 flex items-center gap-1.5 @2xl:hidden">
											<SessionBadges session={session} />
										</div>
									)}
								</div>

								{/* Context lane: browser + device icons (details on hover) + country */}
								<div className="hidden w-[6.5rem] shrink-0 items-center gap-2.5 @2xl:flex">
									<span
										className="shrink-0"
										title={`${session.browserName || "Unknown"}${session.osName ? ` · ${session.osName}` : ""}`}
									>
										<BrowserIcon className="size-4" />
									</span>
									<span
										className="shrink-0 text-muted-foreground"
										title={session.deviceType || "desktop"}
									>
										<DeviceIcon className="size-4 opacity-70" />
									</span>
									{session.country && (
										<span className="truncate text-xs text-muted-foreground">
											{session.country}
										</span>
									)}
								</div>

								{/* Activity lane: duration (flagged when unusually long) + pages/clicks */}
								<div className="hidden w-[13.5rem] shrink-0 items-baseline gap-2 overflow-hidden whitespace-nowrap @3xl:flex">
									<span className="font-mono text-[13px] font-semibold tabular-nums">
										{formatSessionDuration(session.durationMs)}
									</span>
									{durationP95 != null &&
										durationP95 > 0 &&
										session.durationMs != null &&
										session.durationMs > durationP95 && (
											<span
												className="shrink-0 self-center rounded-full bg-accent px-1.5 py-px text-[10px] font-medium text-accent-foreground"
												title={`Longer than 95% of sessions in this view (p95: ${formatSessionDuration(durationP95)})`}
											>
												long
											</span>
										)}
									<span className="truncate text-xs text-muted-foreground">
										{session.pageViews || 1} page{(session.pageViews || 1) === 1 ? "" : "s"} ·{" "}
										{session.clickCount} click{session.clickCount === 1 ? "" : "s"}
									</span>
								</div>

								{/* Signal lane: error / trace / transcript-only chips */}
								<div className="hidden w-[8.75rem] shrink-0 items-center gap-1.5 overflow-hidden @2xl:flex">
									<SessionBadges session={session} />
								</div>

								{/* Time lane */}
								<div className="hidden shrink-0 items-center gap-2 @2xl:flex">
									<span
										className="whitespace-nowrap text-xs text-muted-foreground"
										title={absoluteTs(session.startTime)}
									>
										{formatRelativeTimeOrDate(session.startTime)}
									</span>
									<span
										className={cn(
											"grid size-6 place-items-center rounded-full border border-border text-foreground transition-opacity",
											isUnrecorded
												? "opacity-30"
												: "opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100",
										)}
									>
										<PlayGlyph />
									</span>
								</div>
							</button>
						</div>
					)
				})}
			</div>

			{hasMore && <SessionsSentinel onReachEnd={onReachEnd} loadingMore={loadingMore} />}

			{isCapped && (
				<p className="py-3 text-sm text-muted-foreground">
					Showing first {sessions.length.toLocaleString()} sessions — narrow filters to continue
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

function SessionBadges({ session }: { session: SessionRow }) {
	return (
		<>
			{session.errorCount > 0 && (
				<span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums text-destructive">
					<span className="size-1 rounded-full bg-destructive" aria-hidden />
					{session.errorCount} error{session.errorCount === 1 ? "" : "s"}
				</span>
			)}
			{session.traceCount > 0 && (
				<span className="inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums text-muted-foreground">
					{session.traceCount} trace{session.traceCount === 1 ? "" : "s"}
				</span>
			)}
			{/* Metadata-only session — no rrweb chunks were ever written, so the
			    detail page has no player. Flag it here rather than let the row look
			    like every other (playable) session. */}
			{session.recorded === "false" && (
				<span className="inline-flex shrink-0 items-center rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
					Transcript only
				</span>
			)}
		</>
	)
}

function LivePill() {
	return (
		<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-1.5 py-px text-[10px] font-medium tracking-wide text-success">
			<span className="relative flex size-1.5" aria-hidden>
				<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
				<span className="relative inline-flex size-1.5 rounded-full bg-success" />
			</span>
			LIVE
		</span>
	)
}

function PlayGlyph() {
	return (
		<svg viewBox="0 0 24 24" className="size-3 translate-x-px fill-current" aria-hidden>
			<path d="M8 5v14l11-7z" />
		</svg>
	)
}

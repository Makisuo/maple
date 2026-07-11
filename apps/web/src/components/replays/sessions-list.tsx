import { useEffect, useRef } from "react"
import { useNavigate } from "@tanstack/react-router"
import {
	GlobeIcon,
	ComputerIcon,
	MobileIcon,
	ClockIcon,
	PulseIcon,
	CircleWarningIcon,
	EyeIcon,
} from "@/components/icons"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { formatDuration, gradientFor, hostFromUrl } from "./replay-format"

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
}

function parseTs(startTime: string): number {
	return Date.parse(normalizeTimestampInput(startTime))
}

function formatRelative(startTime: string): string {
	const parsed = parseTs(startTime)
	if (Number.isNaN(parsed)) return startTime
	const s = Math.round((Date.now() - parsed) / 1000)
	if (s < 60) return "just now"
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ago`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h ago`
	const d = Math.floor(h / 24)
	return d < 7 ? `${d}d ago` : new Date(parsed).toLocaleDateString()
}

function absoluteTs(startTime: string): string {
	const parsed = parseTs(startTime)
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

function isMobileDevice(deviceType: string): boolean {
	const d = deviceType.toLowerCase()
	return d === "mobile" || d === "tablet" || d === "phone"
}

interface SessionsListProps {
	sessions: ReadonlyArray<SessionRow>
	/** Fetch the next page — invoked when the bottom sentinel scrolls into view. */
	onReachEnd?: () => void
	/** Whether more pages remain (renders the sentinel + footer). */
	hasMore?: boolean
	/** Whether a next page is currently in flight. */
	loadingMore?: boolean
}

export function SessionsList({ sessions, onReachEnd, hasMore = false, loadingMore = false }: SessionsListProps) {
	const navigate = useNavigate()

	// Auto-load the next page when the bottom sentinel nears the viewport. Guards
	// live in refs so the observer is created once yet always reads fresh values;
	// appending a full page pushes the sentinel out of view and re-arms it.
	const sentinelRef = useRef<HTMLDivElement | null>(null)
	const onReachEndRef = useRef(onReachEnd)
	onReachEndRef.current = onReachEnd
	const canLoadRef = useRef(false)
	canLoadRef.current = hasMore && !loadingMore

	useEffect(() => {
		const el = sentinelRef.current
		if (!el) return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting && canLoadRef.current) {
					onReachEndRef.current?.()
				}
			},
			{ rootMargin: "400px 0px" },
		)
		observer.observe(el)
		return () => observer.disconnect()
	}, [])

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
		<div className="@container space-y-2">
			{sessions.map((session) => {
				const id = identity(session)
				const isActive = session.status === "active"
				const DeviceIcon = isMobileDevice(session.deviceType) ? MobileIcon : ComputerIcon
				return (
					<button
						type="button"
						key={session.sessionId}
						onClick={() =>
							navigate({
								to: "/replays/$sessionId",
								params: { sessionId: session.sessionId },
								search: { t: session.startTime },
							})
						}
						className="group flex w-full items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 text-left transition-all hover:-translate-y-px hover:border-primary/40 hover:bg-accent/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @2xl:gap-4 @2xl:px-4"
					>
						<div
							className={`grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br ${id.gradient} text-sm font-semibold text-white shadow-sm @2xl:size-10`}
						>
							{id.initial}
						</div>

						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<span className="min-w-0 truncate text-sm font-medium @2xl:max-w-[16rem]">
									{id.label}
								</span>
								<StatusDot active={isActive} />
								<span className="hidden shrink-0 font-mono text-xs text-muted-foreground @2xl:inline">
									{session.sessionId.slice(0, 8)} · {formatDuration(session.durationMs)}
								</span>
								{/* On phones the right-hand columns are gone, so the timestamp
								    anchors the top-right corner of the stacked row. */}
								<span
									className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground @2xl:hidden"
									title={absoluteTs(session.startTime)}
								>
									{formatRelative(session.startTime)}
								</span>
							</div>
							<div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
								<span className="shrink-0 font-mono @2xl:hidden">
									{session.sessionId.slice(0, 8)} · {formatDuration(session.durationMs)}
								</span>
								<span className="flex min-w-0 items-center gap-1.5">
									<GlobeIcon className="size-3.5 shrink-0 opacity-60" />
									<span className="min-w-0 truncate @2xl:max-w-[18rem]">
										{hostFromUrl(session.urlInitial)}
									</span>
								</span>
								<span className="hidden items-center gap-1.5 @2xl:flex">
									<DeviceIcon className="size-3.5 shrink-0 opacity-60" />
									<span className="truncate">
										{session.browserName || "Unknown"}
										{session.osName ? ` · ${session.osName}` : ""}
									</span>
								</span>
								{session.country && (
									<span className="hidden truncate @3xl:inline">{session.country}</span>
								)}
							</div>
							{(session.traceCount > 0 || session.errorCount > 0) && (
								<div className="mt-1.5 flex items-center gap-2 @2xl:hidden">
									<SessionBadges session={session} />
								</div>
							)}
						</div>

						<div className="hidden shrink-0 items-center gap-2.5 text-xs text-muted-foreground @2xl:flex">
							{/* Click/page-view counts are low-signal — drop them on phones and
							    keep the load-bearing trace/error badges. */}
							<span className="flex items-center gap-2.5">
								<Stat
									icon={<PulseIcon className="size-3.5" />}
									value={session.clickCount}
									title="clicks"
								/>
								<Stat
									icon={<EyeIcon className="size-3.5" />}
									value={session.pageViews || 1}
									title="page views"
								/>
							</span>
							<SessionBadges session={session} />
						</div>

						<div className="hidden shrink-0 items-center gap-3 @2xl:flex">
							<span
								className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground"
								title={absoluteTs(session.startTime)}
							>
								<ClockIcon className="size-3.5 opacity-60" />
								{formatRelative(session.startTime)}
							</span>
							{/* Tap affordance: hover-revealed on desktop. Phones skip it —
							    the whole card is the tap target and the stacked row needs
							    every horizontal pixel. */}
							<span className="grid size-7 place-items-center rounded-full bg-primary/10 text-primary opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100">
								<PlayGlyph />
							</span>
						</div>
					</button>
				)
			})}

			{hasMore && <div ref={sentinelRef} aria-hidden className="h-px w-full" />}

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
			{session.traceCount > 0 && (
				<span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium tabular-nums text-primary">
					{session.traceCount} trace{session.traceCount === 1 ? "" : "s"}
				</span>
			)}
			{session.errorCount > 0 && (
				<span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-xs font-medium tabular-nums text-destructive">
					<CircleWarningIcon className="size-3" />
					{session.errorCount}
				</span>
			)}
		</>
	)
}

function StatusDot({ active }: { active: boolean }) {
	if (!active) return <span className="size-1.5 rounded-full bg-muted-foreground/40" title="ended" />
	return (
		<span className="relative flex size-1.5" title="active">
			<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
			<span className="relative inline-flex size-1.5 rounded-full bg-success" />
		</span>
	)
}

function Stat({ icon, value, title }: { icon: React.ReactNode; value: number; title: string }) {
	return (
		<span className="inline-flex items-center gap-1 tabular-nums" title={title}>
			<span className="opacity-60">{icon}</span>
			{value}
		</span>
	)
}

function PlayGlyph() {
	return (
		<svg viewBox="0 0 24 24" className="size-3.5 translate-x-px fill-current" aria-hidden>
			<path d="M8 5v14l11-7z" />
		</svg>
	)
}

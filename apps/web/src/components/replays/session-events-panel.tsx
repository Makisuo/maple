import * as React from "react"
import * as Predicate from "effect/Predicate"
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
import { Popover, PopoverContent, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import {
	CircleInfoIcon,
	ExternalLinkIcon,
	PixelBracketsCurlyIcon,
	PixelCrosshairsIcon,
	PixelNodesIcon,
	PixelSparkleIcon,
	PixelTriangleWarningIcon,
	PixelWindowIcon,
	type IconComponent,
} from "@/components/icons"
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

/**
 * The kind filters, as glyphs.
 *
 * They were word chips, which wrapped to two rows in the rail and read as a
 * second menu under the tab bar — same pill shape, same altitude, twice the
 * height. The rows already speak in glyphs and the legend keys them, so the
 * filters can borrow that vocabulary and fit on one line. Every id here is a
 * key of {@link EVENT_KIND_VISUALS}; `all` is the only one carrying a word,
 * because "no filter" has no glyph.
 *
 * Product events from `track()` come first: they are what someone reading a
 * session for *behaviour* is looking for.
 */
const KIND_FILTERS = ["custom", "console", "network", "error"] as const satisfies ReadonlyArray<
	Exclude<EventFilter, "all">
>

/** Long-form names for the filter's tooltip and the empty state. */
const FILTER_LABELS = {
	all: "All events",
	custom: "Product events",
	console: "Console messages",
	network: "Network requests",
	error: "Errors",
} satisfies Record<EventFilter, string>

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

function EventsTab({ sessionId, window }: { sessionId: string; window?: ReplayPartitionWindow }) {
	const result = useAtomValue(getSessionTranscriptResultAtom({ data: { sessionId, ...window } }))
	const [filter, setFilter] = React.useState<EventFilter>("all")
	// Row indexes are filter-relative, so a filter change has to close whatever
	// was open rather than carry the index onto a different row.
	const [openIndex, setOpenIndex] = React.useState<number | null>(null)

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
				<EventFilterBar
					counts={counts}
					filter={filter}
					onChange={(next) => {
						setFilter(next)
						setOpenIndex(null)
					}}
				/>
				{rows.length === 0 ? (
					<div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
						{/* The filters are glyphs now, so the empty state is where the
						    chosen one gets named. */}
						No {FILTER_LABELS[filter].toLowerCase()} in this session.
					</div>
				) : (
					<ul className="divide-y divide-border font-mono text-xs">
						{rows.map((ev, i) => (
							<EventLine
								key={i}
								ev={ev}
								showNetworkBar={filter === "network"}
								open={openIndex === i}
								onToggle={() => setOpenIndex(openIndex === i ? null : i)}
							/>
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

/**
 * Split a URL into the part worth reading and the part that repeats.
 *
 * The rail truncates at the tail, so the path leads and the host trails: within
 * one session the host is the same on row after row, while the path is the only
 * thing that distinguishes them. Anything unparseable stays whole.
 */
export function splitUrl(url: string): { lead: string; trail: string } {
	try {
		const parsed = new URL(url)
		return { lead: `${parsed.pathname}${parsed.search}`, trail: parsed.host }
	} catch {
		return { lead: url, trail: "" }
	}
}

/**
 * Glyph, tone and name per event kind — the single source both the rows and
 * {@link EventKindLegend} read, so the key can never drift from the rail.
 *
 * The kind is a glyph rather than a word because a fixed-width text tag either
 * truncates or overflows the moment a label is longer than the slot, which is
 * how `navigation` used to print across the URL beside it. Glyphs need a key;
 * words don't. Keys are the gateway's closed type set (session_analytics.rs).
 */
const EVENT_KIND_VISUALS = {
	navigation: {
		Icon: PixelWindowIcon,
		tone: "text-success-foreground",
		selected: "bg-success/15 text-success-foreground",
		label: "Page",
	},
	click: {
		Icon: PixelCrosshairsIcon,
		tone: "text-warning-foreground",
		selected: "bg-warning/15 text-warning-foreground",
		label: "Click",
	},
	network: {
		Icon: PixelNodesIcon,
		tone: "text-info-foreground",
		selected: "bg-info/15 text-info-foreground",
		label: "Request",
	},
	custom: {
		Icon: PixelSparkleIcon,
		tone: "text-primary",
		selected: "bg-primary/15 text-primary",
		label: "Product",
	},
	console: {
		Icon: PixelBracketsCurlyIcon,
		tone: "text-muted-foreground",
		selected: "bg-muted text-foreground",
		label: "Console",
	},
	error: {
		Icon: PixelTriangleWarningIcon,
		tone: "text-destructive",
		selected: "bg-destructive/15 text-destructive",
		label: "Error",
	},
} as const satisfies Record<string, { Icon: IconComponent; tone: string; selected: string; label: string }>

const LEGEND_KINDS = Object.keys(EVENT_KIND_VISUALS) as ReadonlyArray<keyof typeof EVENT_KIND_VISUALS>

/** The row's type marker and its two text lanes. */
export function eventVisual(ev: EventRow): {
	Icon: IconComponent
	tone: string
	lead: string
	trail: string
} {
	switch (ev.type) {
		case "navigation": {
			const { lead, trail } = splitUrl(ev.url)
			return { ...EVENT_KIND_VISUALS.navigation, lead, trail }
		}
		case "click":
			return {
				...EVENT_KIND_VISUALS.click,
				lead: ev.targetText || ev.targetSelector || "click",
				trail: ev.targetText ? ev.targetSelector : "",
			}
		case "network": {
			const { lead, trail } = splitUrl(ev.netUrl)
			return {
				...EVENT_KIND_VISUALS.network,
				// A failed request is an error wherever it appears, so it takes the
				// error tone while keeping the request glyph.
				tone: isFailedRequest(ev) ? EVENT_KIND_VISUALS.error.tone : EVENT_KIND_VISUALS.network.tone,
				lead: ev.netMethod ? `${ev.netMethod} ${lead}` : lead,
				trail,
			}
		}
		case "error":
			return { ...EVENT_KIND_VISUALS.error, lead: ev.message, trail: "" }
		case "custom":
			return { ...EVENT_KIND_VISUALS.custom, lead: ev.message, trail: "" }
		case "console": {
			const tone =
				ev.level === "error"
					? EVENT_KIND_VISUALS.error.tone
					: ev.level === "warn"
						? EVENT_KIND_VISUALS.click.tone
						: EVENT_KIND_VISUALS.console.tone
			return { ...EVENT_KIND_VISUALS.console, tone, lead: ev.message, trail: "" }
		}
		default:
			return {
				...EVENT_KIND_VISUALS.console,
				lead: ev.message || ev.url,
				trail: "",
			}
	}
}

/**
 * Key for the row glyphs, behind an info button in the filter bar.
 *
 * The rail trades words for glyphs to survive its width, and glyphs owe the
 * reader a key. On screen permanently it was a second strip of chips competing
 * with the filters beside it, so it waits until asked — the icons are
 * guessable, the key settles the guess.
 */
/** One-line kind filter: `All <n>` plus a glyph toggle per kind, then the key. */
function EventFilterBar({
	counts,
	filter,
	onChange,
}: {
	counts: Record<EventFilter, number>
	filter: EventFilter
	onChange: (next: EventFilter) => void
}) {
	return (
		<TooltipProvider delay={300}>
			<div className="sticky top-0 z-10 flex shrink-0 items-center gap-0.5 border-b border-border bg-card px-2 py-1">
				<FilterChip
					active={filter === "all"}
					count={counts.all}
					label={FILTER_LABELS.all}
					tone="text-muted-foreground"
					selected="bg-muted text-foreground"
					onClick={() => onChange("all")}
				>
					<span className="text-[11px] font-medium">All</span>
				</FilterChip>
				{KIND_FILTERS.map((id) => {
					const { Icon, tone, selected } = EVENT_KIND_VISUALS[id]
					return (
						<FilterChip
							key={id}
							active={filter === id}
							count={counts[id]}
							label={FILTER_LABELS[id]}
							tone={tone}
							selected={selected}
							onClick={() => onChange(id)}
						>
							<Icon size={13} aria-hidden />
						</FilterChip>
					)
				})}
				<EventKindLegend className="ml-auto" />
			</div>
		</TooltipProvider>
	)
}

function FilterChip({
	active,
	count,
	label,
	tone,
	selected,
	onClick,
	children,
}: {
	active: boolean
	count: number
	label: string
	/** Idle colour — carried by the whole chip, so the glyph and its count agree. */
	tone: string
	/** Selected colour: the same hue as a tinted ground, not a neutral highlight. */
	selected: string
	onClick: () => void
	children: React.ReactNode
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={onClick}
						aria-pressed={active}
						aria-label={`${label} (${count})`}
						className={cn(
							"flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 transition-colors",
							active ? selected : cn(tone, "hover:bg-muted/60"),
							// A kind with nothing in it stays reachable — the empty state
							// names what you filtered to — but drops its colour rather than
							// spending it on a count of zero.
							count === 0 && !active && "text-muted-foreground opacity-45",
						)}
					>
						{children}
						<span className="font-mono text-[10px] tabular-nums">{count}</span>
					</button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	)
}

function EventKindLegend({ className }: { className?: string }) {
	return (
		<Popover>
			<PopoverTrigger
				// Hover is how a key like this actually gets read — you pause on the
				// icon mid-scan rather than committing to a click. Click still works,
				// and the close delay keeps the popup alive while the pointer travels.
				openOnHover
				delay={350}
				closeDelay={120}
				className={cn(
					"inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground",
					className,
				)}
				aria-label="What the event icons mean"
			>
				<CircleInfoIcon size={13} />
			</PopoverTrigger>
			<PopoverContent align="end" className="w-44 p-2">
				<p className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
					Event kinds
				</p>
				<ul className="flex flex-col gap-1 text-xs text-foreground">
					{LEGEND_KINDS.map((kind) => {
						const { Icon, tone, label } = EVENT_KIND_VISUALS[kind]
						return (
							<li key={kind} className="flex items-center gap-2 px-1">
								<Icon size={14} className={cn("shrink-0", tone)} aria-hidden />
								{label}
							</li>
						)
					})}
				</ul>
			</PopoverContent>
		</Popover>
	)
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
			if (!Predicate.isObject(parsed)) return []
			return Object.entries(parsed).map(([key, value]) => [key, String(value)] as const)
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

/**
 * One event, on one line: clock · kind glyph · what happened · what came back.
 *
 * The row is a single click target — it seeks the player to the moment and
 * opens the detail underneath, so the full URL, stack and trace link live one
 * click away instead of competing for the ~380px the rail actually has.
 */
function EventLine({
	ev,
	showNetworkBar,
	open,
	onToggle,
}: {
	ev: EventRow
	showNetworkBar: boolean
	open: boolean
	onToggle: () => void
}) {
	const seekTo = useSeekToTimestamp()
	const clockAt = useClockAt()
	const { Icon, tone, lead, trail } = eventVisual(ev)
	const isError = ev.type === "error" || isFailedRequest(ev)

	return (
		<li className={cn("relative", isError && "bg-destructive/5")}>
			{isError && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-destructive" />}
			<button
				type="button"
				onClick={() => {
					seekTo(ev.timestamp)
					onToggle()
				}}
				aria-expanded={open}
				className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/50"
				title="Seek replay to this moment"
			>
				<span className="w-[30px] shrink-0 text-[10px] tabular-nums text-muted-foreground">
					{clockAt(ev.timestamp)}
				</span>
				<span className="grid size-4 shrink-0 place-items-center">
					<Icon size={16} className={tone} />
				</span>
				<span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
					<span className={cn("truncate", isError ? "text-destructive" : "text-foreground")}>
						{lead}
					</span>
					{trail && <span className="shrink-0 text-[10px] text-muted-foreground">{trail}</span>}
				</span>
				<span className="flex w-[72px] shrink-0 items-center justify-end gap-1.5 text-[10px] tabular-nums">
					{ev.type === "network" ? (
						<>
							<span className={cn("font-semibold", statusTone(ev.netStatus))}>
								{ev.netStatus || "ERR"}
							</span>
							<span
								className={cn(
									isError || ev.netDurationMs >= 1000
										? "font-semibold text-warning-foreground"
										: "text-muted-foreground",
									isError && "text-destructive",
								)}
							>
								{formatNetDuration(ev.netDurationMs)}
							</span>
						</>
					) : ev.type === "console" && ev.level ? (
						<span className={tone}>{ev.level}</span>
					) : null}
				</span>
			</button>
			{showNetworkBar && ev.type === "network" && (
				<span className="block px-3 pb-1.5 pl-[50px]">
					<NetDurationBar durationMs={ev.netDurationMs} failed={isError} />
				</span>
			)}
			{open && <EventDetail ev={ev} />}
		</li>
	)
}

/** The row's overflow: everything the single line had to drop. */
function EventDetail({ ev }: { ev: EventRow }) {
	const fullUrl = ev.type === "network" ? ev.netUrl : ev.url
	return (
		<div className="flex flex-col gap-1.5 px-3 pb-2.5 pl-[50px]">
			{fullUrl && (
				<span className="break-all text-[11px] leading-4 text-muted-foreground">{fullUrl}</span>
			)}
			{ev.type === "click" && ev.targetText && ev.targetSelector && (
				<span className="break-all text-[11px] leading-4 text-muted-foreground">
					{ev.targetSelector}
				</span>
			)}
			{ev.type === "console" && (
				<span className="whitespace-pre-wrap break-words text-[11px] leading-4 text-foreground/80">
					{ev.message}
				</span>
			)}
			{ev.type === "error" && ev.errorStack && (
				<span className="whitespace-pre-wrap text-[11px] leading-4 text-muted-foreground">
					{ev.errorStack.split("\n").slice(0, 3).join("\n")}
				</span>
			)}
			{ev.type === "custom" && <EventProps attributes={ev.attributes} />}
			{ev.traceId && (
				<Link
					to="/traces/$traceId"
					params={{ traceId: ev.traceId }}
					// Carry the event timestamp so the span-hierarchy query narrows the
					// ClickHouse partition scan instead of reading the full retention.
					search={{ t: ev.timestamp }}
					className="w-fit rounded-sm border border-input px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
					title="Open backend trace"
				>
					Open trace
				</Link>
			)}
		</div>
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

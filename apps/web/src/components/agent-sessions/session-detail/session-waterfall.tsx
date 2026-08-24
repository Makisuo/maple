import { useEffect, useMemo, useRef, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"

import type { AiSessionSpan } from "@maple/domain/http"
import { ChevronDownIcon, ChevronRightIcon } from "@/components/icons"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { cn } from "@maple/ui/lib/utils"

import { useListNavigation } from "@/hooks/use-list-navigation"
import { usePageScrollMargin } from "@/hooks/use-page-scroll-margin"
import { buildSessionAxis, type AxisTick, type SessionAxis } from "@/lib/agent-sessions/session-axis"
import {
	countTurnTokens,
	spanTokenBuckets,
	type IdleGap,
	type SessionSummary,
} from "@/lib/agent-sessions/session-summary"
import {
	classifyAiSpan,
	isLlmCall,
	spanEndMs,
	spanModel,
	spanStartMs,
	spanTtftMs,
	type SessionTurn,
	type AiSpanCategory,
} from "@/lib/agent-sessions/session-turns"
import { filterSpans, isDelegation, shortTarget } from "@/lib/agent-sessions/span-filters"
import { SpanInlineDetail, type SpanDetailTab } from "./span-expansion"
import { CATEGORY_FILL } from "./span-visuals"

// Row heights are fixed and known, so the virtualizer never has to measure —
// except the one inline detail row, whose height is its payload's and is
// measured (`measureElement`) instead.
const TURN_ROW_HEIGHT = 30
const ROW_HEIGHT = 26
/** Starting guess for the detail row; the measurement replaces it on mount. */
const DETAIL_ROW_ESTIMATE = 480
/** Past this the indent eats the span name; deep agent trees are common. */
const MAX_INDENT_DEPTH = 6
const INDENT_PX = 14
/** A last tick this close to the end anchors right instead of centring. */
const AXIS_EDGE_FRACTION = 0.9
/** Stable identity for the no-collapse case, so the axis memo can hold. */
const NO_GAPS: readonly IdleGap[] = []

const COL_SPAN = "w-[398px] max-w-[46%] min-w-0 shrink-0 flex items-center gap-1.5"
const COL_MODEL = "hidden w-[150px] shrink-0 truncate px-2 text-muted-foreground @3xl:block"
/** Rows are fixed-height, so the cell truncates rather than wrapping into the row below. */
const COL_TOKENS =
	"hidden w-[132px] shrink-0 truncate px-2 text-right tabular-nums text-muted-foreground @3xl:block"
/** A margin, not padding: the bars inside position in percent, which resolves
 *  against the padding box and would ignore padding entirely. */
const COL_AXIS = "relative ml-3 min-w-0 flex-1 self-stretch"
const COL_DUR = "w-[60px] shrink-0 pl-2 text-right tabular-nums"

type WaterfallRow =
	| {
			readonly kind: "turn"
			readonly key: string
			readonly turn: SessionTurn
			/** Spans of the turn the filter kept, for the collapsed-row count. */
			readonly visibleCount: number
	  }
	| { readonly kind: "span"; readonly key: string; readonly span: AiSessionSpan; readonly depth: number }
	| { readonly kind: "detail"; readonly key: string; readonly span: AiSessionSpan }
	| { readonly kind: "gap"; readonly key: string; readonly gap: IdleGap }

interface SessionWaterfallProps {
	turns: readonly SessionTurn[]
	summary: SessionSummary
	/** Free-text filter over span name, model and tool/agent target. */
	query: string
	/** Hide the app's own HTTP/DB spans that share the agent's traces. */
	agentSpansOnly: boolean
	collapseIdle: boolean
	/** Expansion state lives in SessionViews so a Trace → Flow → Trace round-trip keeps it. */
	collapsedTurns: ReadonlySet<string>
	onToggleTurn: (turnId: string) => void
	/** The one span expanded inline (`?span=`). */
	selectedSpanId: string | undefined
	/** Raised with a span id to expand it, `undefined` to collapse. */
	onSelectSpan: (spanId: string | undefined) => void
	/** The expansion's tab, shared with the Flow view's drawer. */
	spanTab: SpanDetailTab | undefined
	onSpanTabChange: (tab: SpanDetailTab) => void
	/** The session's captured tool results by call id, for the expansion. */
	toolResults?: ReadonlyMap<string, string>
}

export function SessionWaterfall({
	turns,
	summary,
	query,
	agentSpansOnly,
	collapseIdle,
	collapsedTurns,
	onToggleTurn,
	selectedSpanId,
	onSelectSpan,
	spanTab,
	onSpanTabChange,
	toolResults,
}: SessionWaterfallProps) {
	// The page scrolls as one, so the virtualizer rides the page's scroller.
	const { ref: listRef, getScrollElement, scrollMargin } = usePageScrollMargin()

	const spansById = useMemo(
		() => new Map(turns.flatMap((turn) => turn.spans).map((span) => [span.spanId, span])),
		[turns],
	)

	const collapsedGaps = collapseIdle ? summary.idleGaps : NO_GAPS
	const axis = useMemo(
		() => buildSessionAxis({ startMs: summary.startMs, endMs: summary.endMs, collapsedGaps }),
		[summary.startMs, summary.endMs, collapsedGaps],
	)
	const ticks = axis.ticks

	const rows = useMemo(
		() =>
			buildRows({ turns, gaps: collapsedGaps, collapsedTurns, query, agentSpansOnly, selectedSpanId }),
		[turns, collapsedGaps, collapsedTurns, query, agentSpansOnly, selectedSpanId],
	)

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement,
		estimateSize: (index) => {
			const row = rows[index]!
			if (row.kind === "turn") return TURN_ROW_HEIGHT
			if (row.kind === "detail") return DETAIL_ROW_ESTIMATE
			return ROW_HEIGHT
		},
		getItemKey: (index) => rows[index]!.key,
		overscan: 16,
		scrollMargin,
	})

	// The keyboard's span cursor: ↑/↓ walk the span rows the filter left
	// visible, Enter expands the one under the cursor, Esc collapses.
	const spanRowIndexById = useMemo(() => {
		const byId = new Map<string, number>()
		rows.forEach((row, index) => {
			if (row.kind === "span") byId.set(row.span.spanId, index)
		})
		return byId
	}, [rows])
	const spanIds = useMemo(() => [...spanRowIndexById.keys()], [spanRowIndexById])

	const { focusedId, setFocusedId } = useListNavigation({
		ids: spanIds,
		onOpen: (spanId) => onSelectSpan(spanId),
		onEscape: () => {
			if (selectedSpanId === undefined) return false
			onSelectSpan(undefined)
			return true
		},
		scrollTo: (spanId) => {
			const index = spanRowIndexById.get(spanId)
			if (index !== undefined) virtualizer.scrollToIndex(index)
		},
	})

	// A pasted `?span=` link lands on the exact span it names: the cursor starts
	// there and the row is scrolled into view. Once, on mount — after that the
	// URL follows the reader rather than leading them.
	const didInitialScroll = useRef(false)
	useEffect(() => {
		if (didInitialScroll.current) return
		didInitialScroll.current = true
		if (selectedSpanId === undefined) return
		setFocusedId(selectedSpanId)
		const index = spanRowIndexById.get(selectedSpanId)
		if (index !== undefined) virtualizer.scrollToIndex(index, { align: "center" })
	}, [selectedSpanId, spanRowIndexById, setFocusedId, virtualizer])

	return (
		<div className="@container flex grow flex-col">
			{/* Stacks under the views' sticky control bar, whose height that bar
			    publishes as a variable, so the ruler stays readable while scrolling. */}
			<div className="sticky top-[var(--session-controls-height,0px)] z-10 bg-background">
				<div className="flex h-7 items-center border-border border-b px-2.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
					<span className={COL_SPAN}>Span</span>
					<span className={COL_MODEL}>Model / target</span>
					<span className={COL_TOKENS}>Tokens In / Out</span>
					<span className={cn(COL_AXIS, "flex items-center")}>
						{ticks.map((tick, index) => (
							<span
								key={tick.fraction}
								className={cn(
									// The ruler is a reading of the clock, not a column name.
									"absolute whitespace-nowrap normal-case tabular-nums",
									tickAnchor(index, ticks),
								)}
								style={{ left: `${tick.fraction * 100}%` }}
							>
								{tick.label}
							</span>
						))}
						{/* Where a removed gap was: the seam is what stops the collapsed
						    axis from reading as linear time. */}
						{collapsedGaps.map((gap) => (
							<span
								key={gap.id}
								aria-hidden
								className="absolute inset-y-0 border-border border-l-2 border-dashed"
								style={{ left: `${axis.fraction(gap.startMs) * 100}%` }}
							/>
						))}
					</span>
					<span className={COL_DUR}>Dur</span>
				</div>

				{axis.removedGapCount > 0 && (
					<p className="border-border border-b px-2.5 py-1 text-[11px] text-muted-foreground">
						Axis shows active time. {formatSessionDuration(axis.removedMs)} of idle removed across{" "}
						{axis.removedGapCount} gap{axis.removedGapCount === 1 ? "" : "s"}.
					</p>
				)}
			</div>

			<div ref={listRef}>
				{rows.length === 0 ? (
					<p className="px-2.5 py-8 text-center text-muted-foreground text-sm">
						No spans match this filter.
					</p>
				) : (
					<div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
						{virtualizer.getVirtualItems().map((item) => {
							const row = rows[item.index]!
							return (
								<div
									key={item.key}
									// Only the detail row is measured: its height is its
									// payload's, and the fixed rows stay estimate-only.
									ref={row.kind === "detail" ? virtualizer.measureElement : undefined}
									data-index={item.index}
									className="absolute inset-x-0 top-0"
									// `start` is in the page scroller's coordinates; the margin
									// brings it back to this list's own. The detail row takes its
									// height from its payload instead of the estimate.
									style={
										row.kind === "detail"
											? { transform: `translateY(${item.start - scrollMargin}px)` }
											: {
													height: item.size,
													transform: `translateY(${item.start - scrollMargin}px)`,
												}
									}
								>
									{row.kind === "turn" && (
										<TurnHeader
											row={row}
											turns={turns}
											axis={axis}
											collapsed={collapsedTurns.has(row.turn.id)}
											onToggle={() => onToggleTurn(row.turn.id)}
										/>
									)}
									{row.kind === "span" && (
										<SpanRow
											row={row}
											axis={axis}
											spansById={spansById}
											selected={selectedSpanId === row.span.spanId}
											focused={focusedId === row.span.spanId}
											onClick={() => {
												setFocusedId(row.span.spanId)
												onSelectSpan(
													selectedSpanId === row.span.spanId
														? undefined
														: row.span.spanId,
												)
											}}
										/>
									)}
									{row.kind === "detail" && (
										<SpanInlineDetail
											span={row.span}
											tab={spanTab}
											onTabChange={onSpanTabChange}
											toolResults={toolResults}
										/>
									)}
									{row.kind === "gap" && <GapRow gap={row.gap} />}
								</div>
							)
						})}
					</div>
				)}
			</div>
		</div>
	)
}

/** Labels sit centred on their instant; the ends anchor inward so a label can't
 *  hang off the column. */
function tickAnchor(index: number, ticks: readonly AxisTick[]): string {
	if (index === 0) return ""
	const atEnd = index === ticks.length - 1 && ticks[index]!.fraction > AXIS_EDGE_FRACTION
	return atEnd ? "-translate-x-full" : "-translate-x-1/2"
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

function buildRows(input: {
	turns: readonly SessionTurn[]
	gaps: readonly IdleGap[]
	collapsedTurns: ReadonlySet<string>
	query: string
	agentSpansOnly: boolean
	selectedSpanId: string | undefined
}): readonly WaterfallRow[] {
	const surviving = input.turns.flatMap((turn) => {
		const spans = filterSpans(turn.spans, input.query, input.agentSpansOnly)
		return spans.length === 0 ? [] : [{ turn, spans }]
	})
	// A turn whose every span was filtered out drops off the page entirely, and a
	// filter that empties every turn renders the empty state rather than a column
	// of orphaned idle rows.
	if (surviving.length === 0) return []

	const rows: WaterfallRow[] = []
	let gapIndex = 0
	const flushGaps = (limitMs: number) => {
		while (gapIndex < input.gaps.length && input.gaps[gapIndex]!.startMs < limitMs) {
			const gap = input.gaps[gapIndex]!
			rows.push({ kind: "gap", key: gap.id, gap })
			gapIndex++
		}
	}

	for (const { turn, spans } of surviving) {
		flushGaps(turn.startMs)
		rows.push({ kind: "turn", key: turn.id, turn, visibleCount: spans.length })

		if (input.collapsedTurns.has(turn.id)) {
			flushGaps(turn.endMs)
			continue
		}
		for (const { span, depth } of orderByTree(spans)) {
			// Nothing at all runs during an idle gap, so no span straddles one: the
			// turn's own rows split cleanly at the first span that starts after it.
			flushGaps(spanStartMs(span))
			rows.push({ kind: "span", key: `${turn.id}:${span.spanId}`, span, depth })
			// The selected span's payload expands inline, directly under its row —
			// one at a time, which is why this is the selection and not a set.
			if (span.spanId === input.selectedSpanId) {
				rows.push({ kind: "detail", key: `detail:${span.spanId}`, span })
			}
		}
		flushGaps(turn.endMs)
	}

	flushGaps(Number.POSITIVE_INFINITY)
	return rows
}

/** Depth-first over the parent chain, with anything whose parent was filtered
 *  out (or lives in another turn) promoted to the top level. */
function orderByTree(spans: readonly AiSessionSpan[]): readonly { span: AiSessionSpan; depth: number }[] {
	const present = new Set(spans.map((span) => span.spanId))
	const children = new Map<string, AiSessionSpan[]>()
	const roots: AiSessionSpan[] = []
	for (const span of spans) {
		if (span.parentSpanId !== "" && present.has(span.parentSpanId)) {
			const siblings = children.get(span.parentSpanId)
			if (siblings === undefined) children.set(span.parentSpanId, [span])
			else siblings.push(span)
		} else {
			roots.push(span)
		}
	}

	const out: { span: AiSessionSpan; depth: number }[] = []
	const walk = (span: AiSessionSpan, depth: number) => {
		out.push({ span, depth })
		for (const child of children.get(span.spanId) ?? []) walk(child, depth + 1)
	}
	for (const root of roots) walk(root, 0)
	return out
}

/* -------------------------------------------------------------------------- */
/* Row components                                                             */
/* -------------------------------------------------------------------------- */

/** The header's ticks, mirrored behind the bars so a bar can be read against the ruler. */
function AxisGrid({ ticks }: { ticks: readonly AxisTick[] }) {
	return (
		<>
			{ticks.map((tick) => (
				<span
					key={tick.fraction}
					aria-hidden
					className="absolute inset-y-0 w-px bg-border/40"
					style={{ left: `${tick.fraction * 100}%` }}
				/>
			))}
		</>
	)
}

function TurnHeader({
	row,
	turns,
	axis,
	collapsed,
	onToggle,
}: {
	row: Extract<WaterfallRow, { kind: "turn" }>
	/** The whole session's turns: a reporter wider than this one belongs to none. */
	turns: readonly SessionTurn[]
	axis: SessionAxis
	collapsed: boolean
	onToggle: () => void
}) {
	const { turn } = row
	// Tokens and duration are facts about the turn, not about the rows on screen:
	// they stay whole while a filter narrows the spans under them. A session-level
	// reporter is left out, so the column reads "—" rather than crediting one turn
	// with the whole session.
	const tokens = countTurnTokens(turn, turns)
	const left = axis.fraction(turn.startMs) * 100
	const width = Math.max(0.4, (axis.fraction(turn.endMs) - axis.fraction(turn.startMs)) * 100)
	// A trace-anchored turn is the fallback partition — one turn per trace — so it
	// is a segment of the session, not an established exchange with the user.
	const ordinal = `${turn.anchorKind === "trace" ? "Segment" : "Turn"} ${turn.index}`
	const traceId = turn.traceIds[0]

	return (
		<div className="flex h-full w-full items-center rounded-md bg-card px-2.5 text-left text-xs hover:bg-accent/40">
			<span className={COL_SPAN}>
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={!collapsed}
					className={cn(
						"flex min-w-0 flex-1 items-center gap-1.5 rounded-xs text-left",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
					)}
				>
					{collapsed ? (
						<ChevronRightIcon size={12} className="shrink-0 text-muted-foreground" />
					) : (
						<ChevronDownIcon size={12} className="shrink-0 text-muted-foreground" />
					)}
					<span className="shrink-0 font-medium text-[10px] text-primary uppercase tracking-wider">
						{ordinal}
					</span>
					{/* The label is the first prose line of a captured message, not a
					    verbatim quote, so it is set as muted text rather than quoted. */}
					<span className="min-w-0 truncate text-muted-foreground">
						{turn.label === undefined ? (
							<span className="italic">no captured message</span>
						) : (
							turn.label
						)}
					</span>
					{turn.failed && <Pill tone="error">Failed</Pill>}
					{collapsed && (
						<span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground tabular-nums">
							{row.visibleCount} spans
						</span>
					)}
				</button>
				{traceId !== undefined && (
					<span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wider">
						<TraceLink traceId={traceId} timestamp={turn.anchor.timestamp} />
						{turn.traceIds.length > 1 && <span>+{turn.traceIds.length - 1}</span>}
					</span>
				)}
			</span>
			<span className={COL_MODEL}>{turn.agentName ?? "—"}</span>
			<span className={COL_TOKENS}>{tokens.total > 0 ? formatNumber(tokens.total) : "—"}</span>
			<span className={COL_AXIS}>
				<AxisGrid ticks={axis.ticks} />
				<span
					className="absolute inset-y-0 my-auto h-1.5 rounded-xs bg-muted"
					style={{ left: `${left}%`, width: `${width}%` }}
				/>
			</span>
			{/* The same formatter as the span rows below, or a 52.4s turn reads as
			    "52s" above a 52.40s child and looks shorter than its own content. */}
			<span className={cn(COL_DUR, "text-muted-foreground")}>{formatDuration(turn.durationMs)}</span>
		</div>
	)
}

/** With no side panel there is no in-page trace pane: the turn's trace opens
 *  as the full trace page, windowed by the turn's own anchor timestamp. */
function TraceLink({ traceId, timestamp }: { traceId: string; timestamp: string }) {
	return (
		<Link
			to="/traces/$traceId"
			params={{ traceId }}
			search={{ t: timestamp }}
			className={cn(
				"shrink-0 cursor-pointer rounded-xs font-mono hover:text-foreground",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
			)}
		>
			Trace {traceId.slice(0, 8)}
		</Link>
	)
}

function SpanRow({
	row,
	axis,
	spansById,
	selected,
	focused,
	onClick,
}: {
	row: Extract<WaterfallRow, { kind: "span" }>
	axis: SessionAxis
	spansById: ReadonlyMap<string, AiSessionSpan>
	selected: boolean
	/** Under the keyboard's span cursor — distinct from `selected`, which means expanded. */
	focused: boolean
	onClick: () => void
}) {
	const { span } = row
	const category = classifyAiSpan(span)
	const errored = span.statusCode === "Error"
	const target = spanTarget(span, category)
	// Only a model id is a provider path — a tool's target is usually a file path,
	// whose last segment is not the part worth keeping.
	const targetLabel = target === undefined ? "—" : category === "tool" ? target : shortTarget(target)

	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={selected || undefined}
			aria-expanded={selected}
			className={cn(
				"flex h-full w-full cursor-pointer items-center px-2.5 text-left text-xs hover:bg-accent/40",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
				errored && "bg-destructive/6",
				focused && "bg-accent/60",
				selected && "border-l-2 border-l-primary bg-primary/5",
			)}
		>
			<span
				className={COL_SPAN}
				style={{ paddingLeft: Math.min(row.depth, MAX_INDENT_DEPTH) * INDENT_PX }}
			>
				<span
					aria-hidden
					className={cn(
						"size-1.5 shrink-0 rounded-xs",
						errored ? "bg-destructive" : CATEGORY_FILL[category],
					)}
				/>
				<span className="shrink-0 truncate font-medium">{span.spanName}</span>
				<span className="min-w-0 truncate text-muted-foreground">{spanMeta(span, category)}</span>
				{errored && <Pill tone="error">{span.genAi.errorType ?? "Error"}</Pill>}
				{isDelegation(span, spansById) && <Pill tone="outline">Subagent</Pill>}
			</span>
			<span className={cn(COL_MODEL, errored && "text-destructive")} title={target}>
				{targetLabel}
			</span>
			<span className={cn(COL_TOKENS, errored && "text-destructive")}>{spanTokens(span)}</span>
			<span className={COL_AXIS}>
				<AxisGrid ticks={axis.ticks} />
				<SpanBar span={span} axis={axis} category={category} errored={errored} />
			</span>
			<span className={cn(COL_DUR, "text-muted-foreground")}>{formatDuration(span.durationMs)}</span>
		</button>
	)
}

function SpanBar({
	span,
	axis,
	category,
	errored,
}: {
	span: AiSessionSpan
	axis: SessionAxis
	category: AiSpanCategory
	errored: boolean
}) {
	const startMs = spanStartMs(span)
	const left = axis.fraction(startMs) * 100
	// A hairline floor: a 20ms tool call on a twelve-minute axis still has to be
	// findable, and the row's DUR column carries the real number.
	const width = Math.max(0.35, (axis.fraction(spanEndMs(span)) - axis.fraction(startMs)) * 100)
	const ttftMs = spanTtftMs(span)
	const ttftShare = ttftMs === undefined ? 0 : (ttftMs / span.durationMs) * 100
	/** An agent span contains the leaf work rather than being work, so it recedes. */
	const container = category === "agent" && !errored

	return (
		<span
			className="absolute inset-y-0 my-auto h-1.5 overflow-hidden rounded-xs"
			style={{ left: `${left}%`, width: `${width}%` }}
		>
			{ttftMs !== undefined && !errored ? (
				<>
					<span
						className="absolute inset-y-0 left-0 bg-chart-2/45"
						style={{ width: `${ttftShare}%` }}
					/>
					<span
						className="absolute inset-y-0 right-0 bg-chart-2"
						style={{ width: `${100 - ttftShare}%` }}
					/>
				</>
			) : (
				<span
					className={cn(
						"absolute inset-0",
						errored ? "bg-destructive" : CATEGORY_FILL[category],
						container && "opacity-35",
					)}
				/>
			)}
		</span>
	)
}

function GapRow({ gap }: { gap: IdleGap }) {
	return (
		<div className="flex h-full items-center gap-3 pr-2.5 pl-20 text-[11px] text-muted-foreground">
			<span className="shrink-0">idle {formatSessionDuration(gap.durationMs)}</span>
			<span aria-hidden className="h-px flex-1 bg-border" />
		</div>
	)
}

const PILL_TONE = {
	error: "bg-destructive/12 text-destructive",
	warn: "bg-severity-warn/12 text-severity-warn",
	outline: "border border-border text-muted-foreground",
} satisfies Record<string, string>

function Pill({ tone, children }: { tone: keyof typeof PILL_TONE; children: ReactNode }) {
	return (
		<span
			className={cn(
				"shrink-0 rounded-full px-1.5 py-px font-medium text-[10px] uppercase tracking-wide",
				PILL_TONE[tone],
			)}
		>
			{children}
		</span>
	)
}

/* -------------------------------------------------------------------------- */
/* Cell content                                                               */
/* -------------------------------------------------------------------------- */

/** Inline meta beside the span name. */
function spanMeta(span: AiSessionSpan, category: AiSpanCategory): string {
	const parts: string[] = []
	const agentName = span.genAi.agentName
	if (category === "agent" && agentName !== undefined) parts.push(agentName)
	const toolName = span.genAi.toolName
	if (category === "tool" && toolName !== undefined) parts.push(toolName)
	const ttftMs = spanTtftMs(span)
	if (ttftMs !== undefined) parts.push(`ttft ${formatDuration(ttftMs)}`)
	const reasoning = span.genAi.usageReasoningOutputTokens
	if (reasoning !== undefined && reasoning > 0) parts.push(`${formatNumber(reasoning)} reasoning`)
	if (span.statusMessage !== "") parts.push(span.statusMessage)
	return parts.join(" · ")
}

/** The MODEL / TARGET cell: the model that ran, or what the tool acted on. The
 *  app's own spans borrow the column for the service that ran them. */
function spanTarget(span: AiSessionSpan, category: AiSpanCategory): string | undefined {
	if (category === "tool") return toolTarget(span)
	return spanModel(span) ?? (span.isAiSpan ? undefined : span.serviceName)
}

/** Argument keys that name what a tool acted on, most specific first. */
const TOOL_TARGET_KEYS = ["path", "file_path", "filePath", "file", "query", "pattern", "command", "url"]
/** The target shares a 150px cell; the full value stays in the row's `title`. */
const MAX_TARGET_LENGTH = 120

/**
 * What the tool was pointed at. `gen_ai.tool.call.arguments` is vendor JSON, so
 * this reads the keys that name a target and otherwise gives up — a printed blob
 * of arguments would push the useful columns off the row.
 */
function toolTarget(span: AiSessionSpan): string | undefined {
	const args = span.genAi.toolCallArguments
	if (typeof args === "string") return clipTarget(args)
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined

	const record = args as Record<string, unknown>
	for (const key of TOOL_TARGET_KEYS) {
		const value = record[key]
		if (typeof value === "string") return clipTarget(value)
	}
	return undefined
}

function clipTarget(value: string): string | undefined {
	const text = value.trim().replace(/\s+/g, " ")
	if (text.length === 0) return undefined
	return text.length > MAX_TARGET_LENGTH ? `${text.slice(0, MAX_TARGET_LENGTH - 1)}…` : text
}

/**
 * `in → out`, taken from the same buckets the header sums, so a row and the
 * session total can never tell different stories. The in half is everything the
 * model read — fresh input plus both cache buckets — and the out half is what
 * it wrote, reasoning included.
 */
function spanTokens(span: AiSessionSpan): string {
	if (!isLlmCall(span)) return "—"
	const buckets = spanTokenBuckets(span)
	if (buckets === undefined || buckets.total === 0) return "—"
	const completion = buckets.output + buckets.reasoning
	return `${formatNumber(buckets.total - completion)} → ${formatNumber(completion)}`
}

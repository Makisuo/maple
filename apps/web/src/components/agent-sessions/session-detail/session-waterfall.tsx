import { useMemo, useRef, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"

import type { AiSessionSpan } from "@maple/domain/http"
import { ChevronDownIcon, ChevronRightIcon } from "@/components/icons"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { cn } from "@maple/ui/lib/utils"

import { buildSessionAxis, type SessionAxis } from "@/lib/agent-sessions/active-axis"
import {
	countSessionTokens,
	retriedSpanIds,
	type IdleGap,
	type SessionSummary,
} from "@/lib/agent-sessions/session-summary"
import {
	classifySpan,
	isLlmCall,
	spanEndMs,
	spanModel,
	spanStartMs,
	spanTtftMs,
	type SessionTurn,
	type SpanCategory,
} from "@/lib/agent-sessions/session-turns"
import { CATEGORY_FILL, filterSpans, isDelegation, shortTarget } from "./span-visuals"

// Row heights are fixed and known, so the virtualizer never has to measure.
const TURN_ROW_HEIGHT = 30
const ROW_HEIGHT = 26
/** Past this the indent eats the span name; deep agent trees are common. */
const MAX_INDENT_DEPTH = 6
const INDENT_PX = 14

const COL_SPAN = "w-[398px] max-w-[46%] min-w-0 shrink-0 flex items-center gap-1.5"
const COL_MODEL = "hidden w-[150px] shrink-0 truncate px-2 text-muted-foreground @3xl:block"
// Wider than the design's 84px, and `truncate` on top of that: the prompt figure
// counts cache reads, which run to six digits on a real agent session, and the
// product's type is monospace. Rows are absolutely positioned at a fixed height,
// so a cell that wrapped to two lines would spill into the row below.
const COL_TOKENS =
	"hidden w-[104px] shrink-0 truncate px-2 text-right tabular-nums text-muted-foreground @3xl:block"
// A margin, not padding: the bars and ticks inside are positioned in percent,
// which resolves against the padding box and would ignore padding entirely.
const COL_AXIS = "relative ml-3 min-w-0 flex-1 self-stretch"
const COL_DUR = "w-[60px] shrink-0 pl-2 text-right tabular-nums"

interface TraceLinkTarget {
	readonly traceId: string
	readonly timestamp: string
}

type WaterfallRow =
	| { readonly kind: "trace"; readonly key: string; readonly link: TraceLinkTarget; readonly turns: string }
	| {
			readonly kind: "turn"
			readonly key: string
			readonly turn: SessionTurn
			readonly hiddenCount: number
			/** Set only when the turn is the whole of its trace band (B3). */
			readonly link: TraceLinkTarget | undefined
	  }
	| { readonly kind: "span"; readonly key: string; readonly span: AiSessionSpan; readonly depth: number }
	| { readonly kind: "gap"; readonly key: string; readonly gap: IdleGap; readonly collapsed: boolean }

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
	expandedGaps: ReadonlySet<string>
	onToggleGap: (gapId: string) => void
}

export function SessionWaterfall({
	turns,
	summary,
	query,
	agentSpansOnly,
	collapseIdle,
	collapsedTurns,
	onToggleTurn,
	expandedGaps,
	onToggleGap,
}: SessionWaterfallProps) {
	const scrollRef = useRef<HTMLDivElement>(null)

	const spansById = useMemo(
		() => new Map(turns.flatMap((turn) => turn.spans).map((span) => [span.spanId, span])),
		[turns],
	)
	const retried = useMemo(() => retriedSpanIds(turns), [turns])

	const axis = useMemo(
		() =>
			buildSessionAxis({
				startMs: summary.startMs,
				endMs: summary.endMs,
				collapsedGaps: collapseIdle
					? summary.idleGaps.filter((gap) => !expandedGaps.has(gap.id))
					: [],
			}),
		[summary.startMs, summary.endMs, summary.idleGaps, collapseIdle, expandedGaps],
	)
	const ticks = axis.ticks

	const rows = useMemo(
		() =>
			buildRows({
				turns,
				gaps: collapseIdle ? summary.idleGaps : [],
				expandedGaps,
				collapsedTurns,
				query,
				agentSpansOnly,
			}),
		[turns, summary.idleGaps, collapseIdle, expandedGaps, collapsedTurns, query, agentSpansOnly],
	)

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: (index) => (rows[index]!.kind === "turn" ? TURN_ROW_HEIGHT : ROW_HEIGHT),
		getItemKey: (index) => rows[index]!.key,
		overscan: 16,
	})

	return (
		<div className="@container flex h-full min-h-0 flex-col">
			<div className="flex h-7 shrink-0 items-center border-border border-b px-2.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
				<span className={COL_SPAN}>Span</span>
				<span className={COL_MODEL}>Model / target</span>
				<span className={COL_TOKENS}>Tokens</span>
				<span className={cn(COL_AXIS, "flex items-center")}>
					{ticks.map((tick, index) => (
						<span
							key={tick.axisMs}
							className={cn(
								// The ruler is a reading of the clock, not a column name —
								// the row's uppercase belongs to the headings alone.
								"absolute whitespace-nowrap normal-case tabular-nums",
								index === ticks.length - 1 && "-translate-x-full",
							)}
							style={{ left: `${(tick.axisMs / axis.totalMs) * 100}%` }}
						>
							{tick.label}
						</span>
					))}
				</span>
				<span className={COL_DUR}>Dur</span>
			</div>

			{axis.removedGapCount > 0 && (
				<p className="shrink-0 border-border border-b px-2.5 py-1 text-[11px] text-muted-foreground">
					Axis shows active time. {formatSessionDuration(axis.removedMs)} of idle removed across{" "}
					{axis.removedGapCount} gap{axis.removedGapCount === 1 ? "" : "s"}.
				</p>
			)}

			<div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
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
									className="absolute inset-x-0 top-0"
									style={{ height: item.size, transform: `translateY(${item.start}px)` }}
								>
									{row.kind === "trace" && <TraceRule row={row} />}
									{row.kind === "turn" && (
										<TurnHeader
											row={row}
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
											retried={retried}
											singleService={summary.serviceNames.length <= 1}
										/>
									)}
									{row.kind === "gap" && (
										<GapRow row={row} onToggle={() => onToggleGap(row.gap.id)} />
									)}
								</div>
							)
						})}
					</div>
				)}
			</div>
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

function buildRows(input: {
	turns: readonly SessionTurn[]
	gaps: readonly IdleGap[]
	expandedGaps: ReadonlySet<string>
	collapsedTurns: ReadonlySet<string>
	query: string
	agentSpansOnly: boolean
}): readonly WaterfallRow[] {
	const surviving = input.turns.flatMap((turn) => {
		const spans = filterSpans(turn.spans, input.query, input.agentSpansOnly)
		return spans.length === 0 ? [] : [{ turn, spans }]
	})
	// A turn whose every span was filtered out drops off the page entirely, and a
	// filter that empties every turn renders the empty state rather than a column
	// of orphaned idle rows.
	if (surviving.length === 0) return []

	// Traces band the turns: a trace commonly holds several turns and a turn can
	// cross traces, so neither nests inside the other and the rule is drawn where
	// the trace changes. Banding the *surviving* turns keeps a rule from
	// advertising turns the filter removed.
	const bands = traceBands(surviving.map((entry) => entry.turn))

	const rows: WaterfallRow[] = []
	let gapIndex = 0
	const flushGaps = (limitMs: number) => {
		while (gapIndex < input.gaps.length && input.gaps[gapIndex]!.startMs < limitMs) {
			const gap = input.gaps[gapIndex]!
			rows.push({ kind: "gap", key: gap.id, gap, collapsed: !input.expandedGaps.has(gap.id) })
			gapIndex++
		}
	}

	surviving.forEach(({ turn, spans }, index) => {
		flushGaps(turn.startMs)

		const band = bands.ranges[bands.byTurn[index]!]!
		const link = { traceId: band.traceId, timestamp: turn.anchor.timestamp }
		// A band covering one turn would spend a whole row saying what fits in the
		// spare width of that turn's own header.
		if (bands.byTurn[index] !== bands.byTurn[index - 1] && band.turnCount > 1) {
			rows.push({
				kind: "trace",
				key: `trace:${band.traceId}:${band.from}`,
				link,
				turns: `turns ${band.from}–${band.to}`,
			})
		}

		rows.push({
			kind: "turn",
			key: turn.id,
			turn,
			hiddenCount: turn.spans.length - spans.length,
			link: band.turnCount === 1 ? link : undefined,
		})

		if (input.collapsedTurns.has(turn.id)) {
			flushGaps(turn.endMs)
			return
		}
		for (const { span, depth } of orderByTree(spans)) {
			// Nothing at all runs during an idle gap, so no span straddles one: the
			// turn's own rows split cleanly at the first span that starts after it.
			flushGaps(spanStartMs(span))
			rows.push({ kind: "span", key: `${turn.id}:${span.spanId}`, span, depth })
		}
		flushGaps(turn.endMs)
	})

	flushGaps(Number.POSITIVE_INFINITY)
	return rows
}

/** Contiguous runs of turns sharing a primary trace; one band opens each rule. */
function traceBands(turns: readonly SessionTurn[]): {
	byTurn: readonly number[]
	ranges: readonly { traceId: string; from: number; to: number; turnCount: number }[]
} {
	const byTurn: number[] = []
	const ranges: { traceId: string; from: number; to: number; turnCount: number }[] = []
	for (const turn of turns) {
		const traceId = turn.traceIds[0] ?? ""
		const open = ranges.at(-1)
		if (open === undefined || traceId !== open.traceId) {
			ranges.push({ traceId, from: turn.index, to: turn.index, turnCount: 1 })
		} else {
			open.to = turn.index
			open.turnCount++
		}
		byTurn.push(ranges.length - 1)
	}
	return { byTurn, ranges }
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

function TraceLink({ link, className }: { link: TraceLinkTarget; className?: string }) {
	return (
		<Link
			to="/traces/$traceId"
			params={{ traceId: link.traceId }}
			search={{ t: link.timestamp }}
			className={cn("shrink-0 font-mono hover:text-foreground", className)}
		>
			Trace {link.traceId.slice(0, 8)}
		</Link>
	)
}

function TraceRule({ row }: { row: Extract<WaterfallRow, { kind: "trace" }> }) {
	return (
		<div className="flex h-full items-center gap-3 px-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">
			<TraceLink link={row.link} />
			<span aria-hidden className="h-px flex-1 bg-border" />
			<span className="shrink-0 normal-case">{row.turns}</span>
		</div>
	)
}

function TurnHeader({
	row,
	axis,
	collapsed,
	onToggle,
}: {
	row: Extract<WaterfallRow, { kind: "turn" }>
	axis: SessionAxis
	collapsed: boolean
	onToggle: () => void
}) {
	const { turn } = row
	// Tokens and duration are facts about the turn, not about the rows on screen:
	// they stay whole while a filter narrows the spans under them.
	const tokens = countSessionTokens(turn.spans)
	const left = axis.fraction(turn.startMs) * 100
	const width = Math.max(0.4, (axis.fraction(turn.endMs) - axis.fraction(turn.startMs)) * 100)

	return (
		<div className="flex h-full w-full items-center rounded-md bg-card px-2.5 text-left text-xs hover:bg-accent/40">
			<span className={COL_SPAN}>
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={!collapsed}
					className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
				>
					{collapsed ? (
						<ChevronRightIcon size={12} className="shrink-0 text-muted-foreground" />
					) : (
						<ChevronDownIcon size={12} className="shrink-0 text-muted-foreground" />
					)}
					<span className="shrink-0 font-medium text-[10px] text-primary uppercase tracking-wider">
						Turn {turn.index}
					</span>
					<span className="min-w-0 truncate text-muted-foreground">
						{turn.label === undefined ? (
							<span className="italic">no captured message</span>
						) : (
							`“${turn.label}”`
						)}
					</span>
					{turn.failed && <Pill tone="error">Failed</Pill>}
					{collapsed && (
						<span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground tabular-nums">
							{turn.spans.length - row.hiddenCount} spans
						</span>
					)}
				</button>
				{row.link !== undefined && (
					<TraceLink
						link={row.link}
						className="text-[10px] text-muted-foreground uppercase tracking-wider"
					/>
				)}
			</span>
			<span className={COL_MODEL}>{turn.agentName ?? "—"}</span>
			<span className={COL_TOKENS}>{tokens.total > 0 ? formatNumber(tokens.total) : "—"}</span>
			<span className={COL_AXIS}>
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

function SpanRow({
	row,
	axis,
	spansById,
	retried,
	singleService,
}: {
	row: Extract<WaterfallRow, { kind: "span" }>
	axis: SessionAxis
	spansById: ReadonlyMap<string, AiSessionSpan>
	retried: ReadonlySet<string>
	singleService: boolean
}) {
	const { span } = row
	const category = classifySpan(span)
	const errored = span.statusCode === "Error"
	const target = spanTarget(span, category, singleService)
	// Only a model id is a provider path — a tool's target is usually a file path,
	// whose last segment is not the part worth keeping.
	const targetLabel = target === undefined ? "—" : category === "tool" ? target : shortTarget(target)

	return (
		<Link
			to="/traces/$traceId"
			params={{ traceId: span.traceId }}
			search={{ spanId: span.spanId, t: span.timestamp }}
			className={cn(
				"flex h-full items-center px-2.5 text-xs hover:bg-accent/40",
				errored && "bg-destructive/6",
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
				{retried.has(span.spanId) && <Pill tone="warn">Retry</Pill>}
				{isDelegation(span, spansById) && <Pill tone="outline">Subagent</Pill>}
			</span>
			<span className={cn(COL_MODEL, errored && "text-destructive")} title={target}>
				{targetLabel}
			</span>
			<span className={cn(COL_TOKENS, errored && "text-destructive")}>{spanTokenSummary(span)}</span>
			<span className={COL_AXIS}>
				<SpanBar span={span} axis={axis} category={category} errored={errored} />
			</span>
			<span className={cn(COL_DUR, "text-muted-foreground")}>{formatDuration(span.durationMs)}</span>
		</Link>
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
	category: SpanCategory
	errored: boolean
}) {
	const startMs = spanStartMs(span)
	const left = axis.fraction(startMs) * 100
	// A hairline floor: a 20ms tool call on a twelve-minute axis still has to be
	// findable, and the row's DUR column carries the real number.
	const width = Math.max(0.35, (axis.fraction(spanEndMs(span)) - axis.fraction(startMs)) * 100)
	const ttftMs = spanTtftMs(span)
	const ttftShare = ttftMs === undefined ? 0 : (ttftMs / span.durationMs) * 100
	// An agent span contains the leaf work rather than being work, and at full
	// strength its bar is the longest and loudest thing in the column.
	const container = category === "agent" && !errored

	return (
		<span
			className={cn(
				"absolute inset-y-0 my-auto overflow-hidden rounded-xs",
				container ? "h-1" : "h-1.5",
			)}
			style={{ left: `${left}%`, width: `${width}%` }}
		>
			{ttftMs !== undefined && !errored ? (
				<>
					<span
						className="absolute inset-y-0 left-0 bg-chart-5"
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

function GapRow({ row, onToggle }: { row: Extract<WaterfallRow, { kind: "gap" }>; onToggle: () => void }) {
	return (
		<div className="flex h-full items-center gap-3 pr-2.5 pl-20 text-[11px] text-muted-foreground">
			<span className="shrink-0">idle {formatSessionDuration(row.gap.durationMs)} · awaiting user</span>
			<span aria-hidden className="h-px flex-1 bg-border" />
			<button type="button" onClick={onToggle} className="shrink-0 hover:text-foreground">
				{row.collapsed ? "expand" : "collapse"}
			</button>
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

/** Inline meta, and never a second copy of what the span name already says. */
function spanMeta(span: AiSessionSpan, category: SpanCategory): string {
	const name = span.spanName.toLowerCase()
	const parts: string[] = []
	const agentName = span.genAi.agentName
	if (category === "agent" && agentName !== undefined && !name.includes(agentName.toLowerCase())) {
		parts.push(agentName)
	}
	const toolName = span.genAi.toolName
	if (category === "tool" && toolName !== undefined && !name.includes(toolName.toLowerCase())) {
		parts.push(toolName)
	}
	const ttftMs = spanTtftMs(span)
	if (ttftMs !== undefined) parts.push(`ttft ${formatDuration(ttftMs)}`)
	const reasoning = span.genAi.usageReasoningOutputTokens
	if (reasoning !== undefined && reasoning > 0) parts.push(`${formatNumber(reasoning)} reasoning`)
	if (span.statusMessage !== "") parts.push(span.statusMessage)
	return parts.join(" · ")
}

/**
 * The MODEL / TARGET cell: what the row adds to the span name.
 *
 * An agent span's target is the agent itself, which the name and the meta
 * already carry, so the column stays empty rather than printing the same word a
 * third time.
 */
function spanTarget(span: AiSessionSpan, category: SpanCategory, singleService: boolean): string | undefined {
	if (category === "agent") return undefined
	if (category === "tool") return toolTarget(span)
	const model = spanModel(span)
	if (model !== undefined) {
		return span.spanName.toLowerCase().includes(model.toLowerCase()) ? undefined : model
	}
	// The app's own spans borrow the column for the service that ran them, which
	// only says anything when the session crosses services.
	return span.isAiSpan || singleService ? undefined : span.serviceName
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
	const strings = Object.values(record).filter((value): value is string => typeof value === "string")
	return strings.length === 1 ? clipTarget(strings[0]!) : undefined
}

function clipTarget(value: string): string | undefined {
	const text = value.trim().replace(/\s+/g, " ")
	if (text.length === 0) return undefined
	return text.length > MAX_TARGET_LENGTH ? `${text.slice(0, MAX_TARGET_LENGTH - 1)}…` : text
}

function spanTokenSummary(span: AiSessionSpan): string {
	if (!isLlmCall(span)) return "—"
	const { genAi } = span
	const prompt =
		(genAi.usageInputTokens ?? 0) +
		(genAi.usageCacheReadInputTokens ?? 0) +
		(genAi.usageCacheCreationInputTokens ?? 0)
	const completion = (genAi.usageOutputTokens ?? 0) + (genAi.usageReasoningOutputTokens ?? 0)
	if (prompt === 0 && completion === 0) return "—"
	return `${formatNumber(prompt)} → ${formatNumber(completion)}`
}

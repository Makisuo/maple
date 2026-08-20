import { useMemo, useRef, useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"

import type { AiSessionSpan } from "@maple/domain/http"
import { ChevronDownIcon, ChevronRightIcon } from "@/components/icons"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { cn } from "@maple/ui/lib/utils"

import { buildSessionAxis, type SessionAxis } from "@/lib/agent-sessions/active-axis"
import { countSessionTokens, type IdleGap, type SessionSummary } from "@/lib/agent-sessions/session-summary"
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
import { CATEGORY_FILL } from "./span-visuals"

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

type WaterfallRow =
	| { readonly kind: "trace"; readonly key: string; readonly traceId: string; readonly turns: string; readonly timestamp: string }
	| { readonly kind: "turn"; readonly key: string; readonly turn: SessionTurn; readonly hiddenCount: number }
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
}

export function SessionWaterfall({
	turns,
	summary,
	query,
	agentSpansOnly,
	collapseIdle,
}: SessionWaterfallProps) {
	const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<string>>(() => new Set())
	const [expandedGaps, setExpandedGaps] = useState<ReadonlySet<string>>(() => new Set())
	const scrollRef = useRef<HTMLDivElement>(null)

	const spansById = useMemo(
		() => new Map(turns.flatMap((turn) => turn.spans).map((span) => [span.spanId, span])),
		[turns],
	)

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

	const rows = useMemo(
		() =>
			buildRows({
				turns,
				gaps: collapseIdle ? summary.idleGaps : [],
				expandedGaps,
				collapsedTurns,
				query: query.trim().toLowerCase(),
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

	const toggleTurn = (id: string) =>
		setCollapsedTurns((previous) => toggled(previous, id))
	const toggleGap = (id: string) => setExpandedGaps((previous) => toggled(previous, id))

	return (
		<div className="@container flex h-full min-h-0 flex-col">
			<div className="flex h-7 shrink-0 items-center border-border border-b px-2.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
				<span className={COL_SPAN}>Span</span>
				<span className={COL_MODEL}>Model / target</span>
				<span className={COL_TOKENS}>Tokens</span>
				<span className={cn(COL_AXIS, "flex items-center")}>
					{axis.ticks.map((tick, index) => (
						<span
							key={tick.axisMs}
							className={cn(
								// The ruler is a reading of the clock, not a column name —
								// the row's uppercase belongs to the headings alone.
								"absolute whitespace-nowrap normal-case tabular-nums",
								index === axis.ticks.length - 1 && "-translate-x-full",
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
											onToggle={() => toggleTurn(row.turn.id)}
										/>
									)}
									{row.kind === "span" && (
										<SpanRow row={row} axis={axis} spansById={spansById} />
									)}
									{row.kind === "gap" && (
										<GapRow row={row} onToggle={() => toggleGap(row.gap.id)} />
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
	const rows: WaterfallRow[] = []
	// Traces band the turns: a trace commonly holds several turns and a turn can
	// cross traces, so neither nests inside the other and the rule is drawn where
	// the trace changes.
	const bands = traceBands(input.turns)
	let gapIndex = 0
	let lastBand = -1

	input.turns.forEach((turn, index) => {
		while (gapIndex < input.gaps.length && input.gaps[gapIndex]!.startMs < turn.startMs) {
			const gap = input.gaps[gapIndex]!
			rows.push({
				kind: "gap",
				key: gap.id,
				gap,
				collapsed: !input.expandedGaps.has(gap.id),
			})
			gapIndex++
		}

		const visible = filterSpans(turn.spans, input.query, input.agentSpansOnly)
		// A turn whose every span was filtered out drops off the page entirely —
		// keeping an empty header would make the filter look broken. Its trace
		// rule moves to the trace's next surviving turn instead of dangling
		// above nothing.
		if (visible.length === 0) return

		const band = bands.byTurn[index]!
		if (band !== lastBand) {
			const range = bands.ranges[band]!
			rows.push({
				kind: "trace",
				key: `trace:${range.traceId}:${band}`,
				traceId: range.traceId,
				turns: range.from === range.to ? `turn ${range.from}` : `turns ${range.from}–${range.to}`,
				timestamp: turn.anchor.timestamp,
			})
			lastBand = band
		}

		rows.push({
			kind: "turn",
			key: turn.id,
			turn,
			hiddenCount: turn.spans.length - visible.length,
		})
		if (input.collapsedTurns.has(turn.id)) return
		for (const { span, depth } of orderByTree(visible)) {
			rows.push({ kind: "span", key: `${turn.id}:${span.spanId}`, span, depth })
		}
	})

	for (; gapIndex < input.gaps.length; gapIndex++) {
		const gap = input.gaps[gapIndex]!
		rows.push({ kind: "gap", key: gap.id, gap, collapsed: !input.expandedGaps.has(gap.id) })
	}

	return rows
}

/** Contiguous runs of turns sharing a primary trace; one rule row opens each band. */
function traceBands(turns: readonly SessionTurn[]): {
	byTurn: readonly number[]
	ranges: readonly { traceId: string; from: number; to: number }[]
} {
	const byTurn: number[] = []
	const ranges: { traceId: string; from: number; to: number }[] = []
	for (const turn of turns) {
		const traceId = turn.traceIds[0] ?? ""
		const open = ranges.at(-1)
		if (open === undefined || traceId !== open.traceId) {
			ranges.push({ traceId, from: turn.index, to: turn.index })
		} else {
			open.to = turn.index
		}
		byTurn.push(ranges.length - 1)
	}
	return { byTurn, ranges }
}

function filterSpans(
	spans: readonly AiSessionSpan[],
	query: string,
	agentSpansOnly: boolean,
): readonly AiSessionSpan[] {
	return spans.filter((span) => {
		if (agentSpansOnly && !span.isAiSpan) return false
		if (query === "") return true
		return [span.spanName, spanModel(span), span.genAi.toolName, span.genAi.agentName]
			.filter((value): value is string => value !== undefined)
			.some((value) => value.toLowerCase().includes(query))
	})
}

/** Depth-first over the parent chain, with anything whose parent was filtered
 *  out (or lives in another turn) promoted to the top level. */
function orderByTree(
	spans: readonly AiSessionSpan[],
): readonly { span: AiSessionSpan; depth: number }[] {
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

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
	const next = new Set(set)
	if (!next.delete(id)) next.add(id)
	return next
}

/* -------------------------------------------------------------------------- */
/* Row components                                                             */
/* -------------------------------------------------------------------------- */

function TraceRule({ row }: { row: Extract<WaterfallRow, { kind: "trace" }> }) {
	return (
		<div className="flex h-full items-center gap-3 px-2.5 text-[10px] text-muted-foreground uppercase tracking-wider">
			<Link
				to="/traces/$traceId"
				params={{ traceId: row.traceId }}
				search={{ t: row.timestamp }}
				className="shrink-0 font-mono hover:text-foreground"
			>
				Trace {row.traceId.slice(0, 8)}
			</Link>
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
	const tokens = countSessionTokens(turn.spans)
	const left = axis.fraction(turn.startMs) * 100
	const width = Math.max(0.4, (axis.fraction(turn.endMs) - axis.fraction(turn.startMs)) * 100)

	return (
		<button
			type="button"
			onClick={onToggle}
			className="flex h-full w-full items-center rounded-md bg-card px-2.5 text-left text-xs hover:bg-accent/40"
			aria-expanded={!collapsed}
		>
			<span className={COL_SPAN}>
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
				{turn.failed && <ErrorPill>Failed</ErrorPill>}
				{collapsed && (
					<span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground tabular-nums">
						{turn.spans.length - row.hiddenCount} spans
					</span>
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
			<span className={cn(COL_DUR, "text-muted-foreground")}>
				{formatSessionDuration(turn.durationMs)}
			</span>
		</button>
	)
}

function SpanRow({
	row,
	axis,
	spansById,
}: {
	row: Extract<WaterfallRow, { kind: "span" }>
	axis: SessionAxis
	spansById: ReadonlyMap<string, AiSessionSpan>
}) {
	const { span } = row
	const category = classifySpan(span)
	const errored = span.statusCode === "Error"
	const parent = spansById.get(span.parentSpanId)
	const isSubagent = category === "agent" && parent !== undefined && classifySpan(parent) === "agent"

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
				{errored && <ErrorPill>{span.genAi.errorType ?? "Error"}</ErrorPill>}
				{isSubagent && (
					<span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground uppercase tracking-wide">
						Subagent
					</span>
				)}
			</span>
			<span className={cn(COL_MODEL, errored && "text-destructive")}>
				{spanTarget(span, category) ?? "—"}
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

	return (
		<span
			className="absolute inset-y-0 my-auto h-1.5 overflow-hidden rounded-xs"
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
						category === "agent" && !errored && "opacity-70",
					)}
				/>
			)}
		</span>
	)
}

function GapRow({
	row,
	onToggle,
}: {
	row: Extract<WaterfallRow, { kind: "gap" }>
	onToggle: () => void
}) {
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

function ErrorPill({ children }: { children: ReactNode }) {
	return (
		<span className="shrink-0 rounded-full bg-destructive/12 px-1.5 py-px font-medium text-[10px] text-destructive uppercase tracking-wide">
			{children}
		</span>
	)
}

/* -------------------------------------------------------------------------- */
/* Cell content                                                               */
/* -------------------------------------------------------------------------- */

function spanMeta(span: AiSessionSpan, category: SpanCategory): string {
	const parts: string[] = []
	if (category === "agent" && span.genAi.agentName !== undefined) parts.push(span.genAi.agentName)
	if (category === "tool" && span.genAi.toolName !== undefined) parts.push(span.genAi.toolName)
	const ttftMs = spanTtftMs(span)
	if (ttftMs !== undefined) parts.push(`ttft ${formatDuration(ttftMs)}`)
	const reasoning = span.genAi.usageReasoningOutputTokens
	if (reasoning !== undefined && reasoning > 0) parts.push(`${formatNumber(reasoning)} reasoning`)
	if (span.statusMessage !== "") parts.push(span.statusMessage)
	return parts.join(" · ")
}

function spanTarget(span: AiSessionSpan, category: SpanCategory): string | undefined {
	if (category === "tool") return span.genAi.toolName
	if (category === "agent") return span.genAi.agentName
	return spanModel(span) ?? (span.isAiSpan ? undefined : span.serviceName)
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

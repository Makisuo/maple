import { useMemo } from "react"
import { Link } from "@tanstack/react-router"

import type { AiSessionSpan } from "@maple/domain/http"
import { MinusIcon, PlusIcon, SquareIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import {
	classifySpan,
	isLlmCall,
	spanEndMs,
	spanModel,
	spanStartMs,
	type SessionTurn,
	type SpanCategory,
} from "@/lib/agent-sessions/session-turns"
import { CATEGORY_FILL, CATEGORY_LABEL, filterSpans, isDelegation, shortTarget } from "./span-visuals"

// One lane per turn, laid out by hand. 612 spans in a single graph is a
// hairball, and a graph library to draw fixed-size boxes in columns would be a
// dependency doing arithmetic — so the positions are computed here and the
// edges are four SVG curves.
const NODE_WIDTH = 148
const NODE_HEIGHT = 52
const COLUMN_GAP = 48
const STACK_GAP = 10
const LANE_GAP = 40
const LANE_LABEL_WIDTH = 120
const CANVAS_PADDING = 20
/** A long turn wraps into a block instead of an 8,000px ribbon nobody scrolls. */
const MAX_COLUMNS = 8
const WRAP_GAP = 24

const MIN_ZOOM = 0.5
const MAX_ZOOM = 1.5
const ZOOM_STEP = 0.25

interface FlowNode {
	readonly key: string
	readonly span: AiSessionSpan
	readonly category: SpanCategory
	/** Full value; the card renders its last path segment. */
	readonly title: string
	readonly subtitle: string
	readonly errored: boolean
	/** Identical calls merged into one node, when "Merge repeat tools" is on. */
	readonly count: number
	readonly x: number
	readonly y: number
}

interface FlowLane {
	readonly turn: SessionTurn
	readonly nodes: readonly FlowNode[]
	/** Node index pairs to draw a connector between. */
	readonly edges: readonly (readonly [FlowNode, FlowNode])[]
	readonly height: number
}

interface SessionFlowProps {
	turns: readonly SessionTurn[]
	/** Collapse runs of identical calls into one `×N` node. Off by default —
	 *  merging hides the retry loop that is often the bug. */
	mergeRepeats: boolean
	/** The toolbar's filter, which applies to both views. */
	query: string
	agentSpansOnly: boolean
	zoom: number
	onZoomChange: (zoom: number) => void
}

export function SessionFlow({
	turns,
	mergeRepeats,
	query,
	agentSpansOnly,
	zoom,
	onZoomChange,
}: SessionFlowProps) {
	const lanes = useMemo(
		() => layoutLanes(turns, { mergeRepeats, query, agentSpansOnly }),
		[turns, mergeRepeats, query, agentSpansOnly],
	)

	const contentWidth =
		CANVAS_PADDING +
		Math.max(
			LANE_LABEL_WIDTH + NODE_WIDTH,
			...lanes.flatMap((lane) => lane.nodes.map((node) => node.x + NODE_WIDTH)),
		)
	const contentHeight =
		CANVAS_PADDING * 2 + lanes.reduce((total, lane) => total + lane.height + LANE_GAP, 0)

	return (
		<div className="relative h-full min-h-0">
			<div className="h-full overflow-auto">
				{lanes.length === 0 ? (
					<p className="px-2.5 py-8 text-center text-muted-foreground text-sm">
						No spans match this filter.
					</p>
				) : (
					<div
						style={{
							width: contentWidth * zoom,
							height: contentHeight * zoom,
						}}
					>
						<div
							className="relative"
							style={{
								width: contentWidth,
								height: contentHeight,
								transform: `scale(${zoom})`,
								transformOrigin: "top left",
							}}
						>
							{lanes.map((lane) => (
								<Lane key={lane.turn.id} lane={lane} />
							))}
						</div>
					</div>
				)}
			</div>

			<div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-3">
				<div className="pointer-events-auto flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-background/80 px-2 py-1 text-muted-foreground text-xs backdrop-blur-sm">
					{(["agent", "inference", "tool"] as const).map((category) => (
						<span key={category} className="flex items-center gap-1.5">
							<span
								aria-hidden
								className={cn("size-1.5 rounded-xs", CATEGORY_FILL[category])}
							/>
							{CATEGORY_LABEL[category]}
						</span>
					))}
					<span className="flex items-center gap-1.5">
						<span aria-hidden className="size-1.5 rounded-xs bg-destructive" />
						error
					</span>
				</div>
				<div className="pointer-events-auto flex items-center gap-1 rounded-md bg-background/80 p-0.5 backdrop-blur-sm">
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Zoom in"
						onClick={() => onZoomChange(Math.min(MAX_ZOOM, zoom + ZOOM_STEP))}
					>
						<PlusIcon size={14} />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Zoom out"
						onClick={() => onZoomChange(Math.max(MIN_ZOOM, zoom - ZOOM_STEP))}
					>
						<MinusIcon size={14} />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Reset zoom"
						onClick={() => onZoomChange(1)}
					>
						<SquareIcon size={14} />
					</Button>
				</div>
			</div>
		</div>
	)
}

function Lane({ lane }: { lane: FlowLane }) {
	return (
		<>
			<div
				className="absolute w-[110px] text-xs"
				style={{ left: CANVAS_PADDING, top: lane.nodes[0]!.y + 4 }}
			>
				<p className="font-medium text-[10px] text-primary uppercase tracking-wider">
					Turn {lane.turn.index}
				</p>
				<p
					className={cn(
						"tabular-nums",
						lane.turn.failed ? "text-destructive" : "text-muted-foreground",
					)}
				>
					{formatDuration(lane.turn.durationMs)}
				</p>
				{lane.turn.failed && <p className="text-destructive text-xs">failed</p>}
			</div>

			<svg
				aria-hidden
				className="pointer-events-none absolute inset-0 size-full overflow-visible"
				fill="none"
			>
				{lane.edges.map(([from, to]) => (
					<path
						key={`${from.key}->${to.key}`}
						d={edgePath(from, to)}
						className={to.errored ? "stroke-destructive/70" : "stroke-border"}
						strokeWidth={1}
					/>
				))}
			</svg>

			{lane.nodes.map((node) => (
				<FlowNodeCard key={node.key} node={node} />
			))}
		</>
	)
}

function FlowNodeCard({ node }: { node: FlowNode }) {
	return (
		<Link
			to="/traces/$traceId"
			params={{ traceId: node.span.traceId }}
			search={{ spanId: node.span.spanId, t: node.span.timestamp }}
			className={cn(
				"absolute flex flex-col justify-center gap-1 rounded-md border bg-card px-2.5 py-2 hover:border-ring",
				node.errored ? "border-destructive/60" : "border-border",
			)}
			style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
		>
			<span className="flex items-center gap-1.5">
				<span
					aria-hidden
					className={cn(
						"size-1.5 shrink-0 rounded-xs",
						node.errored ? "bg-destructive" : CATEGORY_FILL[node.category],
					)}
				/>
				<span className="min-w-0 truncate text-xs" title={node.title}>
					{shortTarget(node.title)}
				</span>
				{node.count > 1 && (
					<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
						×{node.count}
					</span>
				)}
			</span>
			<span
				className={cn(
					"truncate text-[11px]",
					node.errored ? "text-destructive" : "text-muted-foreground",
				)}
			>
				{node.subtitle}
			</span>
		</Link>
	)
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

function layoutLanes(
	turns: readonly SessionTurn[],
	options: { mergeRepeats: boolean; query: string; agentSpansOnly: boolean },
): readonly FlowLane[] {
	const lanes: FlowLane[] = []
	let laneTop = CANVAS_PADDING

	for (const turn of turns) {
		const spans = flowSpans(turn, options.query, options.agentSpansOnly)
		if (spans.length === 0) continue

		const groups = options.mergeRepeats ? mergeConsecutive(spans) : spans.map((span) => [span])
		const columns = assignColumns(groups, new Set(spans.map((span) => span.spanId)))

		// Columns wrap into rows within the lane, and a row is as tall as its
		// deepest stack.
		const rowHeights: number[] = []
		columns.forEach((column, index) => {
			const row = Math.floor(index / MAX_COLUMNS)
			const height = column.length * (NODE_HEIGHT + STACK_GAP) - STACK_GAP
			rowHeights[row] = Math.max(rowHeights[row] ?? 0, height)
		})
		const rowTops = rowHeights.map(
			(_, row) =>
				laneTop + rowHeights.slice(0, row).reduce((top, height) => top + height + WRAP_GAP, 0),
		)

		const nodes: FlowNode[] = []
		columns.forEach((column, columnIndex) => {
			column.forEach((group, stackIndex) => {
				const span = group[0]!
				nodes.push({
					key: span.spanId,
					span,
					category: classifySpan(span),
					title: nodeTitle(span),
					subtitle: nodeSubtitle(group),
					errored: group.some((member) => member.statusCode === "Error"),
					count: group.length,
					x:
						LANE_LABEL_WIDTH +
						CANVAS_PADDING +
						(columnIndex % MAX_COLUMNS) * (NODE_WIDTH + COLUMN_GAP),
					y:
						rowTops[Math.floor(columnIndex / MAX_COLUMNS)]! +
						stackIndex * (NODE_HEIGHT + STACK_GAP),
				})
			})
		})

		const edges: (readonly [FlowNode, FlowNode])[] = []
		for (let index = 1; index < columns.length; index++) {
			// A connector across a wrap would run backwards up the block; the rows
			// read in order the way lines of text do.
			if (Math.floor(index / MAX_COLUMNS) !== Math.floor((index - 1) / MAX_COLUMNS)) continue
			for (const from of nodesInColumn(nodes, columns, index - 1)) {
				for (const to of nodesInColumn(nodes, columns, index)) edges.push([from, to])
			}
		}

		const height =
			rowHeights.reduce((total, rowHeight) => total + rowHeight, 0) + (rowHeights.length - 1) * WRAP_GAP
		lanes.push({ turn, nodes, edges, height })
		laneTop += height + LANE_GAP
	}

	return lanes
}

/**
 * The spans worth a node: the turn's anchor, the leaf work (model calls and
 * tools), and real delegations.
 *
 * Frameworks wrap one model call in two or three spans — `invoke_agent` →
 * `call_llm` → `generate_content` — and drawing each of them turns a single call
 * into a chain of handoffs that never happened. The deepest span is the work;
 * everything above it is scaffolding.
 */
function flowSpans(turn: SessionTurn, query: string, agentSpansOnly: boolean): readonly AiSessionSpan[] {
	const spans = filterSpans(turn.spans, query, agentSpansOnly)
	const byId = new Map(spans.map((span) => [span.spanId, span]))

	const candidates = spans.filter((span) => {
		const category = classifySpan(span)
		if (category === "other") return false
		if (span.spanId === turn.anchor.spanId) return true
		return category === "agent" ? isDelegation(span, byId) : true
	})

	const wrappers = new Set<string>()
	for (const span of candidates) {
		const category = classifySpan(span)
		let parent = byId.get(span.parentSpanId)
		while (parent !== undefined) {
			if (classifySpan(parent) === category) wrappers.add(parent.spanId)
			parent = byId.get(parent.parentSpanId)
		}
	}

	// The anchor and the delegations are structural, so only leaf work can be a
	// wrapper of its own kind.
	return candidates.filter((span) => classifySpan(span) === "agent" || !wrappers.has(span.spanId))
}

function nodesInColumn(
	nodes: readonly FlowNode[],
	columns: readonly (readonly (readonly AiSessionSpan[])[])[],
	columnIndex: number,
): readonly FlowNode[] {
	const ids = new Set(columns[columnIndex]!.map((group) => group[0]!.spanId))
	return nodes.filter((node) => ids.has(node.key))
}

/** Runs of identical calls become one node. Only consecutive ones merge: two
 *  `read_file` calls either side of a model call are two steps, not one. */
function mergeConsecutive(spans: readonly AiSessionSpan[]): readonly (readonly AiSessionSpan[])[] {
	const groups: AiSessionSpan[][] = []
	for (const span of spans) {
		const current = groups[groups.length - 1]
		if (current !== undefined && mergeKey(current[0]!) === mergeKey(span)) current.push(span)
		else groups.push([span])
	}
	return groups
}

function mergeKey(span: AiSessionSpan): string {
	return `${classifySpan(span)}:${nodeTitle(span)}`
}

/**
 * Sequence the turn's work into columns.
 *
 * A group opens a new column unless it overlaps the one already open, in which
 * case it stacks beside it — that is what a parallel fan-out of tool calls looks
 * like in the data. Spans that contain other nodes (the agent invocation, a
 * delegated subagent) always take a column of their own: they overlap
 * everything by construction, and letting them absorb their own children would
 * collapse the whole turn into one column.
 */
function assignColumns(
	groups: readonly (readonly AiSessionSpan[])[],
	spanIds: ReadonlySet<string>,
): readonly (readonly (readonly AiSessionSpan[])[])[] {
	const parents = new Set(
		groups.flatMap((group) =>
			group[0]!.parentSpanId !== "" && spanIds.has(group[0]!.parentSpanId)
				? [group[0]!.parentSpanId]
				: [],
		),
	)

	const columns: (readonly AiSessionSpan[])[][] = []
	let openEndMs = Number.NEGATIVE_INFINITY
	let openIsContainer = true

	for (const group of groups) {
		const span = group[0]!
		const isContainer = parents.has(span.spanId)
		if (columns.length === 0 || isContainer || openIsContainer || spanStartMs(span) >= openEndMs) {
			columns.push([group])
			openEndMs = spanEndMs(group[group.length - 1]!)
			openIsContainer = isContainer
		} else {
			columns[columns.length - 1]!.push(group)
			openEndMs = Math.max(openEndMs, spanEndMs(group[group.length - 1]!))
		}
	}

	return columns
}

function edgePath(from: FlowNode, to: FlowNode): string {
	const x1 = from.x + NODE_WIDTH
	const y1 = from.y + NODE_HEIGHT / 2
	const x2 = to.x
	const y2 = to.y + NODE_HEIGHT / 2
	const bend = Math.max(16, (x2 - x1) / 2)
	return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}

function nodeTitle(span: AiSessionSpan): string {
	return span.genAi.toolName ?? span.spanName
}

function nodeSubtitle(group: readonly AiSessionSpan[]): string {
	const span = group[0]!
	const durationMs = group.reduce((total, member) => total + member.durationMs, 0)
	const parts: string[] = []

	if (span.statusCode === "Error") {
		parts.push(span.genAi.errorType ?? (span.statusMessage === "" ? "error" : span.statusMessage))
	} else if (isLlmCall(span)) {
		const prompt =
			(span.genAi.usageInputTokens ?? 0) +
			(span.genAi.usageCacheReadInputTokens ?? 0) +
			(span.genAi.usageCacheCreationInputTokens ?? 0)
		const completion = (span.genAi.usageOutputTokens ?? 0) + (span.genAi.usageReasoningOutputTokens ?? 0)
		if (prompt > 0 || completion > 0) {
			parts.push(`${formatNumber(prompt)} → ${formatNumber(completion)}`)
		} else {
			const model = spanModel(span)
			if (model !== undefined) parts.push(shortTarget(model))
		}
	} else if (span.genAi.agentName !== undefined) {
		parts.push(span.genAi.agentName)
	}

	parts.push(formatDuration(durationMs))
	return parts.filter((part) => part !== "").join(" · ")
}

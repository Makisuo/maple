import { useMemo, useRef } from "react"

import type { AiSessionSpan } from "@maple/domain/http"
import { MaximizeIcon, MinusIcon, PlusIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { useListNavigation } from "@/hooks/use-list-navigation"
import { spanTokenBuckets } from "@/lib/agent-sessions/session-summary"
import {
	classifyAiSpan,
	isLlmCall,
	spanEndMs,
	spanModel,
	spanStartMs,
	type SessionTurn,
	type AiSpanCategory,
} from "@/lib/agent-sessions/session-turns"
import { filterSpans, isDelegation, shortTarget } from "@/lib/agent-sessions/span-filters"
import { SpanDrawer } from "./span-expansion"
import { CATEGORY_FILL } from "./span-visuals"

// One lane per turn, positioned by hand. (`investigations/flow` already wraps
// `@xyflow/react` around hand-computed positions for the same job; moving this
// view onto it is a rewrite rather than a patch, so it has not been done.)
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
	readonly category: AiSpanCategory
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
	/** Parent/child node pairs to draw a connector between. */
	readonly edges: readonly (readonly [FlowNode, FlowNode])[]
	readonly height: number
}

/** The lanes plus the box they need, measured once while they are built. */
interface FlowLayout {
	readonly lanes: readonly FlowLane[]
	readonly width: number
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
	/** The one span open in the docked drawer (`?span=`). */
	selectedSpanId: string | undefined
	/** Raised with a span id to open the drawer, `undefined` to close it. */
	onSelectSpan: (spanId: string | undefined) => void
	/** The drawer's "Open in Trace view": same span, sibling view. */
	onOpenTraceView: () => void
}

export function SessionFlow({
	turns,
	mergeRepeats,
	query,
	agentSpansOnly,
	zoom,
	onZoomChange,
	selectedSpanId,
	onSelectSpan,
	onOpenTraceView,
}: SessionFlowProps) {
	const { lanes, width, height } = useMemo(
		() => layoutLanes(turns, { mergeRepeats, query, agentSpansOnly }),
		[turns, mergeRepeats, query, agentSpansOnly],
	)
	const canvasRef = useRef<HTMLDivElement>(null)

	// Selection addresses spans the same way in both views, so a span expanded
	// in the Trace view opens here even when the flow drew no node for it (a
	// wrapper, or a span the filter hides).
	const selectedSpan = useMemo(() => {
		if (selectedSpanId === undefined) return undefined
		for (const turn of turns) {
			const span = turn.spans.find((candidate) => candidate.spanId === selectedSpanId)
			if (span !== undefined) return { span, turn }
		}
		return undefined
	}, [turns, selectedSpanId])

	// The keyboard's span cursor, over the nodes in reading order — lane by
	// lane, column by column, exactly as they draw.
	const nodeSpanIds = useMemo(
		() => lanes.flatMap((lane) => lane.nodes.map((node) => node.span.spanId)),
		[lanes],
	)
	const { focusedId, setFocusedId } = useListNavigation({
		ids: nodeSpanIds,
		onOpen: (spanId) => onSelectSpan(spanId),
		onEscape: () => {
			if (selectedSpanId === undefined) return false
			onSelectSpan(undefined)
			return true
		},
		scrollTo: (spanId) => {
			canvasRef.current
				?.querySelector(`[data-span-id="${spanId}"]`)
				?.scrollIntoView({ block: "nearest", inline: "nearest" })
		},
	})

	return (
		// Vertical growth belongs to the page's own scroller; only the canvas's
		// width overflows here, so a wide session pans sideways in place. The
		// column grows so the floor block below can pin to the viewport's bottom
		// even under a short canvas.
		<div className="relative flex grow flex-col">
			<div ref={canvasRef} className="grow overflow-x-auto">
				{lanes.length === 0 ? (
					<p className="px-2.5 py-8 text-center text-muted-foreground text-sm">
						No spans match this filter.
					</p>
				) : (
					<div style={{ width: width * zoom, height: height * zoom }}>
						<div
							className="relative"
							style={{
								width,
								height,
								transform: `scale(${zoom})`,
								transformOrigin: "top left",
							}}
						>
							{lanes.map((lane) => (
								<Lane
									key={lane.turn.id}
									lane={lane}
									selectedSpanId={selectedSpanId}
									focusedSpanId={focusedId ?? undefined}
									onSelectNode={(spanId) => {
										setFocusedId(spanId)
										onSelectSpan(selectedSpanId === spanId ? undefined : spanId)
									}}
								/>
							))}
						</div>
					</div>
				)}
			</div>

			{/* The view's floor, pinned to the viewport's bottom edge: the legend
			    and zoom on top, and under them the docked drawer when a span is
			    open. Sticky rather than absolute so a canvas taller than the
			    viewport still keeps them on screen. Guarded, because there is
			    nothing to key, zoom or open when the filter emptied the canvas. */}
			{lanes.length > 0 && (
				<div className="sticky bottom-0 z-10 mt-auto flex flex-col">
					<div className="pointer-events-none flex items-end justify-between gap-4 p-3">
						<div className="pointer-events-auto flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-background/80 px-2 py-1 text-muted-foreground text-xs backdrop-blur-sm">
							{(["agent", "inference", "tool"] as const).map((category) => (
								<span key={category} className="flex items-center gap-1.5">
									<span
										aria-hidden
										className={cn("size-1.5 rounded-xs", CATEGORY_FILL[category])}
									/>
									{category}
								</span>
							))}
							<span className="flex items-center gap-1.5">
								<span aria-hidden className="size-1.5 rounded-xs bg-destructive" />
								error
							</span>
						</div>
						<div className="pointer-events-auto flex items-center gap-1 rounded-md bg-background/80 p-0.5 backdrop-blur-sm">
							{/* In, out, reset — the order and the reset glyph the repo's other
						    canvas already uses (`investigations/flow/provenance-canvas.tsx`).
						    Disabled at the bounds, because clamping silently meant the third
						    click at 1.5x did nothing with no way to tell that from a dead
						    button. */}
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Zoom in"
								disabled={zoom >= MAX_ZOOM}
								onClick={() => onZoomChange(Math.min(MAX_ZOOM, zoom + ZOOM_STEP))}
							>
								<PlusIcon size={14} />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Zoom out"
								disabled={zoom <= MIN_ZOOM}
								onClick={() => onZoomChange(Math.max(MIN_ZOOM, zoom - ZOOM_STEP))}
							>
								<MinusIcon size={14} />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Reset zoom"
								disabled={zoom === 1}
								onClick={() => onZoomChange(1)}
							>
								<MaximizeIcon size={14} />
							</Button>
						</div>
					</div>

					{selectedSpan !== undefined && (
						<SpanDrawer
							span={selectedSpan.span}
							turnOrdinal={turnOrdinal(selectedSpan.turn)}
							onClose={() => onSelectSpan(undefined)}
							onOpenTraceView={onOpenTraceView}
						/>
					)}
				</div>
			)}
		</div>
	)
}

/** The same wording the waterfall's headers use for the fallback partition. */
function turnOrdinal(turn: SessionTurn): string {
	return `${turn.anchorKind === "trace" ? "Segment" : "Turn"} ${turn.index}`
}

function Lane({
	lane,
	selectedSpanId,
	focusedSpanId,
	onSelectNode,
}: {
	lane: FlowLane
	selectedSpanId: string | undefined
	focusedSpanId: string | undefined
	onSelectNode: (spanId: string) => void
}) {
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

			{/* One neutral stroke for every connector: the curve says "this ran inside
			    that", which is not itself an outcome. Colouring it by either end read
			    as a handoff that failed, and the node cards already carry the red. */}
			<svg
				aria-hidden
				data-slot="flow-edges"
				className="pointer-events-none absolute inset-0 size-full overflow-visible"
				fill="none"
			>
				{lane.edges.map(([from, to]) => (
					<path
						key={`${from.key}->${to.key}`}
						d={edgePath(from, to)}
						className="stroke-border"
						strokeWidth={1}
					/>
				))}
			</svg>

			{lane.nodes.map((node) => (
				<FlowNodeCard
					key={node.key}
					node={node}
					selected={selectedSpanId === node.span.spanId}
					focused={focusedSpanId === node.span.spanId}
					onClick={() => onSelectNode(node.span.spanId)}
				/>
			))}
		</>
	)
}

function FlowNodeCard({
	node,
	selected,
	focused,
	onClick,
}: {
	node: FlowNode
	selected: boolean
	/** Under the keyboard's span cursor — distinct from `selected`, the open drawer. */
	focused: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			data-span-id={node.span.spanId}
			aria-current={selected || undefined}
			className={cn(
				"absolute flex cursor-pointer flex-col justify-center gap-1 rounded-md border bg-card px-2.5 py-2 text-left hover:border-ring",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				node.errored ? "border-destructive/60" : "border-border",
				focused && "border-ring",
				// Selection is a state and hover is a pointer, so they cannot share a
				// token: the waterfall marks its selected row with primary, and the
				// node card takes the same direction.
				selected && "border-primary bg-primary/5",
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
		</button>
	)
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

/** One node's worth of spans — a single span, or a merged run of identical
 *  calls — under the nearest span above them that also earned a node. */
interface FlowGroup {
	readonly spans: readonly AiSessionSpan[]
	/** `undefined` when nothing above them survived: a root of the lane. */
	readonly parentSpanId: string | undefined
}

function layoutLanes(
	turns: readonly SessionTurn[],
	options: { mergeRepeats: boolean; query: string; agentSpansOnly: boolean },
): FlowLayout {
	const lanes: FlowLane[] = []
	let laneTop = CANVAS_PADDING
	let contentRight = LANE_LABEL_WIDTH + NODE_WIDTH

	for (const turn of turns) {
		const spans = flowSpans(turn, options.query, options.agentSpansOnly)
		if (spans.length === 0) continue

		const groups = options.mergeRepeats ? mergeConsecutive(spans) : spans
		const columns = assignColumns(groups)

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
		// Every member id, not just the group's first: a child looks its parent up
		// by span id and that parent may have been merged into a `×N` node.
		const placed = new Map<string, { node: FlowNode; column: number }>()

		columns.forEach((column, columnIndex) => {
			column.forEach((group, stackIndex) => {
				// One member speaks for the group — the failure when there is one — so
				// the red border, the red dot and the error text all describe the same
				// call, and clicking opens it.
				const lead = group.spans.find((member) => member.statusCode === "Error") ?? group.spans[0]!
				const node: FlowNode = {
					key: lead.spanId,
					span: lead,
					category: classifyAiSpan(lead),
					title: nodeTitle(lead),
					subtitle: nodeSubtitle(lead, group.spans),
					errored: lead.statusCode === "Error",
					count: group.spans.length,
					x:
						LANE_LABEL_WIDTH +
						CANVAS_PADDING +
						(columnIndex % MAX_COLUMNS) * (NODE_WIDTH + COLUMN_GAP),
					y:
						rowTops[Math.floor(columnIndex / MAX_COLUMNS)]! +
						stackIndex * (NODE_HEIGHT + STACK_GAP),
				}
				nodes.push(node)
				contentRight = Math.max(contentRight, node.x + NODE_WIDTH)
				for (const member of group.spans) placed.set(member.spanId, { node, column: columnIndex })
			})
		})

		// Connectors are the parent relation, so a curve means "this ran inside
		// that" — the one handoff the span tree actually records. Adjacent columns
		// are a layout fact, and a turn can span several traces, so drawing every
		// column-to-column pair invented handoffs between unrelated spans.
		const edges: (readonly [FlowNode, FlowNode])[] = []
		for (const group of groups) {
			if (group.parentSpanId === undefined) continue
			const from = placed.get(group.parentSpanId)
			const to = placed.get(group.spans[0]!.spanId)
			if (from === undefined || to === undefined || to.column <= from.column) continue
			// A connector across a wrap would run backwards up the block; the rows
			// read in order the way lines of text do.
			if (Math.floor(from.column / MAX_COLUMNS) !== Math.floor(to.column / MAX_COLUMNS)) continue
			edges.push([from.node, to.node])
		}

		const height =
			rowHeights.reduce((total, rowHeight) => total + rowHeight, 0) + (rowHeights.length - 1) * WRAP_GAP
		lanes.push({ turn, nodes, edges, height })
		laneTop += height + LANE_GAP
	}

	return {
		lanes,
		width: CANVAS_PADDING + contentRight,
		height: CANVAS_PADDING * 2 + lanes.reduce((total, lane) => total + lane.height + LANE_GAP, 0),
	}
}

/**
 * The spans worth a node, each carrying the nearest span above it that also
 * earned one: the turn's anchor, the leaf work (model calls and tools), and real
 * delegations.
 *
 * Frameworks wrap one model call in two or three spans — `invoke_agent` →
 * `call_llm` → `generate_content` — and drawing each of them turns a single call
 * into a chain of handoffs that never happened. The deepest span is the work;
 * everything above it is scaffolding.
 *
 * Structure is read from the turn's whole span tree and never from what survived:
 * a dropped wrapper must not orphan the leaf under it, and a term typed into the
 * toolbar must not turn a delegation into a plain step.
 */
function flowSpans(turn: SessionTurn, query: string, agentSpansOnly: boolean): readonly FlowGroup[] {
	const byId = new Map(turn.spans.map((span) => [span.spanId, span]))
	const visible = filterSpans(turn.spans, query, agentSpansOnly)

	const candidates = visible.filter((span) => {
		const category = classifyAiSpan(span)
		if (category === "other") return false
		if (span.spanId === turn.anchor.spanId) return true
		return category === "agent" ? isDelegation(span, byId) : true
	})

	const wrappers = new Set<string>()
	for (const span of candidates) {
		const category = classifyAiSpan(span)
		for (const ancestor of ancestors(span, byId)) {
			if (classifyAiSpan(ancestor) === category) wrappers.add(ancestor.spanId)
		}
	}

	// The anchor and the delegations are structural, so only leaf work can be a
	// wrapper of its own kind.
	const survivors = candidates.filter(
		(span) => classifyAiSpan(span) === "agent" || !wrappers.has(span.spanId),
	)
	const surviving = new Set(survivors.map((span) => span.spanId))

	return survivors.map((span) => ({
		spans: [span],
		parentSpanId: ancestors(span, byId).find((ancestor) => surviving.has(ancestor.spanId))?.spanId,
	}))
}

/** Every span above this one, nearest first. The `seen` set is for malformed
 *  data: a parent cycle would otherwise walk forever. */
function ancestors(span: AiSessionSpan, byId: ReadonlyMap<string, AiSessionSpan>): readonly AiSessionSpan[] {
	const chain: AiSessionSpan[] = []
	const seen = new Set<string>([span.spanId])
	let parent = byId.get(span.parentSpanId)
	while (parent !== undefined && !seen.has(parent.spanId)) {
		seen.add(parent.spanId)
		chain.push(parent)
		parent = byId.get(parent.parentSpanId)
	}
	return chain
}

/** Runs of identical calls become one node. Only consecutive ones under the same
 *  parent merge: two `read_file` calls either side of a model call are two
 *  steps, not one. */
function mergeConsecutive(groups: readonly FlowGroup[]): readonly FlowGroup[] {
	const merged: { spans: AiSessionSpan[]; parentSpanId: string | undefined }[] = []
	for (const group of groups) {
		const current = merged[merged.length - 1]
		if (
			current !== undefined &&
			current.parentSpanId === group.parentSpanId &&
			mergeKey(current.spans[0]!) === mergeKey(group.spans[0]!)
		) {
			current.spans.push(...group.spans)
		} else {
			merged.push({ spans: [...group.spans], parentSpanId: group.parentSpanId })
		}
	}
	return merged
}

function mergeKey(span: AiSessionSpan): string {
	return `${classifyAiSpan(span)}:${nodeTitle(span)}`
}

/**
 * Sequence the turn's work into columns, from the parent relation rather than
 * from overlap alone.
 *
 * A group takes the column after the one its parent landed in: the anchor holds
 * column 0, the work it dispatched follows it, and a delegated subagent's own
 * calls follow the delegation. Siblings that overlap in time share a column —
 * that is what a parallel fan-out of tool calls looks like in the data — while
 * sequential siblings take successive columns, past whatever the previous
 * sibling's own children used.
 *
 * `groups` is in start order, so a parent is placed before its children and one
 * pass is enough.
 */
function assignColumns(groups: readonly FlowGroup[]): readonly (readonly FlowGroup[])[] {
	const indexById = new Map<string, number>()
	groups.forEach((group, index) => {
		for (const member of group.spans) indexById.set(member.spanId, index)
	})

	// The column each parent is currently filling, and how far into the turn the
	// work already in it runs. `-1` keys the lane's roots.
	const open = new Map<number, { column: number; endMs: number }>()
	const columns: FlowGroup[][] = []

	for (const group of groups) {
		const parent = group.parentSpanId === undefined ? -1 : (indexById.get(group.parentSpanId) ?? -1)
		const sibling = open.get(parent)
		if (sibling !== undefined && groupStartMs(group) < sibling.endMs) {
			columns[sibling.column]!.push(group)
			sibling.endMs = Math.max(sibling.endMs, groupEndMs(group))
		} else {
			open.set(parent, { column: columns.length, endMs: groupEndMs(group) })
			columns.push([group])
		}
	}

	return columns
}

function groupStartMs(group: FlowGroup): number {
	return spanStartMs(group.spans[0]!)
}

function groupEndMs(group: FlowGroup): number {
	return Math.max(...group.spans.map(spanEndMs))
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

function nodeSubtitle(lead: AiSessionSpan, group: readonly AiSessionSpan[]): string {
	const parts: string[] = []

	if (lead.statusCode === "Error") {
		const errorType = lead.genAi.errorType
		if (errorType !== undefined && errorType !== "") parts.push(errorType)
		else parts.push(lead.statusMessage === "" ? "error" : lead.statusMessage)
	} else if (isLlmCall(lead)) {
		const tokens = spanTokenBuckets(lead)
		if (tokens !== undefined && tokens.total > 0) {
			// The prompt half is the residual of the total, not a sum of the input
			// buckets: whether the cache counts inside `input` or beside it is the
			// provider's convention, and the total already applied it.
			const completion = tokens.output + tokens.reasoning
			parts.push(`${formatNumber(tokens.total - completion)} → ${formatNumber(completion)}`)
		} else {
			const model = spanModel(lead)
			if (model !== undefined) parts.push(shortTarget(model))
		}
	} else if (lead.genAi.agentName !== undefined) {
		parts.push(lead.genAi.agentName)
	}

	// The wall clock the group occupied, not the sum of its parts: three parallel
	// 400ms calls took 400ms, and a merged node that printed 1.2s would be
	// reporting time that never elapsed.
	parts.push(formatDuration(Math.max(...group.map(spanEndMs)) - Math.min(...group.map(spanStartMs))))

	const failed = group.filter((member) => member.statusCode === "Error").length
	if (group.length > 1 && failed > 0) parts.push(`${failed} failed`)

	return parts.join(" · ")
}

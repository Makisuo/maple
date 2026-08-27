import { memo, useMemo, useRef } from "react"
import {
	Handle,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useReactFlow,
	type CoordinateExtent,
	type Edge,
	type Node,
	type NodeProps,
	type ReactFlowInstance,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import type { AiSessionSpan } from "@maple/domain/http"
import { CircleXmarkIcon, MaximizeIcon, MinusIcon, PlusIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { useListNavigation } from "@/hooks/use-list-navigation"
import { spanTokenBuckets } from "@/lib/agent-sessions/session-summary"
import {
	classifyAiSpan,
	isLlmCall,
	spanEndMs,
	spanFailed,
	spanModel,
	spanStartMs,
	type SessionTurn,
	type AiSpanCategory,
} from "@/lib/agent-sessions/session-turns"
import { filterSpans, isDelegation, shortTarget } from "@/lib/agent-sessions/span-filters"
import { SpanDrawer, type SpanDetailTab } from "./span-expansion"
import { CATEGORY_ICON, CATEGORY_TEXT } from "./span-visuals"

// One lane per turn, positioned by hand and handed to `@xyflow/react` — the
// same division of labour as `investigations/flow/provenance-canvas.tsx`: the
// grid arithmetic below owns where everything sits, and xyflow is here for
// pan, zoom and the edge rendering, not for layout.
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
/** How far past the graph the canvas can be panned. Roughly half a viewport:
 *  enough to pull any node clear of the floor's legend and drawer, while a
 *  fling can never strand the reader on empty canvas with no node in sight. */
const PAN_MARGIN = 400

/** Where the hidden ports sit on every card, mirrored by `Ports` below. */
const STEP_HANDLES: NonNullable<Node["handles"]> = [
	{ type: "target", position: Position.Left, x: 0, y: NODE_HEIGHT / 2, width: 1, height: 1 },
	{ type: "source", position: Position.Right, x: NODE_WIDTH, y: NODE_HEIGHT / 2, width: 1, height: 1 },
]

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
	/** The drawer's tab, shared with the Traces view's inline expansion. */
	spanTab: SpanDetailTab | undefined
	onSpanTabChange: (tab: SpanDetailTab) => void
	/** The session's captured tool results by call id, for the drawer. */
	toolResults?: ReadonlyMap<string, string>
	/** The drawer's "Open in Traces view": same span, sibling view. */
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
	spanTab,
	onSpanTabChange,
	toolResults,
	onOpenTraceView,
}: SessionFlowProps) {
	const lanes = useMemo(
		() => layoutLanes(turns, { mergeRepeats, query, agentSpansOnly }),
		[turns, mergeRepeats, query, agentSpansOnly],
	)
	const paneRef = useRef<HTMLDivElement>(null)
	const instanceRef = useRef<ReactFlowInstance<Node, Edge> | null>(null)

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

	const nodeBySpanId = useMemo(() => {
		const byId = new Map<string, FlowNode>()
		for (const lane of lanes) for (const node of lane.nodes) byId.set(node.span.spanId, node)
		return byId
	}, [lanes])

	// Panning stays within a margin of the graph itself — the default extent is
	// infinite, and a stray fling could park the reader on blank canvas with no
	// way to tell which direction the session went.
	const translateExtent = useMemo<CoordinateExtent>(() => {
		let maxX = 0
		let maxY = 0
		for (const lane of lanes) {
			for (const node of lane.nodes) {
				maxX = Math.max(maxX, node.x + NODE_WIDTH)
				maxY = Math.max(maxY, node.y + NODE_HEIGHT)
			}
		}
		return [
			[-PAN_MARGIN, -PAN_MARGIN],
			[maxX + PAN_MARGIN, maxY + PAN_MARGIN],
		]
	}, [lanes])

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
		// The nodes live inside xyflow's transformed pane, where scrollIntoView
		// does nothing — the cursor moves the viewport instead, and only when it
		// has to: recentring on every keypress would yank the canvas around.
		scrollTo: (spanId) => {
			const instance = instanceRef.current
			const pane = paneRef.current
			const node = nodeBySpanId.get(spanId)
			if (instance === null || pane === null || node === undefined) return
			const viewport = instance.getViewport()
			const left = node.x * viewport.zoom + viewport.x
			const top = node.y * viewport.zoom + viewport.y
			const inView =
				left >= 0 &&
				top >= 0 &&
				left + NODE_WIDTH * viewport.zoom <= pane.clientWidth &&
				top + NODE_HEIGHT * viewport.zoom <= pane.clientHeight
			if (inView) return
			void instance.setCenter(node.x + NODE_WIDTH / 2, node.y + NODE_HEIGHT / 2, {
				zoom: viewport.zoom,
				duration: 200,
			})
		},
	})

	const flowNodes = useMemo<Node[]>(
		() =>
			lanes.flatMap((lane): Node[] => [
				{
					id: `lane:${lane.turn.id}`,
					type: "laneLabel",
					position: { x: CANVAS_PADDING, y: lane.nodes[0]!.y + 4 },
					data: {
						index: lane.turn.index,
						durationMs: lane.turn.durationMs,
						failed: lane.turn.failed,
					} satisfies LaneLabelData,
					draggable: false,
					selectable: false,
					connectable: false,
				},
				...lane.nodes.map(
					(node): Node => ({
						id: node.key,
						type: "step",
						position: { x: node.x, y: node.y },
						width: NODE_WIDTH,
						height: NODE_HEIGHT,
						// Declared, not measured: with the dimensions and handle spots
						// known up front (every card is the same box), xyflow can draw
						// the edges on the very first frame instead of waiting for a
						// ResizeObserver pass — which also never comes under jsdom.
						handles: STEP_HANDLES,
						data: {
							node,
							selected: selectedSpanId === node.span.spanId,
							focused: focusedId === node.span.spanId,
							onSelect: (spanId: string) => {
								setFocusedId(spanId)
								onSelectSpan(selectedSpanId === spanId ? undefined : spanId)
							},
						} satisfies StepData,
						draggable: false,
						selectable: false,
						connectable: false,
						/*
						 * Load-bearing, from `investigations/flow`: xyflow derives
						 * pointer-events from selectable/draggable/click handlers and sets
						 * `none` when all are off — which would make the card's button inert.
						 */
						style: { pointerEvents: "all" },
					}),
				),
			]),
		[lanes, selectedSpanId, focusedId, setFocusedId, onSelectSpan],
	)

	// One neutral stroke for every connector: the line says "this ran inside
	// that", which is not itself an outcome. Colouring it by either end read
	// as a handoff that failed, and the node cards already carry the red.
	//
	// `step`, not the default bezier: the cards sit on a grid of rows and
	// columns, and a curve leaving one row for the next crosses it diagonally —
	// two right angles trace the same relation along the grid the cards are
	// already on.
	const flowEdges = useMemo<Edge[]>(
		() =>
			lanes.flatMap((lane) =>
				lane.edges.map(
					([from, to]): Edge => ({
						id: `${from.key}->${to.key}`,
						source: from.key,
						target: to.key,
						type: "step",
						focusable: false,
						// Dotted, not solid: a hairline in `--border` disappeared against
						// the card borders it runs between. Round caps on a 2px stroke
						// give round dots — legible at the zoom the canvas opens at,
						// and still quiet enough to stay behind the cards.
						style: {
							stroke: "var(--muted-foreground)",
							strokeWidth: 2,
							strokeLinecap: "round",
							strokeDasharray: "0.5 5",
						},
					}),
				),
			),
		[lanes],
	)

	return (
		<ReactFlowProvider>
			{/* The canvas takes whatever height the viewport leaves it (the page
			    column fills the scroller), and xyflow owns panning inside it; the
			    floor block below stays a sibling so the drawer can dock under the
			    canvas rather than float over it. */}
			<div className="relative flex grow flex-col">
				{lanes.length === 0 ? (
					<p className="px-2.5 py-8 text-center text-muted-foreground text-sm">
						No spans match this filter.
					</p>
				) : (
					<div ref={paneRef} className="relative min-h-48 grow">
						<ReactFlow
							nodes={flowNodes}
							edges={flowEdges}
							nodeTypes={nodeTypes}
							onInit={(instance) => {
								instanceRef.current = instance
							}}
							// The zoom survives a Trace ↔ Flow round trip through the
							// parent's state; xyflow owns it while the view is mounted.
							defaultViewport={{ x: 0, y: 0, zoom }}
							onMoveEnd={(_, viewport) => {
								if (viewport.zoom !== zoom) onZoomChange(viewport.zoom)
							}}
							minZoom={MIN_ZOOM}
							maxZoom={MAX_ZOOM}
							translateExtent={translateExtent}
							nodesDraggable={false}
							nodesConnectable={false}
							nodesFocusable={false}
							edgesFocusable={false}
							elementsSelectable={false}
							connectOnClick={false}
							// The wheel pans rather than zooms: the canvas fills the
							// viewport here, and a wheel that zooms traps the reader the
							// moment they reach for scroll. Zoom is the buttons and pinch.
							panOnScroll
							zoomOnScroll={false}
							zoomOnDoubleClick={false}
							proOptions={{ hideAttribution: true }}
							aria-label="Session flow graph"
						/>
					</div>
				)}

				{/* The view's floor, pinned to the viewport's bottom edge: the legend
				    and zoom on top, and under them the docked drawer when a span is
				    open. Sticky rather than absolute so a page grown past the
				    viewport (a tall drawer) still keeps them on screen. Guarded,
				    because there is nothing to key, zoom or open when the filter
				    emptied the canvas. */}
				{lanes.length > 0 && (
					<div className="sticky bottom-0 z-10 mt-auto flex flex-col">
						<div className="pointer-events-none flex items-end justify-between gap-4 p-3">
							<div className="pointer-events-auto flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-background/80 px-2 py-1 text-muted-foreground text-xs backdrop-blur-sm">
								{(["agent", "inference", "tool"] as const).map((category) => {
									const Icon = CATEGORY_ICON[category]
									return (
										<span key={category} className="flex items-center gap-1.5">
											<Icon
												size={12}
												className={cn("shrink-0", CATEGORY_TEXT[category])}
											/>
											{category}
										</span>
									)
								})}
								<span className="flex items-center gap-1.5">
									<CircleXmarkIcon size={12} className="shrink-0 text-destructive" />
									error
								</span>
							</div>
							<FlowControls zoom={zoom} />
						</div>

						{selectedSpan !== undefined && (
							<SpanDrawer
								span={selectedSpan.span}
								turnOrdinal={turnOrdinal(selectedSpan.turn)}
								tab={spanTab}
								onTabChange={onSpanTabChange}
								toolResults={toolResults}
								onClose={() => onSelectSpan(undefined)}
								onOpenTraceView={onOpenTraceView}
							/>
						)}
					</div>
				)}
			</div>
		</ReactFlowProvider>
	)
}

/** The same wording the waterfall's headers use for the fallback partition. */
function turnOrdinal(turn: SessionTurn): string {
	return `${turn.anchorKind === "trace" ? "Segment" : "Turn"} ${turn.index}`
}

/**
 * In, out, fit — the order and glyphs the repo's other canvas already uses
 * (`investigations/flow/provenance-canvas.tsx`). The zoom buttons disable at
 * the bounds, because clamping silently meant the third click at 1.5x did
 * nothing with no way to tell that from a dead button; fit is always live.
 */
function FlowControls({ zoom }: { zoom: number }) {
	const flow = useReactFlow()

	return (
		<div className="pointer-events-auto flex items-center gap-1 rounded-md bg-background/80 p-0.5 backdrop-blur-sm">
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Zoom in"
				disabled={zoom >= MAX_ZOOM}
				onClick={() => void flow.zoomIn()}
			>
				<PlusIcon size={14} />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Zoom out"
				disabled={zoom <= MIN_ZOOM}
				onClick={() => void flow.zoomOut()}
			>
				<MinusIcon size={14} />
			</Button>
			{/* A deliberate reset rather than `fitView`: fit clamps against the
			    0.5 floor on any real session and lands somewhere unpredictable,
			    while "top of the session at 1:1" is the one place the reader can
			    always name. (`fitView` also queues behind the flow's own render
			    when called from outside it, and this button lives in the floor.) */}
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Reset view"
				onClick={() => void flow.setViewport({ x: 0, y: 0, zoom: 1 })}
			>
				<MaximizeIcon size={14} />
			</Button>
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Nodes                                                                      */
/* -------------------------------------------------------------------------- */

/** Both handles are hidden — the graph is read-only, nothing connects by hand. */
const HANDLE = "!size-0 !min-h-0 !min-w-0 !border-0 !bg-transparent"

function Ports() {
	return (
		<>
			<Handle type="target" position={Position.Left} className={HANDLE} isConnectable={false} />
			<Handle type="source" position={Position.Right} className={HANDLE} isConnectable={false} />
		</>
	)
}

interface StepData extends Record<string, unknown> {
	readonly node: FlowNode
	readonly selected: boolean
	/** Under the keyboard's span cursor — distinct from `selected`, the open drawer. */
	readonly focused: boolean
	readonly onSelect: (spanId: string) => void
}

const StepNode = memo(function StepNode({ data }: NodeProps & { data: StepData }) {
	const { node, selected, focused, onSelect } = data
	// The glyph carries the kind of work; a failure takes it over outright — the
	// outcome outranks the kind, exactly as the waterfall's dots read.
	const Icon = node.errored ? CircleXmarkIcon : CATEGORY_ICON[node.category]

	return (
		<>
			<Ports />
			<button
				type="button"
				onClick={() => onSelect(node.span.spanId)}
				data-span-id={node.span.spanId}
				aria-current={selected || undefined}
				className={cn(
					"flex size-full cursor-pointer flex-col justify-center gap-1 rounded-md border bg-card px-2.5 py-2 text-left hover:border-ring",
					"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					node.errored ? "border-destructive/60" : "border-border",
					focused && "border-ring",
					// Selection is a state and hover is a pointer, so they cannot share a
					// token: the waterfall marks its selected row with primary, and the
					// node card takes the same direction.
					selected && "border-primary bg-primary/5",
				)}
			>
				<span className="flex items-center gap-1.5">
					<Icon
						size={12}
						className={cn(
							"shrink-0",
							node.errored ? "text-destructive" : CATEGORY_TEXT[node.category],
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
		</>
	)
})

interface LaneLabelData extends Record<string, unknown> {
	readonly index: number
	readonly durationMs: number
	readonly failed: boolean
}

/** The turn's margin note. A node rather than an overlay so it pans and zooms
 *  with the lane it names. */
const LaneLabelNode = memo(function LaneLabelNode({ data }: NodeProps & { data: LaneLabelData }) {
	return (
		<div className="pointer-events-none w-[110px] text-xs">
			<p className="font-medium text-[10px] text-primary uppercase tracking-wider">Turn {data.index}</p>
			<p className={cn("tabular-nums", data.failed ? "text-destructive" : "text-muted-foreground")}>
				{formatDuration(data.durationMs)}
			</p>
			{data.failed && <p className="text-destructive text-xs">failed</p>}
		</div>
	)
})

const nodeTypes = { step: StepNode, laneLabel: LaneLabelNode }

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
): readonly FlowLane[] {
	const lanes: FlowLane[] = []
	let laneTop = CANVAS_PADDING

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
				// the red border, the red glyph and the error text all describe the same
				// call, and clicking opens it.
				const lead = group.spans.find((member) => spanFailed(member)) ?? group.spans[0]!
				const node: FlowNode = {
					key: lead.spanId,
					span: lead,
					category: classifyAiSpan(lead),
					title: nodeTitle(lead),
					subtitle: nodeSubtitle(lead, group.spans),
					errored: spanFailed(lead),
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

	return lanes
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

function nodeTitle(span: AiSessionSpan): string {
	return span.genAi.toolName ?? span.spanName
}

function nodeSubtitle(lead: AiSessionSpan, group: readonly AiSessionSpan[]): string {
	const parts: string[] = []

	if (spanFailed(lead)) {
		const errorType = lead.genAi.errorType
		if (errorType !== undefined && errorType !== "") parts.push(errorType)
		else parts.push(lead.statusMessage === "" ? "error" : lead.statusMessage)
	} else if (isLlmCall(lead)) {
		const tokens = spanTokenBuckets(lead)
		if (tokens !== undefined && tokens.total > 0) {
			// In → out, same split as the waterfall's Tokens In / Out column: the in
			// half is everything the model read, cache buckets included.
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

	const failed = group.filter((member) => spanFailed(member)).length
	if (group.length > 1 && failed > 0) parts.push(`${failed} failed`)

	return parts.join(" · ")
}

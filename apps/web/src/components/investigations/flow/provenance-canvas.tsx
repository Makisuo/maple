/**
 * The overview's lead: the whole causal chain on one canvas.
 *
 * This replaced three widgets that each told a slice of the same story — the
 * rail's run spine, the Next-actions ledger and the checks panel. What caused the
 * investigation, what it dispatched, what it concluded and what it proposes are
 * one left-to-right read now, and the page stops repeating itself.
 *
 * xyflow with hand-computed positions rather than a layout engine: the graph is a
 * fixed column grid (`provenance-graph.ts` owns the arithmetic), and ELK would
 * buy nothing but a worker round-trip before first paint. What xyflow *is* here
 * for is pan, zoom and fit — a seven-action report is wider than any column this
 * page has.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
	ReactFlow,
	ReactFlowProvider,
	useReactFlow,
	type Edge,
	type Node,
	type ReactFlowInstance,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import type { V2Investigation } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"

import { CursorIcon, MaximizeIcon, MinusIcon, PlusIcon } from "@/components/icons"
import { ActionDetailSheet, type ProposedAction } from "../action-detail-sheet"
import { FlowEdge, type FlowEdgeData } from "./flow-edge"
import {
	FlowActionGhostNode,
	FlowActionNode,
	FlowHeadingNode,
	FlowLensNode,
	FlowLensOverflowNode,
	FlowPendingVerdictNode,
	FlowSpineNode,
} from "./flow-nodes"
import { ProvenanceCanvasLoading } from "./provenance-loading"
import { useTickingNow } from "@/hooks/use-ticking-now"
import { splitDuration } from "../investigation-display"
import { buildProvenanceGraph, type ProvenanceGraph } from "./provenance-graph"

/**
 * Exported so the node studio (`routes/node-lab.tsx`) hosts the *same* registration
 * rather than a copy of it — a catalogue that renders its own idea of these nodes
 * is a catalogue that can go quietly out of date with the page it documents.
 */
export const nodeTypes = {
	spine: FlowSpineNode,
	lens: FlowLensNode,
	lensOverflow: FlowLensOverflowNode,
	pendingVerdict: FlowPendingVerdictNode,
	action: FlowActionNode,
	actionGhost: FlowActionGhostNode,
	heading: FlowHeadingNode,
}

export const edgeTypes = { provenance: FlowEdge }

const MIN_FIT = 0.68
const FIT = { padding: 0.06, maxZoom: 1, minZoom: MIN_FIT }
/** Room above the graph for the column headings, which sit 20px over their column. */
const HEADING_GUTTER = 28
/** Room below it for the control bar, which overlaps the canvas's bottom-left corner. */
const CONTROL_GUTTER = 34

export function ProvenanceCanvas({
	investigation,
	openActionIndex,
	onOpenAction,
}: {
	investigation: V2Investigation
	/** Which proposed action's detail panel is open, from the route's `?action=`. */
	openActionIndex: number | null
	onOpenAction: (index: number | null) => void
}) {
	const graph = useMemo(() => buildProvenanceGraph(investigation), [investigation])
	const actions = useMemo(() => proposedActions(graph), [graph])
	const openAction = actions.find((action) => action.index === openActionIndex) ?? null

	// A freeform investigation that has not produced anything yet is a single node.
	// One box on a 330px canvas is worse than no canvas — but a *running* one is
	// about to become a real graph, and leaving a hole where the page's lead widget
	// goes until it does, then popping the whole chain in, is worse than either.
	if (graph.nodes.filter((node) => node.type !== "heading").length < 2) {
		return investigation.status === "investigating" ? <ProvenanceCanvasLoading /> : null
	}

	return (
		<ReactFlowProvider>
			<section className="flex shrink-0 flex-col gap-3.5 rounded-lg border bg-card/40 px-6 pb-5.5 pt-4.5">
				<Caption graph={graph} />
				<Canvas graph={graph} onOpenAction={onOpenAction} />
			</section>
			<ActionDetailSheet
				action={openAction}
				report={investigation.report}
				open={openAction !== null}
				onOpenChange={(next) => {
					if (!next) onOpenAction(null)
				}}
			/>
		</ReactFlowProvider>
	)
}

/** The action nodes as the detail panel wants them — the canvas already computed every field. */
const proposedActions = (graph: ProvenanceGraph): Array<ProposedAction> =>
	graph.nodes.flatMap((node) =>
		node.type === "action"
			? [
					{
						index: node.data.index,
						text: node.data.text,
						kind: node.data.kind,
						target: node.data.target,
						promise: node.data.promise,
					},
				]
			: [],
	)

function Caption({ graph }: { graph: ProvenanceGraph }) {
	/*
	 * A running pass counts up. The wire only refreshes every three seconds, so
	 * without this the one number on the canvas that is supposed to be live sat
	 * frozen between polls and read as a stalled run — `useTickingNow` is the
	 * sanctioned timer exception for exactly this.
	 */
	const now = useTickingNow(graph.runningSince !== null)
	const running = graph.runningSince !== null ? splitDuration(Math.max(0, now - graph.runningSince)) : null

	return (
		<div className="flex items-center gap-2.5">
			<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				Provenance
			</span>
			<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
				what produced this investigation, and what it produced
			</span>
			{graph.caption ? (
				<span className="flex shrink-0 items-center gap-1.5 font-mono text-xs text-muted-foreground tabular-nums">
					{running ? (
						<span
							aria-hidden
							className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
						/>
					) : null}
					{graph.caption}
					{running ? (
						<span className="text-foreground">{` · ${running.value}${running.unit}`}</span>
					) : null}
				</span>
			) : null}
		</div>
	)
}

function Canvas({
	graph,
	onOpenAction,
}: {
	graph: ProvenanceGraph
	onOpenAction: (index: number | null) => void
}) {
	const [instance, setInstance] = useState<ReactFlowInstance<Node, Edge> | null>(null)
	const [paneWidth, setPaneWidth] = useState(0)
	const paneRef = useRef<HTMLDivElement | null>(null)
	// Once the reader pans or zooms themselves, stop refitting under them.
	const userMovedRef = useRef(false)

	/**
	 * The zoom `fitView` will settle on, computed here so the pane can be exactly
	 * as tall as the graph ends up drawn — a pane sized to the graph's *unscaled*
	 * height leaves a third of itself empty on a narrow window.
	 *
	 * Floored at `MIN_FIT` rather than shrinking to whatever fits: below about
	 * two-thirds the design's 9px verdict words stop being words, and a graph the
	 * reader can pan beats one they can't read.
	 */
	const scale = paneWidth
		? Math.min(1, Math.max(MIN_FIT, (paneWidth * (1 - FIT.padding * 2)) / graph.width))
		: 1

	// Stable, so injecting it below does not rebuild every node on every render.
	const openAction = useCallback((index: number) => onOpenAction(index), [onOpenAction])

	const nodes = useMemo<Array<Node>>(
		() =>
			graph.nodes.map((node) => ({
				id: node.id,
				type: node.type,
				position: node.position,
				width: node.width,
				height: node.height,
				// The action nodes are the only interactive ones; the handler is injected
				// here rather than built into the graph so `buildProvenanceGraph` stays pure.
				data: (node.type === "action"
					? { ...node.data, onOpen: openAction }
					: node.data) as unknown as Record<string, unknown>,
				draggable: false,
				selectable: false,
				connectable: false,
				/*
				 * Load-bearing. xyflow's node wrapper derives pointer-events from
				 * `isSelectable || isDraggable || onNodeClick || onNodeMouse*` and sets
				 * `pointer-events: none` when all of them are off — which is exactly this
				 * canvas's configuration. Every link on every node was inert because of
				 * it. The wrapper spreads `node.style` after its own, so saying it here is
				 * how a node opts back in without becoming selectable or draggable.
				 */
				style: { pointerEvents: "all" },
			})),
		[graph, openAction],
	)

	const edges = useMemo<Array<Edge>>(
		() =>
			graph.edges.map((edge) => ({
				id: edge.id,
				source: edge.source,
				target: edge.target,
				type: "provenance",
				data: {
					kind: edge.kind,
					...(edge.label ? { label: edge.label } : {}),
					...(edge.live ? { live: true } : {}),
				} satisfies FlowEdgeData,
			})),
		[graph],
	)

	/**
	 * Place the graph ourselves rather than calling `fitView`.
	 *
	 * fitView centres, and centring is wrong the moment the graph is wider than
	 * the pane: a causal chain clipped at *both* ends hides the thing that caused
	 * the investigation, which is the whole left-to-right point. When the zoom is
	 * clamped we anchor to x=0 and let the reader pan right instead.
	 */
	const place = useCallback(() => {
		const pane = paneRef.current
		if (!instance || !pane) return
		const width = pane.clientWidth
		const zoom = Math.min(1, Math.max(MIN_FIT, (width * (1 - FIT.padding * 2)) / graph.width))
		const drawn = graph.width * zoom
		void instance.setViewport({
			x: drawn > width ? width * FIT.padding : (width - drawn) / 2,
			// The graph's own top is -HEADING_OFFSET (the column headings), so the
			// gutter has to clear that at the current zoom.
			y: HEADING_GUTTER * zoom,
			zoom,
		})
	}, [graph, instance])

	// The pane's width settles after mount and changes again whenever the right
	// panel opens — replace until the reader takes the viewport over. Tracking the
	// width in state keeps the pane exactly as tall as the graph ends up drawn.
	useEffect(() => {
		const pane = paneRef.current
		if (!pane) return
		const observer = new ResizeObserver(([entry]) => {
			setPaneWidth(entry?.contentRect.width ?? 0)
			if (userMovedRef.current) return
			requestAnimationFrame(() => {
				if (!userMovedRef.current) place()
			})
		})
		observer.observe(pane)
		return () => observer.disconnect()
	}, [place])

	// New graph (a lens reported, the verdict landed) — replace it at whatever it grew into.
	useEffect(() => {
		userMovedRef.current = false
		place()
	}, [place])

	return (
		// The pane takes the graph's drawn height, so that *width* is the only thing
		// fitView ever has to shrink for. A fixed height had the tallest column —
		// five proposed actions — squeezing the whole canvas to 54%, at which the
		// design's 9px verdict words stop being words.
		<div
			ref={paneRef}
			className="relative w-full"
			style={{ height: graph.height * scale + HEADING_GUTTER + CONTROL_GUTTER }}
		>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				onInit={setInstance}
				onMoveStart={(event) => {
					// A reader-initiated pan carries a source event; a programmatic
					// fitView passes null.
					if (event) userMovedRef.current = true
				}}
				nodesDraggable={false}
				nodesConnectable={false}
				elementsSelectable={false}
				connectOnClick={false}
				panOnScroll={false}
				zoomOnScroll={false}
				zoomOnDoubleClick={false}
				preventScrolling={false}
				minZoom={0.3}
				maxZoom={1.4}
				proOptions={{ hideAttribution: true }}
				aria-label="Investigation provenance graph"
			/>
			<Controls
				onManualMove={() => (userMovedRef.current = true)}
				onReset={() => {
					userMovedRef.current = false
					place()
				}}
			/>
			<GraphOutline graph={graph} onOpenAction={onOpenAction} />
		</div>
	)
}

/**
 * Scrolling the page is what the wheel does here — `zoomOnScroll` is off, because
 * a canvas that eats the wheel mid-page traps the reader on a 260px band. Zoom is
 * these four buttons and a drag.
 */
function Controls({ onManualMove, onReset }: { onManualMove: () => void; onReset: () => void }) {
	const flow = useReactFlow()
	const button = "flex size-6.5 items-center justify-center text-muted-foreground hover:text-foreground"

	const zoom = useCallback(
		(direction: "in" | "out") => {
			onManualMove()
			if (direction === "in") void flow.zoomIn()
			else void flow.zoomOut()
		},
		[flow, onManualMove],
	)

	return (
		<div className="absolute bottom-0 left-0 flex divide-x rounded-sm border bg-background">
			<span className={cn(button, "cursor-default")} aria-hidden>
				<CursorIcon size={12} />
			</span>
			<button type="button" className={button} onClick={() => zoom("in")} aria-label="Zoom in">
				<PlusIcon size={12} />
			</button>
			<button type="button" className={button} onClick={() => zoom("out")} aria-label="Zoom out">
				<MinusIcon size={12} />
			</button>
			<button type="button" className={button} onClick={onReset} aria-label="Fit the graph to the view">
				<MaximizeIcon size={12} />
			</button>
		</div>
	)
}

/**
 * The same chain as a list, for screen readers.
 *
 * xyflow renders into a transformed canvas whose reading order is layout order,
 * not causal order, and the nodes are `<div>`s with no relationship between them.
 * Mirroring the graph costs a handful of `<li>`s and is the difference between
 * the page's lead being readable and being invisible.
 */
function GraphOutline({
	graph,
	onOpenAction,
}: {
	graph: ProvenanceGraph
	onOpenAction: (index: number | null) => void
}) {
	return (
		<ol className="sr-only">
			{graph.nodes
				.filter((node) => node.type !== "heading")
				.map((node) => (
					<li key={node.id}>
						{node.type === "spine" ? (
							`${node.data.eyebrow}: ${node.data.title}${node.data.status ? ` — ${node.data.status}` : ""}${node.data.phase ? ` — ${node.data.phase}` : ""}`
						) : node.type === "lens" ? (
							`Lens ${node.data.title} — ${node.data.state.word}${node.data.state.icon === "running" && node.data.progressNote ? `, ${node.data.progressNote}` : ""}`
						) : node.type === "lensOverflow" ? (
							`${node.data.hidden} further lenses`
						) : node.type === "pendingVerdict" ? (
							`${node.data.word}${node.data.note ? `: ${node.data.note}` : ""}`
						) : node.type === "actionGhost" ? (
							// Announced once, on the first ghost — "proposed action pending"
							// twice running says nothing the second time.
							node.data.slot === 0 ? (
								"Proposed actions pending"
							) : null
						) : (
							/*
							 * A real button, because this outline is the keyboard route into
							 * the canvas: the node itself lives inside a transformed pane
							 * whose tab order is layout order, not causal order.
							 */
							<button type="button" onClick={() => onOpenAction(node.data.index)}>
								{`Proposed action ${node.data.ordinal}: ${node.data.text}`}
							</button>
						)}
					</li>
				))}
		</ol>
	)
}

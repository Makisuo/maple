import { useMemo, useCallback, useEffect, useRef, useState } from "react"
import {
	ReactFlow,
	Controls,
	MiniMap,
	Background,
	BackgroundVariant,
	useNodesState,
	useEdgesState,
	type Node,
	type ReactFlowInstance,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { EyeIcon } from "../icons"

import { Button } from "../ui/button"
import { cn } from "../../lib/utils"
import { getServiceColor } from "../../lib/colors"
import { describeSpan, SPAN_CATEGORIES } from "../../lib/span-category"
import { ServiceDot } from "../service-dot"
import { FlowSpanNode } from "./flow-node"
import { TraceFlowEdge } from "./flow-edge"
import {
	transformSpansToFlow,
	getLayoutedElements,
	findSpanById,
	type FlowNodeData,
	type FlowNode,
	type FlowEdge,
} from "./flow-utils"
import type { SpanNode } from "../../lib/types"

interface TraceFlowViewProps {
	rootSpans: SpanNode[]
	totalDurationMs: number
	traceStartTime: string
	services: string[]
	selectedSpanId?: string
	onSelectSpan?: (span: SpanNode) => void
}

const nodeTypes = {
	span: FlowSpanNode,
}

const edgeTypes = {
	flowEdge: TraceFlowEdge,
}

const defaultEdgeOptions = {
	animated: true,
}

export function TraceFlowView({
	rootSpans,
	totalDurationMs,
	services,
	selectedSpanId,
	onSelectSpan,
}: TraceFlowViewProps) {
	// Selection is intentionally NOT part of this memo — it's applied by the
	// effect below, so a selection change never re-layouts or refits the view.
	const { initialNodes, initialEdges } = useMemo(() => {
		const { nodes, edges } = transformSpansToFlow(rootSpans, services, totalDurationMs)
		const layouted = getLayoutedElements(nodes, edges, rootSpans)
		return { initialNodes: layouted.nodes, initialEdges: layouted.edges }
	}, [rootSpans, services, totalDurationMs])

	// Only legend categories that actually occur in this trace
	const presentCategories = useMemo(() => {
		const ids = new Set(
			initialNodes
				.filter((n) => !n.data.span.isMissing)
				.map((n) => describeSpan(n.data.span).category.id),
		)
		return SPAN_CATEGORIES.filter((c) => ids.has(c.id))
	}, [initialNodes])

	const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
	const [edges, setEdges] = useEdgesState(initialEdges)
	const [rfInstance, setRfInstance] = useState<ReactFlowInstance<FlowNode, FlowEdge> | null>(null)
	const paneRef = useRef<HTMLDivElement | null>(null)
	// Once the user pans/zooms themselves, stop auto-refitting under them.
	const userMovedRef = useRef(false)

	// Keep graph state in sync when the trace data arrives/changes after mount,
	// and refit the viewport so the whole trace is visible without manual zooming.
	useEffect(() => {
		setNodes(initialNodes)
		setEdges(initialEdges)
		userMovedRef.current = false
		if (!rfInstance) return
		const frame = requestAnimationFrame(() => {
			void rfInstance.fitView({ padding: 0.2, maxZoom: 1.5 })
		})
		return () => cancelAnimationFrame(frame)
	}, [initialNodes, initialEdges, rfInstance, setNodes, setEdges])

	// The pane's size settles after mount (tab activation, side panels, window
	// resizes) — refit on resize until the user takes over the viewport.
	useEffect(() => {
		if (!rfInstance || !paneRef.current) return
		const observer = new ResizeObserver(() => {
			if (userMovedRef.current) return
			requestAnimationFrame(() => {
				if (!userMovedRef.current) void rfInstance.fitView({ padding: 0.2, maxZoom: 1.5 })
			})
		})
		observer.observe(paneRef.current)
		return () => observer.disconnect()
	}, [rfInstance])

	useEffect(() => {
		setNodes((nds) =>
			nds.map((node) => {
				const nodeData = node.data as FlowNodeData
				const isSelected =
					nodeData.combinedSpans.some((s) => s.spanId === selectedSpanId) ||
					node.id === selectedSpanId
				return {
					...node,
					data: { ...node.data, isSelected },
				}
			}),
		)
	}, [selectedSpanId, setNodes])

	const handleNodeClick = useCallback(
		(_: React.MouseEvent, node: Node) => {
			const span = findSpanById(rootSpans, node.id)
			if (span && onSelectSpan) {
				onSelectSpan(span)
			}
		},
		[rootSpans, onSelectSpan],
	)

	if (rootSpans.length === 0) {
		return (
			<div className="border p-8 text-center">
				<p className="text-muted-foreground">No spans found for this trace</p>
			</div>
		)
	}

	return (
		<div className="flex flex-col h-full overflow-hidden">
			<div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2 shrink-0">
				<span className="text-xs font-medium text-muted-foreground">Flow View</span>
				<Button
					variant="ghost"
					size="sm"
					className="h-6 gap-1 text-xs"
					onClick={() => {
						userMovedRef.current = false
						void rfInstance?.fitView({ padding: 0.2, maxZoom: 1.5 })
					}}
				>
					<EyeIcon size={12} />
					Fit View
				</Button>
			</div>

			<div ref={paneRef} className="flex-1 min-h-0">
				<ReactFlow
					nodes={nodes}
					edges={edges}
					onNodesChange={onNodesChange}
					onNodeClick={handleNodeClick}
					onInit={setRfInstance}
					onMoveStart={(event) => {
						// A user-initiated pan/zoom carries a source event;
						// programmatic fitView moves pass null.
						if (event) userMovedRef.current = true
					}}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					defaultEdgeOptions={defaultEdgeOptions}
					nodesDraggable={false}
					nodesConnectable={false}
					connectOnClick={false}
					elementsSelectable={false}
					fitView
					fitViewOptions={{ padding: 0.2, maxZoom: 1.5 }}
					minZoom={0.1}
					maxZoom={2}
					proOptions={{ hideAttribution: true }}
				>
					<Controls showInteractive={false} />
					<MiniMap
						nodeColor={(node: Node) => {
							const data = node.data as FlowNodeData
							if (data.span.statusCode === "Error") {
								return "var(--severity-error)"
							}
							return getServiceColor(data.span.serviceName)
						}}
						maskColor="oklch(0.15 0 0 / 0.8)"
						className="!bg-muted/50 !border-border"
						pannable={false}
						zoomable={false}
					/>
					<Background variant={BackgroundVariant.Dots} gap={16} size={1} />
				</ReactFlow>
			</div>

			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/30 px-3 py-2.5 text-[11px] text-muted-foreground shrink-0">
				<span className="font-medium">Click to select</span>
				<span className="text-foreground/30">|</span>
				<span className="font-medium">Scroll to zoom</span>
				<span className="text-foreground/30">|</span>
				<span className="font-medium">Drag to pan</span>
				<span className="text-foreground/30">|</span>
				<div className="flex items-center gap-3">
					{services.map((service) => (
						<div key={service} className="flex items-center gap-1.5">
							<ServiceDot serviceName={service} className="size-2.5" />
							<span className="font-medium">{service}</span>
						</div>
					))}
				</div>
				{presentCategories.length > 0 && (
					<>
						<span className="text-foreground/30">|</span>
						<div className="flex items-center gap-3">
							{presentCategories.map((category) => (
								<div key={category.id} className="flex items-center gap-1.5">
									<span
										className={cn(
											"flex size-3.5 items-center justify-center rounded-[4px]",
											category.accent.soft,
											category.accent.text,
										)}
									>
										<category.Icon size={9} />
									</span>
									<span className="font-medium">{category.label}</span>
								</div>
							))}
						</div>
					</>
				)}
				<span className="flex-1" />
				<div className="flex items-center gap-1.5">
					<span className="size-3.5 rounded-[4px] bg-severity-error/15 ring-1 ring-inset ring-severity-error/40" />
					<span className="font-medium">Error</span>
				</div>
			</div>
		</div>
	)
}

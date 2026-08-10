import type { Node, Edge } from "@xyflow/react"
import { describeSpan } from "../../lib/span-category"
import type { SpanNode } from "../../lib/types"

export interface AggregatedDuration {
	total: number
	min: number
	max: number
	avg: number
}

export interface FlowNodeData extends Record<string, unknown> {
	span: SpanNode
	services: string[]
	isSelected: boolean
	count: number
	combinedSpans: SpanNode[]
	aggregatedDuration: AggregatedDuration
	/** Total trace duration — drives the per-card cost rail. */
	totalDurationMs: number
}

export interface FlowEdgeData extends Record<string, unknown> {
	/** Number of combined child spans this edge fans into (matches the ×N card badge). */
	count: number
	/** Total duration across the combined group, ms. */
	durationMs: number
	/** min/max across the group; both equal durationMs when count === 1. */
	minMs: number
	maxMs: number
	/** Child group's share of the whole trace, 0..1. */
	share: number
	/**
	 * Gap between parent start and earliest child start, ms. Omitted when a
	 * timestamp is unparseable, either span is missing, or the gap is negative
	 * (clock skew) — never show a misleading offset.
	 */
	startOffsetMs?: number
	isError: boolean
	/** Parent or child is a synthesized missing span. */
	isMissing: boolean
	/** Category accent text token of the target span, for the label pill. */
	accentText: string
}

export type FlowNode = Node<FlowNodeData, "span">
export type FlowEdge = Edge<FlowEdgeData>

function computeStartOffsetMs(parentSpan: SpanNode, spans: SpanNode[]): number | undefined {
	const parentStart = new Date(parentSpan.startTime).getTime()
	if (!Number.isFinite(parentStart)) return undefined
	let earliest = Infinity
	for (const s of spans) {
		const t = new Date(s.startTime).getTime()
		if (Number.isFinite(t) && t < earliest) earliest = t
	}
	if (!Number.isFinite(earliest)) return undefined
	const offset = earliest - parentStart
	return offset >= 0 ? offset : undefined
}

function areSpansDuplicates(a: SpanNode, b: SpanNode): boolean {
	return a.spanName === b.spanName && a.serviceName === b.serviceName
}

interface CombinedNode {
	spans: SpanNode[]
	children: CombinedNode[]
}

function combineConsecutiveDuplicates(children: SpanNode[]): CombinedNode[] {
	if (children.length === 0) return []

	const result: CombinedNode[] = []
	let currentGroup: SpanNode[] = [children[0]]

	for (let i = 1; i < children.length; i++) {
		const child = children[i]
		const lastInGroup = currentGroup[currentGroup.length - 1]

		if (areSpansDuplicates(child, lastInGroup)) {
			currentGroup.push(child)
		} else {
			result.push(createCombinedNode(currentGroup))
			currentGroup = [child]
		}
	}

	result.push(createCombinedNode(currentGroup))

	return result
}

function createCombinedNode(spans: SpanNode[]): CombinedNode {
	const allChildren: SpanNode[] = []
	for (const span of spans) {
		allChildren.push(...span.children)
	}
	allChildren.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())

	const combinedChildren = combineConsecutiveDuplicates(allChildren)

	return {
		spans,
		children: combinedChildren,
	}
}

function calculateAggregatedDuration(spans: SpanNode[]): AggregatedDuration {
	let total = 0
	let min = Infinity
	let max = -Infinity
	for (const s of spans) {
		total += s.durationMs
		if (s.durationMs < min) min = s.durationMs
		if (s.durationMs > max) max = s.durationMs
	}
	if (!Number.isFinite(min)) min = 0
	if (!Number.isFinite(max)) max = 0
	return {
		total,
		min,
		max,
		avg: spans.length > 0 ? total / spans.length : 0,
	}
}

function getCombinedNodeId(spans: SpanNode[]): string {
	if (spans.length === 1) {
		return spans[0].spanId
	}
	return `combined-${spans.map((s) => s.spanId).join("-")}`
}

function hasAnyError(spans: SpanNode[]): boolean {
	return spans.some((s) => s.statusCode === "Error")
}

const NODE_WIDTH = 280
const NODE_HEIGHT = 56
const HORIZONTAL_SPACING = 80
const VERTICAL_SPACING = 180

/** Converts a span tree to a flow graph, combining consecutive duplicate spans. */
export function transformSpansToFlow(
	rootSpans: SpanNode[],
	services: string[],
	totalDurationMs: number,
	selectedSpanId?: string,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
	const nodes: FlowNode[] = []
	const edges: FlowEdge[] = []

	const combinedRoots = combineConsecutiveDuplicates(rootSpans)

	function traverse(combinedNode: CombinedNode, parentId?: string, parentSpan?: SpanNode) {
		const { spans } = combinedNode
		const nodeId = getCombinedNodeId(spans)
		const primarySpan = spans[0]
		const count = spans.length
		const aggregatedDuration = calculateAggregatedDuration(spans)

		const isSelected = spans.some((s) => s.spanId === selectedSpanId)

		nodes.push({
			id: nodeId,
			type: "span",
			position: { x: 0, y: 0 },
			data: {
				span: primarySpan,
				services,
				isSelected,
				count,
				combinedSpans: spans,
				aggregatedDuration,
				totalDurationMs,
			},
		})

		if (parentId && parentSpan) {
			const isMissing = primarySpan.isMissing === true || parentSpan.isMissing === true
			edges.push({
				id: `${parentId}-${nodeId}`,
				source: parentId,
				target: nodeId,
				type: "flowEdge",
				data: {
					count,
					durationMs: aggregatedDuration.total,
					minMs: aggregatedDuration.min,
					maxMs: aggregatedDuration.max,
					share: totalDurationMs > 0 ? Math.min(1, aggregatedDuration.total / totalDurationMs) : 0,
					startOffsetMs: isMissing ? undefined : computeStartOffsetMs(parentSpan, spans),
					isError: hasAnyError(spans),
					isMissing,
					accentText: primarySpan.isMissing
						? "text-muted-foreground"
						: describeSpan(primarySpan).category.accent.text,
				},
			})
		}

		for (const child of combinedNode.children) {
			traverse(child, nodeId, primarySpan)
		}
	}

	for (const root of combinedRoots) {
		traverse(root)
	}

	return { nodes, edges }
}

interface LayoutNode {
	id: string
	children: LayoutNode[]
}

const MAX_LAYOUT_DEPTH = 200

function buildLayoutTree(nodes: FlowNode[], edges: FlowEdge[]): LayoutNode[] {
	const childrenMap = new Map<string, string[]>()
	const hasParent = new Set<string>()

	for (const edge of edges) {
		const children = childrenMap.get(edge.source) || []
		children.push(edge.target)
		childrenMap.set(edge.source, children)
		hasParent.add(edge.target)
	}

	const rootIds = nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id)

	// Build tree recursively. Guard against cycles and depth blowups; both can
	// happen when telemetry contains malformed parent_span_id chains.
	const visited = new Set<string>()
	function buildNode(id: string, depth: number): LayoutNode {
		if (depth > MAX_LAYOUT_DEPTH || visited.has(id)) {
			return { id, children: [] }
		}
		visited.add(id)
		const childIds = childrenMap.get(id) || []
		return {
			id,
			children: childIds.map((childId) => buildNode(childId, depth + 1)),
		}
	}

	return rootIds.map((id) => buildNode(id, 0))
}

/** Positions flow nodes in a top-to-bottom tree. */
export function getLayoutedElements(
	nodes: FlowNode[],
	edges: FlowEdge[],
): { nodes: FlowNode[]; edges: FlowEdge[] } {
	const nodePositions = new Map<string, { x: number; y: number }>()

	const layoutRoots = buildLayoutTree(nodes, edges)

	// Width is read for centering and child placement; cache it per subtree.
	const subtreeWidthCache = new Map<string, number>()
	function getSubtreeWidth(node: LayoutNode): number {
		const cached = subtreeWidthCache.get(node.id)
		if (cached !== undefined) return cached
		let value: number
		if (node.children.length === 0) {
			value = NODE_WIDTH
		} else {
			const childrenWidth = node.children.reduce(
				(sum, child) => sum + getSubtreeWidth(child) + HORIZONTAL_SPACING,
				-HORIZONTAL_SPACING,
			)
			value = Math.max(NODE_WIDTH, childrenWidth)
		}
		subtreeWidthCache.set(node.id, value)
		return value
	}

	function positionNode(node: LayoutNode, x: number, y: number) {
		const subtreeWidth = getSubtreeWidth(node)
		const nodeX = x + (subtreeWidth - NODE_WIDTH) / 2

		nodePositions.set(node.id, { x: nodeX, y })

		if (node.children.length > 0) {
			let childX = x
			const childY = y + NODE_HEIGHT + VERTICAL_SPACING

			for (const child of node.children) {
				const childWidth = getSubtreeWidth(child)
				positionNode(child, childX, childY)
				childX += childWidth + HORIZONTAL_SPACING
			}
		}
	}

	let currentX = 0
	for (const root of layoutRoots) {
		positionNode(root, currentX, 0)
		currentX += getSubtreeWidth(root) + HORIZONTAL_SPACING * 2
	}

	const layoutedNodes = nodes.map((node) => {
		const position = nodePositions.get(node.id) || { x: 0, y: 0 }
		return {
			...node,
			position,
		}
	})

	return { nodes: layoutedNodes, edges }
}

/** Finds a span by regular or combined flow-node ID. */
export function findSpanById(rootSpans: SpanNode[], spanId: string): SpanNode | undefined {
	let searchId = spanId
	if (spanId.startsWith("combined-")) {
		const parts = spanId.slice("combined-".length).split("-")
		if (parts.length > 0) {
			searchId = parts[0]
		}
	}

	function traverse(node: SpanNode): SpanNode | undefined {
		if (node.spanId === searchId) return node
		for (const child of node.children) {
			const found = traverse(child)
			if (found) return found
		}
		return undefined
	}

	for (const root of rootSpans) {
		const found = traverse(root)
		if (found) return found
	}
	return undefined
}

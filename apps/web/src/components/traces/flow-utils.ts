import type { Node, Edge } from "@xyflow/react"
import type { SpanNode } from "@/api/tinybird/traces"

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
	// Combined span info
	count: number // Number of combined spans (1 if not combined)
	combinedSpans: SpanNode[] // All spans in the group
	aggregatedDuration: AggregatedDuration
}

export type FlowNode = Node<FlowNodeData, "span">
export type FlowEdge = Edge

/**
 * Check if two spans are duplicates (same spanName and serviceName)
 */
function areSpansDuplicates(a: SpanNode, b: SpanNode): boolean {
	return a.spanName === b.spanName && a.serviceName === b.serviceName
}

/**
 * Represents either a single span or a combined group of consecutive duplicate spans
 */
interface CombinedNode {
	spans: SpanNode[] // All spans in this node (1 for single, multiple for combined)
	children: CombinedNode[] // Children nodes (merged from all spans)
}

/**
 * Combine consecutive duplicate spans in a list of children
 */
function combineConsecutiveDuplicates(children: SpanNode[]): CombinedNode[] {
	if (children.length === 0) return []

	const result: CombinedNode[] = []
	let currentGroup: SpanNode[] = [children[0]]

	for (let i = 1; i < children.length; i++) {
		const child = children[i]
		const lastInGroup = currentGroup[currentGroup.length - 1]

		if (areSpansDuplicates(child, lastInGroup)) {
			// Add to current group
			currentGroup.push(child)
		} else {
			// Flush current group and start new one
			result.push(createCombinedNode(currentGroup))
			currentGroup = [child]
		}
	}

	// Flush final group
	result.push(createCombinedNode(currentGroup))

	return result
}

/**
 * Create a combined node from a group of spans
 */
function createCombinedNode(spans: SpanNode[]): CombinedNode {
	// Merge all children from all spans, sorted by startTime
	const allChildren: SpanNode[] = []
	for (const span of spans) {
		allChildren.push(...span.children)
	}
	allChildren.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())

	// Recursively combine children
	const combinedChildren = combineConsecutiveDuplicates(allChildren)

	return {
		spans,
		children: combinedChildren,
	}
}

/**
 * Calculate aggregated duration statistics for a group of spans
 */
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

/**
 * Generate a node ID for a combined node
 */
function getCombinedNodeId(spans: SpanNode[]): string {
	if (spans.length === 1) {
		return spans[0].spanId
	}
	return `combined-${spans.map((s) => s.spanId).join("-")}`
}

/**
 * Check if any span in the group has an error
 */
function hasAnyError(spans: SpanNode[]): boolean {
	return spans.some((s) => s.statusCode === "Error")
}

const NODE_WIDTH = 280
const NODE_HEIGHT = 80
const HORIZONTAL_SPACING = 80
const VERTICAL_SPACING = 180

/**
 * Transform SpanNode tree into React Flow nodes and edges
 * Combines consecutive duplicate spans (same spanName + serviceName) into single nodes
 */
export function transformSpansToFlow(
	rootSpans: SpanNode[],
	services: string[],
	selectedSpanId?: string,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
	const nodes: FlowNode[] = []
	const edges: FlowEdge[] = []

	// First, combine consecutive duplicates starting from root spans
	const combinedRoots = combineConsecutiveDuplicates(rootSpans)

	function traverse(combinedNode: CombinedNode, parentId?: string) {
		const { spans } = combinedNode
		const nodeId = getCombinedNodeId(spans)
		const primarySpan = spans[0] // Use first span as the primary representation
		const count = spans.length

		// Check if any span in the group is selected
		const isSelected = spans.some((s) => s.spanId === selectedSpanId)

		// Create node
		nodes.push({
			id: nodeId,
			type: "span",
			position: { x: 0, y: 0 }, // Will be set by layout
			data: {
				span: primarySpan,
				services,
				isSelected,
				count,
				combinedSpans: spans,
				aggregatedDuration: calculateAggregatedDuration(spans),
			},
		})

		// Create edge from parent (if any)
		if (parentId) {
			const isError = hasAnyError(spans)
			edges.push({
				id: `${parentId}-${nodeId}`,
				source: parentId,
				target: nodeId,
				// Add label for combined spans
				...(count > 1 && {
					label: `×${count}`,
					labelStyle: {
						fontSize: 11,
						fontWeight: 600,
						fill: "oklch(0.75 0.02 60)",
					},
					labelBgStyle: {
						fill: "oklch(0.18 0.01 60)",
						fillOpacity: 0.9,
					},
					labelBgPadding: [4, 6] as [number, number],
					labelBgBorderRadius: 4,
				}),
				...(isError && {
					style: {
						stroke: "oklch(0.62 0.20 25)",
						strokeWidth: 2,
					},
				}),
			})
		}

		// Traverse children
		for (const child of combinedNode.children) {
			traverse(child, nodeId)
		}
	}

	for (const root of combinedRoots) {
		traverse(root)
	}

	return { nodes, edges }
}

/**
 * Build a tree structure from edges for layout purposes
 */
interface LayoutNode {
	id: string
	children: LayoutNode[]
}

const MAX_LAYOUT_DEPTH = 200

function buildLayoutTree(nodes: FlowNode[], edges: FlowEdge[]): LayoutNode[] {
	// Build adjacency map from edges
	const childrenMap = new Map<string, string[]>()
	const hasParent = new Set<string>()

	for (const edge of edges) {
		const children = childrenMap.get(edge.source) || []
		children.push(edge.target)
		childrenMap.set(edge.source, children)
		hasParent.add(edge.target)
	}

	// Find root nodes (nodes without parents)
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

/**
 * Simple tree layout algorithm
 * Positions nodes in a top-to-bottom hierarchical tree
 * Uses edge-based tree traversal to handle combined nodes
 */
export function getLayoutedElements(
	nodes: FlowNode[],
	edges: FlowEdge[],
	_rootSpans: SpanNode[], // Kept for API compatibility but not used
): { nodes: FlowNode[]; edges: FlowEdge[] } {
	const nodePositions = new Map<string, { x: number; y: number }>()

	// Build layout tree from edges
	const layoutRoots = buildLayoutTree(nodes, edges)

	// Memoize subtree widths so deep/wide trees don't re-walk subtrees once
	// per ancestor — getSubtreeWidth is called both for centering and for
	// child placement, which previously made the layout O(n²) per level.
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

	// Position nodes recursively
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

	// Layout each root tree
	let currentX = 0
	for (const root of layoutRoots) {
		positionNode(root, currentX, 0)
		currentX += getSubtreeWidth(root) + HORIZONTAL_SPACING * 2
	}

	// Apply positions to nodes
	const layoutedNodes = nodes.map((node) => {
		const position = nodePositions.get(node.id) || { x: 0, y: 0 }
		return {
			...node,
			position,
		}
	})

	return { nodes: layoutedNodes, edges }
}

/**
 * Flatten a SpanNode tree to find a span by ID
 * Handles both regular span IDs and combined node IDs (combined-spanId1-spanId2-...)
 */
export function findSpanById(rootSpans: SpanNode[], spanId: string): SpanNode | undefined {
	// Handle combined node IDs - extract the first span ID
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

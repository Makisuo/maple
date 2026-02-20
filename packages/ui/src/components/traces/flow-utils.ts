import type { Node, Edge } from "@xyflow/react"
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
}

export type FlowNode = Node<FlowNodeData, "span">
export type FlowEdge = Edge

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

  return { spans, children: combinedChildren }
}

function calculateAggregatedDuration(spans: SpanNode[]): AggregatedDuration {
  const durations = spans.map(s => s.durationMs)
  const total = durations.reduce((sum, d) => sum + d, 0)
  return {
    total,
    min: Math.min(...durations),
    max: Math.max(...durations),
    avg: total / spans.length,
  }
}

function getCombinedNodeId(spans: SpanNode[]): string {
  if (spans.length === 1) return spans[0].spanId
  return `combined-${spans.map(s => s.spanId).join('-')}`
}

function hasAnyError(spans: SpanNode[]): boolean {
  return spans.some(s => s.statusCode === "Error")
}

const NODE_WIDTH = 280
const NODE_HEIGHT = 80
const HORIZONTAL_SPACING = 80
const VERTICAL_SPACING = 180

export function transformSpansToFlow(
  rootSpans: SpanNode[],
  services: string[],
  selectedSpanId?: string
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []

  const combinedRoots = combineConsecutiveDuplicates(rootSpans)

  function traverse(combinedNode: CombinedNode, parentId?: string) {
    const { spans } = combinedNode
    const nodeId = getCombinedNodeId(spans)
    const primarySpan = spans[0]
    const count = spans.length
    const isSelected = spans.some(s => s.spanId === selectedSpanId)

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
        aggregatedDuration: calculateAggregatedDuration(spans),
      },
    })

    if (parentId) {
      const isError = hasAnyError(spans)
      edges.push({
        id: `${parentId}-${nodeId}`,
        source: parentId,
        target: nodeId,
        ...(count > 1 && {
          label: `×${count}`,
          labelStyle: { fontSize: 11, fontWeight: 600, fill: 'oklch(0.7 0 0)' },
          labelBgStyle: { fill: 'oklch(0.2 0 0)', fillOpacity: 0.9 },
          labelBgPadding: [4, 6] as [number, number],
          labelBgBorderRadius: 4,
        }),
        ...(isError && {
          style: { stroke: "oklch(0.6 0.2 25)", strokeWidth: 2 },
        }),
      })
    }

    for (const child of combinedNode.children) {
      traverse(child, nodeId)
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

function buildLayoutTree(nodes: FlowNode[], edges: FlowEdge[]): LayoutNode[] {
  const childrenMap = new Map<string, string[]>()
  const hasParent = new Set<string>()

  for (const edge of edges) {
    const children = childrenMap.get(edge.source) || []
    children.push(edge.target)
    childrenMap.set(edge.source, children)
    hasParent.add(edge.target)
  }

  const rootIds = nodes.filter(n => !hasParent.has(n.id)).map(n => n.id)

  function buildNode(id: string): LayoutNode {
    const childIds = childrenMap.get(id) || []
    return { id, children: childIds.map(childId => buildNode(childId)) }
  }

  return rootIds.map(id => buildNode(id))
}

function getSubtreeWidth(node: LayoutNode): number {
  if (node.children.length === 0) return NODE_WIDTH
  const childrenWidth = node.children.reduce(
    (sum, child) => sum + getSubtreeWidth(child) + HORIZONTAL_SPACING,
    -HORIZONTAL_SPACING
  )
  return Math.max(NODE_WIDTH, childrenWidth)
}

export function getLayoutedElements(
  nodes: FlowNode[],
  edges: FlowEdge[],
  _rootSpans: SpanNode[]
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodePositions = new Map<string, { x: number; y: number }>()
  const layoutRoots = buildLayoutTree(nodes, edges)

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
    return { ...node, position }
  })

  return { nodes: layoutedNodes, edges }
}

export function findSpanById(
  rootSpans: SpanNode[],
  spanId: string
): SpanNode | undefined {
  let searchId = spanId
  if (spanId.startsWith("combined-")) {
    const parts = spanId.slice("combined-".length).split("-")
    if (parts.length > 0) searchId = parts[0]
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

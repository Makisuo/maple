import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force"
import type { Node, Edge } from "@xyflow/react"
import type { ServiceEdge } from "@/api/tinybird/service-map"
import type { ServiceOverview } from "@/api/tinybird/services"

export interface ServiceNodeData {
  label: string
  throughput: number
  tracedThroughput: number
  hasSampling: boolean
  samplingWeight: number
  errorRate: number
  avgLatencyMs: number
  services: string[]
  selected: boolean
  [key: string]: unknown
}

export interface ServiceEdgeData {
  callCount: number
  callsPerSecond: number
  estimatedCallsPerSecond: number
  errorCount: number
  errorRate: number
  avgDurationMs: number
  p95DurationMs: number
  hasSampling: boolean
  services: string[]
  [key: string]: unknown
}

interface SimNode extends SimulationNodeDatum {
  id: string
}

/**
 * Derive the unique list of services from edges + service overview data
 */
export function deriveServiceList(
  edges: ServiceEdge[],
  serviceOverviews: ServiceOverview[],
): string[] {
  const services = new Set<string>()
  for (const edge of edges) {
    services.add(edge.sourceService)
    services.add(edge.targetService)
  }
  for (const svc of serviceOverviews) {
    services.add(svc.serviceName)
  }
  return Array.from(services).sort()
}

/**
 * Build ReactFlow nodes and edges from service map data
 */
export function buildFlowElements(
  edges: ServiceEdge[],
  serviceOverviews: ServiceOverview[],
  durationSeconds: number,
): { nodes: Node<ServiceNodeData>[]; edges: Edge<ServiceEdgeData>[] } {
  const services = deriveServiceList(edges, serviceOverviews)

  // Build lookup of service overview metrics
  const overviewMap = new Map<string, ServiceOverview>()
  for (const svc of serviceOverviews) {
    // Keep highest-throughput entry per service name
    const existing = overviewMap.get(svc.serviceName)
    if (!existing || svc.throughput > existing.throughput) {
      overviewMap.set(svc.serviceName, svc)
    }
  }

  const flowNodes: Node<ServiceNodeData>[] = services.map((service) => {
    const overview = overviewMap.get(service)
    return {
      id: service,
      type: "serviceNode",
      position: { x: 0, y: 0 }, // will be set by layout
      data: {
        label: service,
        throughput: overview?.throughput ?? 0,
        tracedThroughput: overview?.tracedThroughput ?? 0,
        hasSampling: overview?.hasSampling ?? false,
        samplingWeight: overview?.samplingWeight ?? 1,
        errorRate: overview?.errorRate ?? 0,
        avgLatencyMs: overview?.p50LatencyMs ?? 0,
        services,
        selected: false,
      },
    }
  })

  const safeDuration = Math.max(durationSeconds, 1)

  const flowEdges: Edge<ServiceEdgeData>[] = edges.map((edge) => ({
    id: `${edge.sourceService}->${edge.targetService}`,
    source: edge.sourceService,
    target: edge.targetService,
    type: "serviceEdge",
    data: {
      callCount: edge.callCount,
      callsPerSecond: edge.callCount / safeDuration,
      estimatedCallsPerSecond: edge.estimatedCallCount / safeDuration,
      errorCount: edge.errorCount,
      errorRate: edge.errorRate,
      avgDurationMs: edge.avgDurationMs,
      p95DurationMs: edge.p95DurationMs,
      hasSampling: edge.hasSampling,
      services,
    },
  }))

  return { nodes: flowNodes, edges: flowEdges }
}

/**
 * Compute hierarchical layer assignments via BFS on the call graph.
 * Returns a map from node ID to { layer, indexInLayer, layerSize }.
 */
function computeLayers(
  nodes: Node<ServiceNodeData>[],
  edges: Edge<ServiceEdgeData>[],
): Map<string, { layer: number; indexInLayer: number; layerSize: number }> {
  // Build adjacency list (forward + reverse) and in-degree map
  const adjacency = new Map<string, string[]>()
  const reverseAdj = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  for (const n of nodes) {
    adjacency.set(n.id, [])
    reverseAdj.set(n.id, [])
    inDegree.set(n.id, 0)
  }
  for (const e of edges) {
    adjacency.get(e.source)?.push(e.target)
    reverseAdj.get(e.target)?.push(e.source)
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
  }

  // Roots = nodes with in-degree 0, sorted alphabetically for determinism
  let roots = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id).sort()

  // If no roots (pure cycle), pick the node with lowest in-degree
  if (roots.length === 0) {
    const sorted = [...nodes].sort((a, b) => {
      const da = inDegree.get(a.id) ?? 0
      const db = inDegree.get(b.id) ?? 0
      return da !== db ? da - db : a.id.localeCompare(b.id)
    })
    roots = [sorted[0].id]
  }

  // BFS from roots
  const layerMap = new Map<string, number>()
  const queue: Array<{ id: string; layer: number }> = []
  for (const root of roots) {
    layerMap.set(root, 0)
    queue.push({ id: root, layer: 0 })
  }

  let head = 0
  while (head < queue.length) {
    const { id, layer } = queue[head++]
    for (const child of adjacency.get(id) ?? []) {
      if (!layerMap.has(child)) {
        layerMap.set(child, layer + 1)
        queue.push({ id: child, layer: layer + 1 })
      }
    }
  }

  // Assign disconnected nodes to maxDepth + 1
  let maxDepth = 0
  for (const l of layerMap.values()) {
    if (l > maxDepth) maxDepth = l
  }
  for (const n of nodes) {
    if (!layerMap.has(n.id)) {
      layerMap.set(n.id, maxDepth + 1)
    }
  }

  // Group nodes by layer, initial alphabetical sort for determinism
  const layerGroups = new Map<number, string[]>()
  for (const [id, layer] of layerMap) {
    if (!layerGroups.has(layer)) layerGroups.set(layer, [])
    layerGroups.get(layer)!.push(id)
  }
  for (const group of layerGroups.values()) {
    group.sort()
  }

  // Barycenter ordering: sort nodes within each layer by the median position
  // of their neighbors in adjacent layers to minimize edge crossings
  const layerIndices = [...layerGroups.keys()].sort((a, b) => a - b)
  const positionOf = new Map<string, number>()

  function updatePositions() {
    for (const [, group] of layerGroups) {
      for (let i = 0; i < group.length; i++) {
        positionOf.set(group[i], i)
      }
    }
  }

  function barySort(layer: string[], getNeighbors: (id: string) => string[]) {
    const barycenters = new Map<string, number>()
    for (let i = 0; i < layer.length; i++) {
      const neighbors = getNeighbors(layer[i])
      const positions = neighbors
        .map((n) => positionOf.get(n))
        .filter((p): p is number => p !== undefined)

      if (positions.length === 0) {
        barycenters.set(layer[i], i)
      } else {
        positions.sort((a, b) => a - b)
        const mid = Math.floor(positions.length / 2)
        const median =
          positions.length % 2 === 1
            ? positions[mid]
            : (positions[mid - 1] + positions[mid]) / 2
        barycenters.set(layer[i], median)
      }
    }
    layer.sort((a, b) => {
      const ba = barycenters.get(a) ?? 0
      const bb = barycenters.get(b) ?? 0
      return ba !== bb ? ba - bb : a.localeCompare(b)
    })
  }

  updatePositions()
  for (let sweep = 0; sweep < 2; sweep++) {
    // Left-to-right: order by neighbors in previous layer
    for (let li = 1; li < layerIndices.length; li++) {
      barySort(layerGroups.get(layerIndices[li])!, (id) => reverseAdj.get(id) ?? [])
      updatePositions()
    }
    // Right-to-left: order by neighbors in next layer
    for (let li = layerIndices.length - 2; li >= 0; li--) {
      barySort(layerGroups.get(layerIndices[li])!, (id) => adjacency.get(id) ?? [])
      updatePositions()
    }
  }

  // Build final result
  const result = new Map<string, { layer: number; indexInLayer: number; layerSize: number }>()
  for (const [layer, group] of layerGroups) {
    for (let i = 0; i < group.length; i++) {
      result.set(group[i], { layer, indexInLayer: i, layerSize: group.length })
    }
  }

  return result
}

/**
 * Run d3-force simulation synchronously to compute node positions.
 * Seeds positions from hierarchical BFS layers for a left-to-right layout.
 */
export function layoutNodes(
  nodes: Node<ServiceNodeData>[],
  edges: Edge<ServiceEdgeData>[],
): Node<ServiceNodeData>[] {
  if (nodes.length === 0) return nodes

  const layers = computeLayers(nodes, edges)

  const simNodes: SimNode[] = nodes.map((n) => {
    const assignment = layers.get(n.id)!
    return {
      id: n.id,
      x: assignment.layer * 300,
      y: (assignment.indexInLayer - (assignment.layerSize - 1) / 2) * 150,
    }
  })
  const simLinks: SimulationLinkDatum<SimNode>[] = edges.map((e) => ({
    source: e.source,
    target: e.target,
  }))

  const nodeMap = new Map<string, SimNode>()
  for (const n of simNodes) {
    nodeMap.set(n.id, n)
  }

  const simulation = forceSimulation(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
        .id((d) => d.id)
        .distance(280)
        .strength(0.3),
    )
    .force("charge", forceManyBody().strength(-500))
    .force(
      "x",
      forceX<SimNode>((d) => {
        const assignment = layers.get(d.id)
        return assignment ? assignment.layer * 300 : 0
      }).strength(0.8),
    )
    .force(
      "y",
      forceY<SimNode>((d) => {
        const assignment = layers.get(d.id)
        if (!assignment) return 0
        return (assignment.indexInLayer - (assignment.layerSize - 1) / 2) * 150
      }).strength(0.5),
    )
    .force("collide", forceCollide(120))
    .stop()

  // Run synchronously
  for (let i = 0; i < 120; i++) {
    simulation.tick()
  }

  return nodes.map((node) => {
    const simNode = nodeMap.get(node.id)
    return {
      ...node,
      position: {
        x: simNode?.x ?? 0,
        y: simNode?.y ?? 0,
      },
    }
  })
}

/**
 * Check if the topology (set of node IDs + edge pairs) has changed
 */
export function topologyChanged(
  prevNodes: Node[],
  nextNodes: Node[],
  prevEdges: Edge[],
  nextEdges: Edge[],
): boolean {
  if (prevNodes.length !== nextNodes.length) return true
  if (prevEdges.length !== nextEdges.length) return true

  const prevNodeIds = new Set(prevNodes.map((n) => n.id))
  const nextNodeIds = new Set(nextNodes.map((n) => n.id))
  if (prevNodeIds.size !== nextNodeIds.size) return true
  for (const id of prevNodeIds) {
    if (!nextNodeIds.has(id)) return true
  }

  const prevEdgeIds = new Set(prevEdges.map((e) => e.id))
  const nextEdgeIds = new Set(nextEdges.map((e) => e.id))
  if (prevEdgeIds.size !== nextEdgeIds.size) return true
  for (const id of prevEdgeIds) {
    if (!nextEdgeIds.has(id)) return true
  }

  return false
}

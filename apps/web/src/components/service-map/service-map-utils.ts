import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force"
import type { Node, Edge } from "@xyflow/react"
import type { ServiceEdge } from "@/api/tinybird/service-map"
import type { ServiceOverview } from "@/api/tinybird/services"

export interface ServiceNodeData {
  label: string
  throughput: number
  errorRate: number
  avgLatencyMs: number
  services: string[]
  [key: string]: unknown
}

export interface ServiceEdgeData {
  callCount: number
  callsPerSecond: number
  errorCount: number
  errorRate: number
  avgDurationMs: number
  p95DurationMs: number
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
        errorRate: overview?.errorRate ?? 0,
        avgLatencyMs: overview?.p50LatencyMs ?? 0,
        services,
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
      errorCount: edge.errorCount,
      errorRate: edge.errorRate,
      avgDurationMs: edge.avgDurationMs,
      p95DurationMs: edge.p95DurationMs,
    },
  }))

  return { nodes: flowNodes, edges: flowEdges }
}

/**
 * Run d3-force simulation synchronously to compute node positions
 */
export function layoutNodes(
  nodes: Node<ServiceNodeData>[],
  edges: Edge<ServiceEdgeData>[],
): Node<ServiceNodeData>[] {
  if (nodes.length === 0) return nodes

  const simNodes: SimNode[] = nodes.map((n) => ({ id: n.id }))
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
        .distance(250),
    )
    .force("charge", forceManyBody().strength(-800))
    .force("center", forceCenter(0, 0))
    .force("collide", forceCollide(120))
    .stop()

  // Run synchronously
  for (let i = 0; i < 300; i++) {
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

import type { Node, Edge } from "@xyflow/react"
import type { ServiceDbEdge, ServiceEdge, ServicePlatform } from "@/api/tinybird/service-map"
import type { ServiceOverview } from "@/api/tinybird/services"
import type { ServiceWorkload } from "@/api/tinybird/service-infra"
import { getServiceLegendColor } from "@maple/ui/colors"

export interface ServiceNodeInfra {
	podCount: number
	workloadCount: number
}

export type ServiceNodeKind = "service" | "database"

export type ServiceMapColorMode = "service" | "health" | "platform"

export interface ServiceNodeData {
	label: string
	kind: ServiceNodeKind
	throughput: number
	tracedThroughput: number
	hasSampling: boolean
	samplingWeight: number
	errorRate: number
	avgLatencyMs: number
	services: string[]
	selected: boolean
	infra?: ServiceNodeInfra
	platform?: ServicePlatform
	runtime?: string
	dbSystem?: string
	colorMode?: ServiceMapColorMode
	[key: string]: unknown
}

const DB_NODE_COLOR = "oklch(0.55 0.05 250)"

const PLATFORM_COLORS: Record<ServicePlatform | "unknown", string> = {
	kubernetes: "oklch(0.62 0.16 250)",
	cloudflare: "oklch(0.7 0.16 50)",
	lambda: "oklch(0.7 0.18 60)",
	web: "oklch(0.65 0.15 145)",
	unknown: "oklch(0.55 0.02 270)",
}

export function getPlatformColor(platform: ServicePlatform | undefined): string {
	return PLATFORM_COLORS[platform ?? "unknown"]
}

export function getHealthColor(errorRate: number): string {
	if (errorRate > 0.05) return "var(--severity-error)"
	if (errorRate > 0.01) return "var(--severity-warn)"
	return "var(--severity-info)"
}

/**
 * Color used for a service-map node's accent stripe / minimap fill / legend swatch.
 *
 * Database nodes always use the dedicated db color regardless of mode — the
 * "color by" affordance is for slicing service nodes only.
 */
export function getServiceMapNodeColor(
	data: Pick<ServiceNodeData, "label" | "kind" | "errorRate" | "platform">,
	services: string[],
	mode: ServiceMapColorMode,
): string {
	if (data.kind === "database") return DB_NODE_COLOR
	switch (mode) {
		case "health":
			return getHealthColor(data.errorRate)
		case "platform":
			return getPlatformColor(data.platform)
		case "service":
		default:
			return getServiceLegendColor(data.label, services)
	}
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

export const DB_NODE_PREFIX = "db:"
export const dbNodeId = (system: string) => `${DB_NODE_PREFIX}${system}`

// Layout constants (defaults)
export const DEFAULT_LAYOUT_CONFIG = {
	nodeWidth: 220,
	nodeHeight: 70,
	layerGapX: 350,
	nodeGapY: 40,
	componentGapY: 60,
	disconnectedGapX: 40,
	disconnectedMarginY: 50,
} as const

export type LayoutConfig = {
	[K in keyof typeof DEFAULT_LAYOUT_CONFIG]: number
}

/**
 * Derive the unique list of services from edges + service overview data
 */
export function deriveServiceList(edges: ServiceEdge[], serviceOverviews: ServiceOverview[]): string[] {
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

export interface BuildFlowElementsInput {
	edges: ServiceEdge[]
	dbEdges?: ServiceDbEdge[]
	serviceOverviews: ServiceOverview[]
	durationSeconds: number
	serviceWorkloads?: ServiceWorkload[]
	platforms?: Map<string, ServicePlatform>
	runtimes?: Map<string, string>
}

/**
 * Build ReactFlow nodes and edges from service map data.
 *
 * Service-to-service edges become application nodes; service-to-db edges
 * (one per `db.system`) become database nodes that share the layout pipeline,
 * so the existing barycenter pass naturally pushes them to the rightmost layer.
 */
export function buildFlowElements({
	edges,
	dbEdges = [],
	serviceOverviews,
	durationSeconds,
	serviceWorkloads = [],
	platforms,
	runtimes,
}: BuildFlowElementsInput): { nodes: Node<ServiceNodeData>[]; edges: Edge<ServiceEdgeData>[] } {
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

	// Aggregate per-service infra rollup. Pod / workload counts are summed
	// across all (workloadKind, workloadName, namespace, cluster) rows that map
	// to the same serviceName — a service can run as multiple workloads (e.g.
	// canary + stable) so we don't deduplicate.
	const infraMap = new Map<string, ServiceNodeInfra>()
	for (const wl of serviceWorkloads) {
		const existing = infraMap.get(wl.serviceName) ?? { podCount: 0, workloadCount: 0 }
		existing.podCount += wl.podCount
		existing.workloadCount += 1
		infraMap.set(wl.serviceName, existing)
	}

	// Aggregate by `db.system` so multiple services calling the same database
	// land on a single node. Sum of call/error counts; weighted-average latency.
	const dbAgg = new Map<
		string,
		{ callCount: number; errorCount: number; durationSumMs: number; maxP95: number }
	>()
	for (const e of dbEdges) {
		if (!e.dbSystem) continue
		const existing = dbAgg.get(e.dbSystem) ?? {
			callCount: 0,
			errorCount: 0,
			durationSumMs: 0,
			maxP95: 0,
		}
		existing.callCount += e.callCount
		existing.errorCount += e.errorCount
		existing.durationSumMs += e.avgDurationMs * e.callCount
		existing.maxP95 = Math.max(existing.maxP95, e.p95DurationMs)
		dbAgg.set(e.dbSystem, existing)
	}

	const safeDuration = Math.max(durationSeconds, 1)

	const flowNodes: Node<ServiceNodeData>[] = services.map((service) => {
		const overview = overviewMap.get(service)
		const infra = infraMap.get(service)
		return {
			id: service,
			type: "serviceNode",
			position: { x: 0, y: 0 }, // will be set by layout
			data: {
				label: service,
				kind: "service",
				throughput: overview?.throughput ?? 0,
				tracedThroughput: overview?.tracedThroughput ?? 0,
				hasSampling: overview?.hasSampling ?? false,
				samplingWeight: overview?.samplingWeight ?? 1,
				errorRate: overview?.errorRate ?? 0,
				avgLatencyMs: overview?.p50LatencyMs ?? 0,
				services,
				selected: false,
				infra,
				platform: platforms?.get(service),
				runtime: runtimes?.get(service),
			},
		}
	})

	for (const [dbSystem, agg] of dbAgg) {
		flowNodes.push({
			id: dbNodeId(dbSystem),
			type: "serviceNode",
			position: { x: 0, y: 0 },
			data: {
				label: dbSystem,
				kind: "database",
				throughput: agg.callCount / safeDuration,
				tracedThroughput: agg.callCount / safeDuration,
				hasSampling: false,
				samplingWeight: 1,
				errorRate: agg.callCount > 0 ? agg.errorCount / agg.callCount : 0,
				avgLatencyMs: agg.callCount > 0 ? agg.durationSumMs / agg.callCount : 0,
				services,
				selected: false,
				dbSystem,
			},
		})
	}

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

	for (const e of dbEdges) {
		if (!e.dbSystem || !e.sourceService) continue
		flowEdges.push({
			id: `${e.sourceService}->${dbNodeId(e.dbSystem)}`,
			source: e.sourceService,
			target: dbNodeId(e.dbSystem),
			type: "serviceEdge",
			data: {
				callCount: e.callCount,
				callsPerSecond: e.callCount / safeDuration,
				estimatedCallsPerSecond: e.estimatedCallCount / safeDuration,
				errorCount: e.errorCount,
				errorRate: e.errorRate,
				avgDurationMs: e.avgDurationMs,
				p95DurationMs: e.p95DurationMs,
				hasSampling: e.hasSampling,
				services,
			},
		})
	}

	return { nodes: flowNodes, edges: flowEdges }
}

/**
 * Find connected components using undirected BFS.
 * Returns arrays of node IDs grouped by component, sorted largest-first.
 */
function findConnectedComponents(nodes: Node<ServiceNodeData>[], edges: Edge<ServiceEdgeData>[]): string[][] {
	const undirected = new Map<string, string[]>()
	for (const n of nodes) {
		undirected.set(n.id, [])
	}
	for (const e of edges) {
		undirected.get(e.source)?.push(e.target)
		undirected.get(e.target)?.push(e.source)
	}

	const visited = new Set<string>()
	const components: string[][] = []

	for (const n of nodes) {
		if (visited.has(n.id)) continue
		const component: string[] = []
		const queue = [n.id]
		visited.add(n.id)
		let head = 0
		while (head < queue.length) {
			const current = queue[head++]
			component.push(current)
			for (const neighbor of undirected.get(current) ?? []) {
				if (!visited.has(neighbor)) {
					visited.add(neighbor)
					queue.push(neighbor)
				}
			}
		}
		components.push(component)
	}

	components.sort((a, b) => b.length - a.length)
	return components
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
	let roots = nodes
		.filter((n) => (inDegree.get(n.id) ?? 0) === 0)
		.map((n) => n.id)
		.sort()

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

	// Any unreached nodes (shouldn't happen within a connected component, but be safe)
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
					positions.length % 2 === 1 ? positions[mid] : (positions[mid - 1] + positions[mid]) / 2
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
 * Compute node positions using pure hierarchical layout.
 * Positions are deterministic: same input always produces same output.
 */
export function layoutNodes(
	nodes: Node<ServiceNodeData>[],
	edges: Edge<ServiceEdgeData>[],
	config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
): Node<ServiceNodeData>[] {
	if (nodes.length === 0) return nodes

	const {
		nodeWidth,
		nodeHeight,
		layerGapX,
		nodeGapY,
		componentGapY,
		disconnectedGapX,
		disconnectedMarginY,
	} = config
	const positions = new Map<string, { x: number; y: number }>()

	// Find connected components
	const components = findConnectedComponents(nodes, edges)

	// Separate true isolates (no edges at all) from connected components
	const edgeNodeIds = new Set<string>()
	for (const e of edges) {
		edgeNodeIds.add(e.source)
		edgeNodeIds.add(e.target)
	}

	const connectedComponents: string[][] = []
	const isolates: string[] = []
	for (const comp of components) {
		if (comp.length === 1 && !edgeNodeIds.has(comp[0])) {
			isolates.push(comp[0])
		} else {
			connectedComponents.push(comp)
		}
	}

	// Layout each connected component, stacking vertically
	let currentYOffset = 0
	const nodeById = new Map(nodes.map((n) => [n.id, n]))

	for (const component of connectedComponents) {
		const compNodes = component.map((id) => nodeById.get(id)!).filter(Boolean)
		const compEdges = edges.filter((e) => component.includes(e.source) && component.includes(e.target))

		const layers = computeLayers(compNodes, compEdges)

		// Find the tallest layer to center vertically
		let maxLayerSize = 0
		for (const { layerSize } of layers.values()) {
			maxLayerSize = Math.max(maxLayerSize, layerSize)
		}

		const cellHeight = nodeHeight + nodeGapY
		const componentHeight = maxLayerSize * cellHeight

		for (const [id, assignment] of layers) {
			const x = assignment.layer * layerGapX
			// Center each layer's nodes vertically within the component's height
			const layerHeight = assignment.layerSize * cellHeight
			const layerOffsetY = (componentHeight - layerHeight) / 2
			const y = currentYOffset + layerOffsetY + assignment.indexInLayer * cellHeight
			positions.set(id, { x, y })
		}

		currentYOffset += componentHeight + componentGapY
	}

	// Place isolates in a horizontal row below the connected graph
	if (isolates.length > 0) {
		const rowY = currentYOffset + disconnectedMarginY
		const totalWidth = isolates.length * nodeWidth + (isolates.length - 1) * disconnectedGapX

		// Center the isolate row relative to the connected graph's horizontal extent
		let minX = Infinity
		let maxX = -Infinity
		for (const { x } of positions.values()) {
			minX = Math.min(minX, x)
			maxX = Math.max(maxX, x + nodeWidth)
		}
		const graphCenterX = positions.size > 0 ? (minX + maxX) / 2 : 0
		const startX = graphCenterX - totalWidth / 2

		for (let i = 0; i < isolates.length; i++) {
			positions.set(isolates[i], {
				x: startX + i * (nodeWidth + disconnectedGapX),
				y: rowY,
			})
		}
	}

	return nodes.map((node) => ({
		...node,
		position: positions.get(node.id) ?? { x: 0, y: 0 },
	}))
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

import type { Node, Edge } from "@xyflow/react"
import type {
	CloudflareService,
	PlanetScaleDatabaseStat,
	ServiceDbEdge,
	ServiceEdge,
	ServicePlatform,
} from "@/api/warehouse/service-map"
import type { ServiceOverview } from "@/api/warehouse/services"
import type { ServiceWorkload } from "@/api/warehouse/service-infra"
import { getServiceColor } from "@maple/ui/colors"
import { getDbNodeColor, PLANETSCALE_COLOR, resolveDbNodePresentation } from "./service-map-db"

interface ServiceNodeInfra {
	podCount: number
	workloadCount: number
}

type ServiceNodeKind = "service" | "database"

export type ServiceMapColorMode = "service" | "health" | "platform"

/** Cloudflare brand orange — accent for the detail-panel overlay section. */
export const CLOUDFLARE_COLOR = "oklch(0.7 0.16 50)"

/**
 * Cloudflare direct-integration analytics overlaid onto an instrumented Worker
 * node whose script name matched (by service name or `faas.name`).
 */
export interface CloudflareNodeMetrics {
	kind: "worker"
	requests: number
	errorRate: number
	/** Wall-time duration p99. */
	latencyP99Ms: number
	/** CPU time p99. */
	cpuP99Ms?: number
}

/**
 * PlanetScale integration data overlaid onto a trace-derived DB node whose
 * namespace matched a database in the org's polled PlanetScale inventory.
 * `stats` is absent when the inventory matched but no scraped metrics landed
 * in the window (branding still applies).
 */
export interface PlanetScaleNodeMetrics {
	/** Product kind from the inventory: "mysql" (Vitess) or "postgresql". */
	kind: string
	/** Inventory database name (canonical casing). */
	database: string
	branchCount: number
	/** Branch identities from the inventory (name + production/ready flags). */
	branches: ReadonlyArray<{ name: string; production: boolean; ready: boolean }>
	stats?: PlanetScaleDatabaseStat
}

export interface ServiceNodeData {
	label: string
	kind: ServiceNodeKind
	throughput: number
	tracedThroughput: number
	hasSampling: boolean
	samplingWeight: number
	errorRate: number
	avgLatencyMs: number
	p95LatencyMs?: number
	selected: boolean
	infra?: ServiceNodeInfra
	platform?: ServicePlatform
	runtime?: string
	dbSystem?: string
	/** Database identity (db.namespace et al.); "" for the generic per-system node. */
	dbNamespace?: string
	/** Overlaid onto matched instrumented Workers from the direct integration. */
	cloudflare?: CloudflareNodeMetrics
	/** Overlaid onto DB nodes matched against the org's PlanetScale inventory. */
	planetscale?: PlanetScaleNodeMetrics
	colorMode?: ServiceMapColorMode
	/** OTel `service.namespace`, when defined. Drives namespace-cluster layout + dotted boxes. */
	namespace?: string
	[key: string]: unknown
}

const PLATFORM_COLORS: Record<ServicePlatform | "unknown", string> = {
	kubernetes: "oklch(0.62 0.16 250)",
	cloudflare: CLOUDFLARE_COLOR,
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
 * Database nodes always use their per-system brand color regardless of mode —
 * the "color by" affordance is for slicing service nodes only.
 */
export function getServiceMapNodeColor(
	data: Pick<
		ServiceNodeData,
		"label" | "kind" | "errorRate" | "platform" | "dbSystem" | "dbNamespace" | "planetscale"
	>,
	mode: ServiceMapColorMode,
): string {
	if (data.kind === "database") {
		return data.planetscale ? PLANETSCALE_COLOR : getDbNodeColor(data.dbSystem, data.dbNamespace ?? "")
	}
	switch (mode) {
		case "health":
			return getHealthColor(data.errorRate)
		case "platform":
			return getPlatformColor(data.platform)
		case "service":
		default:
			return getServiceColor(data.label)
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
	[key: string]: unknown
}

export const DB_NODE_PREFIX = "db:"
const EDGE_ID_PREFIX = "edge:"

const encodeIdComponent = (raw: string): string => encodeURIComponent(raw)

export const dbNodeId = (system: string, namespace: string) =>
	`${DB_NODE_PREFIX}${encodeIdComponent(system)}:${encodeIdComponent(namespace)}`
const edgeIdFor = (source: string, target: string) =>
	`${EDGE_ID_PREFIX}${encodeIdComponent(source)}:${encodeIdComponent(target)}`

export const isDbNodeId = (id: string) => id.startsWith(DB_NODE_PREFIX)

/**
 * Inverse of {@link dbNodeId}. Both components are URI-encoded, so the first
 * `:` after the prefix is the separator. Legacy single-component ids (from a
 * stale layout snapshot) decode with `dbNamespace: ""` — the generic node.
 */
export const parseDbNodeId = (id: string): { dbSystem: string; dbNamespace: string } => {
	const rest = id.slice(DB_NODE_PREFIX.length)
	const sep = rest.indexOf(":")
	if (sep === -1) return { dbSystem: decodeURIComponent(rest), dbNamespace: "" }
	return {
		dbSystem: decodeURIComponent(rest.slice(0, sep)),
		dbNamespace: decodeURIComponent(rest.slice(sep + 1)),
	}
}

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

// Namespace-cluster spacing. These only set the DEFAULT spacing so the dotted
// boxes (whose geometry is recomputed in the view from live node positions)
// have breathing room — they are not the box geometry itself.
export const NS_PADDING_X = 28
export const NS_PADDING_Y = 24
export const NS_LABEL_HEIGHT = 28
const NS_CLUSTER_GAP = 80

/**
 * Derive the unique list of services from edges + service overview data
 */
function deriveServiceList(edges: ServiceEdge[], serviceOverviews: ServiceOverview[]): string[] {
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
	/** Cloudflare direct-integration Worker analytics (instrumented-Worker overlay). */
	cloudflareServices?: CloudflareService[]
	/** service.name → faas.name, so a `cloudflare-worker/{script}` can match its instrumented node. */
	faasNames?: Map<string, string>
	/** PlanetScale inventory: lowercased database name → identity + branches. */
	planetscaleDatabases?: Map<
		string,
		{
			name: string
			kind: string
			branchCount: number
			branches: ReadonlyArray<{ name: string; production: boolean; ready: boolean }>
		}
	>
	/** PlanetScale scraped-metric rollups, one per database. */
	planetscaleStats?: PlanetScaleDatabaseStat[]
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
	cloudflareServices = [],
	faasNames,
	planetscaleDatabases,
	planetscaleStats = [],
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

	// Aggregate by database identity — (db.system, db.namespace) — so services
	// calling the SAME database share a node while distinct databases of the
	// same system stay separate. Namespace-less edges ("" — legacy rows or
	// unidentified instrumentation) collapse into one generic per-system node.
	// Sum of call/error counts; weighted-average latency.
	const dbAgg = new Map<
		string,
		{
			dbSystem: string
			dbNamespace: string
			callCount: number
			errorCount: number
			durationSumMs: number
			maxP95: number
		}
	>()
	for (const e of dbEdges) {
		if (!e.dbSystem) continue
		const nodeId = dbNodeId(e.dbSystem, e.dbNamespace)
		const existing = dbAgg.get(nodeId) ?? {
			dbSystem: e.dbSystem,
			dbNamespace: e.dbNamespace,
			callCount: 0,
			errorCount: 0,
			durationSumMs: 0,
			maxP95: 0,
		}
		existing.callCount += e.callCount
		existing.errorCount += e.errorCount
		existing.durationSumMs += e.avgDurationMs * e.callCount
		existing.maxP95 = Math.max(existing.maxP95, e.p95DurationMs)
		dbAgg.set(nodeId, existing)
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
				selected: false,
				infra,
				platform: platforms?.get(service),
				runtime: runtimes?.get(service),
				namespace: overview?.serviceNamespace || undefined,
			},
		}
	})

	// PlanetScale inventory match: a DB node whose namespace equals a database
	// name in the org's polled inventory (and whose system is a PlanetScale
	// product) gets the integration's data OVERLAID — branding plus, when the
	// scraper delivered metrics in the window, live health numbers. Like the
	// Cloudflare overlay, PlanetScale data never creates nodes of its own.
	const planetscaleStatsByName = new Map(planetscaleStats.map((s) => [s.database.toLowerCase(), s]))
	const PLANETSCALE_SYSTEMS = new Set(["mysql", "mariadb", "postgresql", "postgres"])
	const planetscaleFor = (dbSystem: string, dbNamespace: string): PlanetScaleNodeMetrics | undefined => {
		if (!planetscaleDatabases || dbNamespace === "") return undefined
		if (!PLANETSCALE_SYSTEMS.has(dbSystem.toLowerCase())) return undefined
		const match = planetscaleDatabases.get(dbNamespace.toLowerCase())
		if (!match) return undefined
		return {
			kind: match.kind,
			database: match.name,
			branchCount: match.branchCount,
			branches: match.branches,
			stats: planetscaleStatsByName.get(dbNamespace.toLowerCase()),
		}
	}

	for (const [nodeId, agg] of dbAgg) {
		const planetscale = planetscaleFor(agg.dbSystem, agg.dbNamespace)
		flowNodes.push({
			id: nodeId,
			type: "serviceNode",
			position: { x: 0, y: 0 },
			data: {
				planetscale,
				// Named databases show their identity; the generic node keeps the system;
				// Hyperdrive-fronted databases collapse to a single "Hyperdrive" node.
				label: resolveDbNodePresentation(agg.dbSystem, agg.dbNamespace).title,
				kind: "database",
				throughput: agg.callCount / safeDuration,
				tracedThroughput: agg.callCount / safeDuration,
				hasSampling: false,
				samplingWeight: 1,
				errorRate: agg.callCount > 0 ? agg.errorCount / agg.callCount : 0,
				avgLatencyMs: agg.callCount > 0 ? agg.durationSumMs / agg.callCount : 0,
				p95LatencyMs: agg.maxP95,
				selected: false,
				dbSystem: agg.dbSystem,
				dbNamespace: agg.dbNamespace,
			},
		})
	}

	// Cloudflare direct-integration analytics. A Worker whose script matches an
	// instrumented service (by service name or faas.name) gets its analytics
	// OVERLAID onto that node's detail; anything without a matching real service
	// is dropped — Cloudflare data never creates nodes of its own.
	const nodeById = new Map(flowNodes.map((n) => [n.id, n]))
	const serviceNameSet = new Set(services)
	const scriptToInstrumented = new Map<string, string>()
	if (faasNames) {
		for (const [serviceName, faasName] of faasNames) {
			if (faasName) scriptToInstrumented.set(faasName, serviceName)
		}
	}
	const matchInstrumented = (script: string): string | undefined =>
		serviceNameSet.has(script) ? script : scriptToInstrumented.get(script)

	for (const cf of cloudflareServices) {
		const matchedService = matchInstrumented(cf.displayName)
		const overlayTarget = matchedService ? nodeById.get(matchedService) : undefined
		if (!overlayTarget) continue
		overlayTarget.data.cloudflare = {
			kind: cf.kind,
			requests: cf.requests,
			errorRate: cf.errorRate,
			latencyP99Ms: cf.latencyP99Ms,
			cpuP99Ms: cf.cpuP99Ms,
		}
	}

	const flowEdges: Edge<ServiceEdgeData>[] = edges.map((edge) => ({
		id: edgeIdFor(edge.sourceService, edge.targetService),
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
		},
	}))

	for (const e of dbEdges) {
		if (!e.dbSystem || !e.sourceService) continue
		flowEdges.push({
			id: edgeIdFor(e.sourceService, dbNodeId(e.dbSystem, e.dbNamespace)),
			source: e.sourceService,
			target: dbNodeId(e.dbSystem, e.dbNamespace),
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
		const sorted = nodes.toSorted((a, b) => {
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
	const layerIndices = Array.from(layerGroups.keys()).toSorted((a, b) => a - b)
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
 * A stable key over the graph TOPOLOGY only (node id set + edge pairs), ignoring
 * metric values. Node positions depend solely on topology + layout config, so
 * callers memoize the (expensive) layout on this key — metric refreshes that
 * leave the shape unchanged don't trigger a re-layout.
 */
export function topologyKey(nodes: Node[], edges: Edge[]): string {
	const nodeIds = nodes.map((n) => n.id).sort()
	const edgePairs = edges.map((e) => `${e.source}->${e.target}`).sort()
	return `${nodeIds.length}:${edgePairs.length}|${nodeIds.join(",")}|${edgePairs.join(",")}`
}

/**
 * Compute node positions using pure hierarchical layout, ignoring namespaces.
 * Positions are deterministic: same input always produces same output.
 */
export function computeFlatPositions(
	nodes: Node<ServiceNodeData>[],
	edges: Edge<ServiceEdgeData>[],
	config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
): Map<string, { x: number; y: number }> {
	if (nodes.length === 0) return new Map<string, { x: number; y: number }>()

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
		const compNodes = component.flatMap((id) => {
			const node = nodeById.get(id)
			return node ? [node] : []
		})
		const componentSet = new Set(component)
		const compEdges = edges.filter((e) => componentSet.has(e.source) && componentSet.has(e.target))

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

	return positions
}

/** A service node's namespace, or undefined for db nodes / no namespace. */
export function nodeNamespace(node: Node<ServiceNodeData>): string | undefined {
	if (node.data.kind !== "service") return undefined
	const ns = node.data.namespace
	return ns && ns.length > 0 ? ns : undefined
}

/**
 * Compute node positions. When at least one service node carries a
 * `service.namespace`, the graph is laid out as horizontal **swimlanes** — one
 * lane per namespace, plus an unboxed lane at the bottom for databases and
 * namespace-less services. Crucially, the column (x) of every node comes from a
 * SINGLE global hierarchical layering over the whole graph (call depth), so
 * cross-namespace edges keep flowing left→right instead of looping backward the
 * way per-cluster layouts (each restarting x at 0) make them. Each lane occupies
 * a disjoint vertical band so the dotted boxes never overlap. When no node has a
 * namespace, this is identical to {@link computeFlatPositions} (today's layout).
 *
 * Positions are deterministic: same input always produces same output.
 */
export function computeNodePositions(
	nodes: Node<ServiceNodeData>[],
	edges: Edge<ServiceEdgeData>[],
	config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
): Map<string, { x: number; y: number }> {
	if (nodes.length === 0) return new Map<string, { x: number; y: number }>()

	// Gate: only switch to swimlanes when the user has defined namespaces.
	const hasNamespaces = nodes.some((n) => nodeNamespace(n) !== undefined)
	if (!hasNamespaces) return computeFlatPositions(nodes, edges, config)

	const { nodeHeight, layerGapX, nodeGapY } = config
	const cellHeight = nodeHeight + nodeGapY

	// One global layering over the WHOLE graph → shared column (x) per node, plus a
	// crossing-minimized within-column order (indexInLayer) we reuse inside lanes.
	const layers = computeLayers(nodes, edges)

	// Partition into one lane per namespace + an ungrouped lane (db nodes and
	// namespace-less services).
	const lanes = new Map<string, Node<ServiceNodeData>[]>()
	const ungrouped: Node<ServiceNodeData>[] = []
	for (const node of nodes) {
		const ns = nodeNamespace(node)
		if (ns === undefined) {
			ungrouped.push(node)
			continue
		}
		const lane = lanes.get(ns)
		if (lane) lane.push(node)
		else lanes.set(ns, [node])
	}

	const positions = new Map<string, { x: number; y: number }>()

	// Place one lane's nodes at global columns, stacking same-column nodes
	// vertically (centered within the lane) and ordering them by the global
	// barycenter index to keep crossings down. Returns the lane's pixel height.
	const placeLane = (laneNodes: Node<ServiceNodeData>[], top: number): number => {
		const byColumn = new Map<number, Node<ServiceNodeData>[]>()
		for (const node of laneNodes) {
			const col = layers.get(node.id)?.layer ?? 0
			const group = byColumn.get(col)
			if (group) group.push(node)
			else byColumn.set(col, [node])
		}
		let maxColumnCount = 0
		for (const group of byColumn.values()) {
			group.sort(
				(a, b) => (layers.get(a.id)?.indexInLayer ?? 0) - (layers.get(b.id)?.indexInLayer ?? 0),
			)
			maxColumnCount = Math.max(maxColumnCount, group.length)
		}
		const laneHeight = Math.max(1, maxColumnCount) * cellHeight
		for (const [col, group] of byColumn) {
			const columnOffset = (laneHeight - group.length * cellHeight) / 2
			group.forEach((node, i) => {
				positions.set(node.id, {
					x: NS_PADDING_X + col * layerGapX,
					y: top + columnOffset + i * cellHeight,
				})
			})
		}
		return laneHeight
	}

	let yOffset = 0
	for (const ns of Array.from(lanes.keys()).sort()) {
		const laneTop = yOffset + NS_LABEL_HEIGHT + NS_PADDING_Y
		const laneHeight = placeLane(lanes.get(ns)!, laneTop)
		yOffset = laneTop + laneHeight + NS_PADDING_Y + NS_CLUSTER_GAP
	}

	// Ungrouped (databases + namespace-less services) below all lanes, no box.
	if (ungrouped.length > 0) {
		placeLane(ungrouped, yOffset + NS_CLUSTER_GAP)
	}

	return positions
}

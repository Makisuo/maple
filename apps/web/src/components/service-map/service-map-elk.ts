import type { Edge, Node } from "@xyflow/react"
import type { ElkExtendedEdge, ElkNode, ELK } from "elkjs/lib/elk-api"
import {
	NS_LABEL_HEIGHT,
	NS_PADDING_X,
	NS_PADDING_Y,
	nodeNamespace,
	type LayoutConfig,
	type ServiceEdgeData,
	type ServiceNodeData,
} from "./service-map-utils"

// ELK runs inside a dedicated web worker (elk-api + elk-worker) so laying out a
// large graph never blocks the main thread. The worker is a singleton reused
// across layouts and route visits. If the worker can't be constructed (no
// `Worker` global — vitest/jsdom — or the worker chunk fails to load), we fall
// back to the main-thread bundled build; a layout() failure on the worker path
// additionally demotes to the fallback and retries once, so a broken worker
// chunk degrades to today's behavior instead of a blank map.
let workerElk: Promise<ELK> | null = null
let mainThreadElk: Promise<ELK> | null = null
let workerBroken = false

async function createWorkerElk(): Promise<ELK> {
	if (typeof Worker === "undefined") throw new Error("Worker unavailable")
	const [{ default: ElkConstructor }, { default: ElkWorker }] = await Promise.all([
		import("elkjs/lib/elk-api.js"),
		import("elkjs/lib/elk-worker.min.js?worker"),
	])
	return new ElkConstructor({ workerFactory: () => new ElkWorker() })
}

function getMainThreadElk(): Promise<ELK> {
	if (!mainThreadElk) {
		mainThreadElk = import("elkjs/lib/elk.bundled.js").then((m) => new m.default())
	}
	return mainThreadElk
}

function getElk(): Promise<ELK> {
	if (workerBroken) return getMainThreadElk()
	if (!workerElk) {
		workerElk = createWorkerElk().catch((error) => {
			console.warn("Service map: ELK worker unavailable, using main-thread layout", error)
			workerBroken = true
			return getMainThreadElk()
		})
	}
	return workerElk
}

const ELK_CONTAINER_PREFIX = "elkns:"

// Above this node count, swap network-simplex node placement for the cheaper
// Brandes-Köpf variant and cap layered thoroughness so worst-case layout time
// stays bounded on very large orgs.
const LARGE_GRAPH_NODE_COUNT = 300

export interface ElkLayoutResult {
	positions: Map<string, { x: number; y: number }>
}

/**
 * Build the ELK input graph. Each namespace becomes a compound container node
 * (so same-namespace services stay together and the dotted boxes never
 * overlap); databases and namespace-less services sit at the top level.
 *
 * Exported for unit tests — pure, no worker involved.
 */
export function buildElkGraph(
	nodes: Node<ServiceNodeData>[],
	edges: Edge<ServiceEdgeData>[],
	config: LayoutConfig,
): ElkNode {
	const lanes = new Map<string, Node<ServiceNodeData>[]>()
	const topLevel: Node<ServiceNodeData>[] = []
	for (const node of nodes) {
		const ns = nodeNamespace(node)
		if (ns === undefined) {
			topLevel.push(node)
			continue
		}
		const lane = lanes.get(ns)
		if (lane) lane.push(node)
		else lanes.set(ns, [node])
	}
	const hasContainers = lanes.size > 0

	const toElkNode = (node: Node<ServiceNodeData>): ElkNode => ({
		id: node.id,
		width: config.nodeWidth,
		height: config.nodeHeight,
	})

	const children: ElkNode[] = []
	for (const ns of Array.from(lanes.keys()).sort()) {
		children.push({
			id: `${ELK_CONTAINER_PREFIX}${ns}`,
			children: lanes.get(ns)!.map(toElkNode),
			layoutOptions: {
				// Reserve room at the top for the namespace label chip.
				"elk.padding": `[top=${NS_LABEL_HEIGHT + NS_PADDING_Y},left=${NS_PADDING_X},bottom=${NS_PADDING_Y},right=${NS_PADDING_X}]`,
			},
		})
	}
	for (const node of topLevel) children.push(toElkNode(node))

	const elkEdges: ElkExtendedEdge[] = edges.map((edge) => ({
		id: edge.id,
		sources: [edge.source],
		targets: [edge.target],
	}))

	const layoutOptions: Record<string, string> = {
		"elk.algorithm": "layered",
		"elk.direction": "RIGHT",
		// Edges are rendered as smooth-step curves by ReactFlow (matching the
		// non-namespaced flat layout), not from ELK routes — so use POLYLINE here,
		// which reserves far less inter-node space than ORTHOGONAL and keeps the
		// graph compact instead of sprawling into long rectangular detours.
		"elk.edgeRouting": "POLYLINE",
		// Tighter layer gap: ORTHOGONAL routing needed wide channels; with curved
		// edges we can pack columns much closer.
		"elk.layered.spacing.nodeNodeBetweenLayers": String(
			Math.max(70, Math.round((config.layerGapX - config.nodeWidth) * 0.6)),
		),
		"elk.spacing.nodeNode": String(config.nodeGapY),
		"elk.spacing.edgeNode": "12",
		"elk.layered.spacing.edgeNodeBetweenLayers": "12",
		// Deterministic cycle breaking that follows the (sorted) model order, so
		// back-edges in cyclic call graphs land the same way on every layout.
		"elk.layered.cycleBreaking.strategy": "GREEDY_MODEL_ORDER",
		// Stable, source-order-aware crossing minimization for deterministic output.
		"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
	}

	if (nodes.length > LARGE_GRAPH_NODE_COUNT) {
		layoutOptions["elk.layered.nodePlacement.strategy"] = "BRANDES_KOEPF"
		layoutOptions["elk.layered.thoroughness"] = "3"
	} else {
		// Network-simplex node placement compacts the graph vertically (less
		// wasted whitespace between rows than the default).
		layoutOptions["elk.layered.nodePlacement.strategy"] = "NETWORK_SIMPLEX"
	}

	if (hasContainers) {
		// Keep cross-namespace edges flowing left→right with the rest of the graph.
		layoutOptions["elk.hierarchyHandling"] = "INCLUDE_CHILDREN"
		// Pack namespace containers close together.
		layoutOptions["elk.spacing.componentComponent"] = String(Math.round(config.componentGapY * 0.6))
	} else {
		// Flat graph: let ELK lay out each connected component independently and
		// pack them into a viewport-shaped block instead of one tall stack.
		// (Ignored by ELK when INCLUDE_CHILDREN hierarchy handling is active,
		// which is why it's only set on the flat path.)
		layoutOptions["elk.separateConnectedComponents"] = "true"
		layoutOptions["elk.aspectRatio"] = "1.8"
		layoutOptions["elk.spacing.componentComponent"] = String(config.componentGapY)
	}

	return {
		id: "root",
		layoutOptions,
		children,
		edges: elkEdges,
	}
}

/**
 * Lay the service map out with ELK's layered algorithm (in a web worker; see
 * {@link getElk} for the fallback ladder).
 *
 * Only node POSITIONS are returned — edges are rendered as ReactFlow smooth-step
 * curves. ELK's own orthogonal edge routing is intentionally not used: it turned
 * long cross-namespace edges into a sprawl of rectangular detours.
 *
 * Deterministic: ELK layered uses no randomness, so the same topology yields the
 * same layout (callers memoize on a topology key).
 */
export async function layoutServiceMapWithElk(
	nodes: Node<ServiceNodeData>[],
	edges: Edge<ServiceEdgeData>[],
	config: LayoutConfig,
): Promise<ElkLayoutResult> {
	const graph = buildElkGraph(nodes, edges, config)

	let result: ElkNode
	try {
		const elk = await getElk()
		result = await elk.layout(graph)
	} catch (error) {
		// A failure on the worker path (e.g. the worker chunk 404s at runtime)
		// demotes to the main-thread build and retries once.
		if (workerBroken) throw error
		console.warn("Service map: ELK worker layout failed, retrying on main thread", error)
		workerBroken = true
		const elk = await getMainThreadElk()
		result = await elk.layout(graph)
	}

	const positions = new Map<string, { x: number; y: number }>()

	// Walk the result tree accumulating absolute offsets. Leaf nodes get
	// positions; container nodes are synthetic (recurse into them).
	const walk = (node: ElkNode, offsetX: number, offsetY: number) => {
		for (const child of node.children ?? []) {
			const ax = offsetX + (child.x ?? 0)
			const ay = offsetY + (child.y ?? 0)
			if (child.children && child.children.length > 0) {
				walk(child, ax, ay)
			} else {
				positions.set(child.id, { x: ax, y: ay })
			}
		}
	}
	walk(result, 0, 0)

	return { positions }
}

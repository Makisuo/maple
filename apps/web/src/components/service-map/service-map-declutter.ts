import type { Edge, Node } from "@xyflow/react"
import {
	edgeIdFor,
	nodeNamespace,
	nsAggregateId,
	type ServiceEdgeData,
	type ServiceNodeData,
} from "./service-map-utils"

/**
 * Pure declutter pipeline applied between {@link buildFlowElements} and layout:
 * collapse namespaces → focus subgraph → traffic filter. Everything downstream
 * (topology key, ELK layout, persisted positions, particles, minimap, namespace
 * boxes) operates on the effective graph this returns, so the stages compose
 * with the existing signature caching for free.
 */

export interface DeclutterFocus {
	/** Node id to focus (a service, database, or namespace-aggregate id). */
	serviceId: string
	hops: 1 | 2
	/** `dim` keeps topology and only marks non-neighbors; `hide` removes them (re-layout). */
	mode: "dim" | "hide"
}

export interface DeclutterState {
	/**
	 * 0 = off. An edge is hidden when its callsPerSecond is below
	 * `minTrafficPct/100 * max edge callsPerSecond`; nodes whose edges are all
	 * hidden disappear with them (true isolates stay — zero-traffic services are
	 * worth seeing).
	 */
	minTrafficPct: number
	focus: DeclutterFocus | null
	collapsedNamespaces: readonly string[]
}

export const DECLUTTER_OFF: DeclutterState = {
	minTrafficPct: 0,
	focus: null,
	collapsedNamespaces: [],
}

export interface DeclutterResult {
	nodes: Node<ServiceNodeData>[]
	edges: Edge<ServiceEdgeData>[]
	/** Nodes/edges removed by the traffic filter (not by collapse or focus-hide). */
	hiddenNodeCount: number
	hiddenEdgeCount: number
	/** Focus dim-mode: node/edge ids to render at reduced opacity. */
	dimmedNodeIds: ReadonlySet<string>
	dimmedEdgeIds: ReadonlySet<string>
	/** The focus target no longer exists in the graph (renamed / gone). */
	focusMissing: boolean
}

const EMPTY_SET: ReadonlySet<string> = new Set()

/** Weighted-merge of two parallel edges' metrics (deterministic, order-free sums). */
function mergeEdgeData(a: ServiceEdgeData, b: ServiceEdgeData): ServiceEdgeData {
	const callCount = a.callCount + b.callCount
	const errorCount = a.errorCount + b.errorCount
	return {
		callCount,
		callsPerSecond: a.callsPerSecond + b.callsPerSecond,
		estimatedCallsPerSecond: a.estimatedCallsPerSecond + b.estimatedCallsPerSecond,
		errorCount,
		errorRate: callCount > 0 ? errorCount / callCount : 0,
		avgDurationMs:
			callCount > 0 ? (a.avgDurationMs * a.callCount + b.avgDurationMs * b.callCount) / callCount : 0,
		p95DurationMs: Math.max(a.p95DurationMs, b.p95DurationMs),
		hasSampling: a.hasSampling || b.hasSampling,
	}
}

interface CollapseOutput {
	nodes: Node<ServiceNodeData>[]
	edges: Edge<ServiceEdgeData>[]
	/** Collapsed member id → its aggregate node id (for remapping focus/selection). */
	memberToAggregate: ReadonlyMap<string, string>
}

/**
 * Replace each collapsed namespace's member services with one aggregate node
 * (`nsagg:<ns>`), re-pointing edges at it: intra-namespace edges are dropped,
 * parallel edges between the same remapped (source, target) pair merge with
 * deterministic ids so {@link topologyKey} stays stable.
 */
function collapseNamespaces(
	nodes: Node<ServiceNodeData>[],
	edges: Edge<ServiceEdgeData>[],
	collapsedNamespaces: readonly string[],
): CollapseOutput {
	if (collapsedNamespaces.length === 0) {
		return { nodes, edges, memberToAggregate: new Map() }
	}
	const collapsed = new Set(collapsedNamespaces)
	const memberToAggregate = new Map<string, string>()
	const members = new Map<string, Node<ServiceNodeData>[]>()
	const keptNodes: Node<ServiceNodeData>[] = []
	for (const node of nodes) {
		const ns = nodeNamespace(node)
		if (ns !== undefined && collapsed.has(ns)) {
			memberToAggregate.set(node.id, nsAggregateId(ns))
			const list = members.get(ns)
			if (list) list.push(node)
			else members.set(ns, [node])
		} else {
			keptNodes.push(node)
		}
	}
	if (members.size === 0) return { nodes, edges, memberToAggregate }

	for (const ns of Array.from(members.keys()).sort()) {
		const group = members.get(ns)!
		let throughput = 0
		let tracedThroughput = 0
		let errorWeighted = 0
		let latencyWeighted = 0
		let hasSampling = false
		for (const node of group) {
			throughput += node.data.throughput
			tracedThroughput += node.data.tracedThroughput
			errorWeighted += node.data.errorRate * node.data.throughput
			latencyWeighted += node.data.avgLatencyMs * node.data.throughput
			hasSampling ||= node.data.hasSampling
		}
		keptNodes.push({
			id: nsAggregateId(ns),
			type: "serviceNode",
			position: { x: 0, y: 0 },
			data: {
				label: ns,
				kind: "namespaceAggregate",
				nsMemberCount: group.length,
				throughput,
				tracedThroughput,
				hasSampling,
				samplingWeight: 1,
				errorRate: throughput > 0 ? errorWeighted / throughput : 0,
				avgLatencyMs: throughput > 0 ? latencyWeighted / throughput : 0,
				selected: false,
				// Deliberately NO `namespace`: the aggregate must not spawn a dotted
				// box or join an ELK namespace container.
			},
		})
	}

	// Remap + merge edges. Iteration order doesn't affect the result: sums and
	// maxes are order-free and the merged id is derived from the endpoints.
	const merged = new Map<string, Edge<ServiceEdgeData>>()
	const outEdges: Edge<ServiceEdgeData>[] = []
	for (const edge of edges) {
		const source = memberToAggregate.get(edge.source) ?? edge.source
		const target = memberToAggregate.get(edge.target) ?? edge.target
		if (source === edge.source && target === edge.target) {
			outEdges.push(edge)
			continue
		}
		// Intra-namespace traffic disappears inside the aggregate.
		if (source === target) continue
		const id = edgeIdFor(source, target)
		const existing = merged.get(id)
		if (existing) {
			existing.data = mergeEdgeData(existing.data!, edge.data!)
		} else {
			merged.set(id, { ...edge, id, source, target, data: { ...edge.data! } })
		}
	}
	// Remapped ids always contain a synthetic `nsagg:` endpoint, which never
	// appears in original edges — so merged ids can't collide with kept ones.
	outEdges.push(...merged.values())

	return { nodes: keptNodes, edges: outEdges, memberToAggregate }
}

interface FocusOutput {
	nodes: Node<ServiceNodeData>[]
	edges: Edge<ServiceEdgeData>[]
	dimmedNodeIds: ReadonlySet<string>
	dimmedEdgeIds: ReadonlySet<string>
	/** Focus root + neighborhood, exempt from the traffic filter. */
	neighborhood: ReadonlySet<string>
	focusMissing: boolean
}

/** Undirected BFS neighborhood of `rootId` up to `hops`. */
function bfsNeighborhood(
	rootId: string,
	nodes: Node<ServiceNodeData>[],
	edges: Edge<ServiceEdgeData>[],
	hops: number,
): Set<string> {
	const adjacency = new Map<string, string[]>()
	for (const n of nodes) adjacency.set(n.id, [])
	for (const e of edges) {
		adjacency.get(e.source)?.push(e.target)
		adjacency.get(e.target)?.push(e.source)
	}
	const depth = new Map<string, number>([[rootId, 0]])
	const queue = [rootId]
	let head = 0
	while (head < queue.length) {
		const current = queue[head++]
		const d = depth.get(current)!
		if (d >= hops) continue
		for (const neighbor of adjacency.get(current) ?? []) {
			if (!depth.has(neighbor)) {
				depth.set(neighbor, d + 1)
				queue.push(neighbor)
			}
		}
	}
	return new Set(depth.keys())
}

function focusSubgraph(
	nodes: Node<ServiceNodeData>[],
	edges: Edge<ServiceEdgeData>[],
	focus: DeclutterFocus | null,
	memberToAggregate: ReadonlyMap<string, string>,
): FocusOutput {
	const identity: FocusOutput = {
		nodes,
		edges,
		dimmedNodeIds: EMPTY_SET,
		dimmedEdgeIds: EMPTY_SET,
		neighborhood: EMPTY_SET,
		focusMissing: false,
	}
	if (!focus) return identity

	// A focus target collapsed into an aggregate follows it into the aggregate.
	const rootId = memberToAggregate.get(focus.serviceId) ?? focus.serviceId
	if (!nodes.some((n) => n.id === rootId)) {
		return { ...identity, focusMissing: true }
	}

	const neighborhood = bfsNeighborhood(rootId, nodes, edges, focus.hops)

	if (focus.mode === "hide") {
		return {
			nodes: nodes.filter((n) => neighborhood.has(n.id)),
			edges: edges.filter((e) => neighborhood.has(e.source) && neighborhood.has(e.target)),
			dimmedNodeIds: EMPTY_SET,
			dimmedEdgeIds: EMPTY_SET,
			neighborhood,
			focusMissing: false,
		}
	}

	const dimmedNodeIds = new Set<string>()
	for (const n of nodes) {
		if (!neighborhood.has(n.id)) dimmedNodeIds.add(n.id)
	}
	const dimmedEdgeIds = new Set<string>()
	for (const e of edges) {
		if (!neighborhood.has(e.source) || !neighborhood.has(e.target)) dimmedEdgeIds.add(e.id)
	}
	return { nodes, edges, dimmedNodeIds, dimmedEdgeIds, neighborhood, focusMissing: false }
}

export function applyDeclutter(
	nodes: Node<ServiceNodeData>[],
	edges: Edge<ServiceEdgeData>[],
	state: DeclutterState,
	/** Node ids never removed by the traffic filter (e.g. the current selection). */
	exemptIds: ReadonlySet<string> = EMPTY_SET,
): DeclutterResult {
	const collapsed = collapseNamespaces(nodes, edges, state.collapsedNamespaces)
	const focused = focusSubgraph(collapsed.nodes, collapsed.edges, state.focus, collapsed.memberToAggregate)

	let outNodes = focused.nodes
	let outEdges = focused.edges
	let hiddenNodeCount = 0
	let hiddenEdgeCount = 0

	if (state.minTrafficPct > 0 && outEdges.length > 0) {
		let maxCps = 0
		for (const e of outEdges) {
			const cps = e.data?.callsPerSecond ?? 0
			if (cps > maxCps) maxCps = cps
		}
		const threshold = (state.minTrafficPct / 100) * maxCps

		// Nodes with at least one incident edge BEFORE filtering — true isolates
		// (never had edges) are deliberately kept visible.
		const hadEdges = new Set<string>()
		for (const e of outEdges) {
			hadEdges.add(e.source)
			hadEdges.add(e.target)
		}

		const keptEdges = outEdges.filter((e) => (e.data?.callsPerSecond ?? 0) >= threshold)
		hiddenEdgeCount = outEdges.length - keptEdges.length

		if (hiddenEdgeCount > 0) {
			const stillConnected = new Set<string>()
			for (const e of keptEdges) {
				stillConnected.add(e.source)
				stillConnected.add(e.target)
			}
			const keptNodes = outNodes.filter(
				(n) =>
					!hadEdges.has(n.id) ||
					stillConnected.has(n.id) ||
					exemptIds.has(n.id) ||
					focused.neighborhood.has(n.id),
			)
			hiddenNodeCount = outNodes.length - keptNodes.length
			// Edges must never dangle: an exempt node keeps its node card, not its
			// filtered edges, so kept edges only ever reference kept nodes.
			outNodes = keptNodes
			outEdges = keptEdges
		}
	}

	return {
		nodes: outNodes,
		edges: outEdges,
		hiddenNodeCount,
		hiddenEdgeCount,
		dimmedNodeIds: focused.dimmedNodeIds,
		dimmedEdgeIds: focused.dimmedEdgeIds,
		focusMissing: focused.focusMissing,
	}
}

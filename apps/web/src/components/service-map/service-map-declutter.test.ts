import { describe, expect, it } from "vitest"
import type { Edge, Node } from "@xyflow/react"
import { applyDeclutter, DECLUTTER_OFF, type DeclutterState } from "./service-map-declutter"
import {
	edgeIdFor,
	nsAggregateId,
	topologyKey,
	type ServiceEdgeData,
	type ServiceNodeData,
} from "./service-map-utils"

const node = (id: string, overrides: Partial<ServiceNodeData> = {}): Node<ServiceNodeData> => ({
	id,
	type: "serviceNode",
	position: { x: 0, y: 0 },
	data: {
		label: id,
		kind: "service",
		throughput: 10,
		tracedThroughput: 10,
		hasSampling: false,
		samplingWeight: 1,
		errorRate: 0,
		avgLatencyMs: 5,
		selected: false,
		...overrides,
	},
})

const edge = (
	source: string,
	target: string,
	overrides: Partial<ServiceEdgeData> = {},
): Edge<ServiceEdgeData> => ({
	id: edgeIdFor(source, target),
	source,
	target,
	type: "serviceEdge",
	data: {
		callCount: 100,
		callsPerSecond: 10,
		estimatedCallsPerSecond: 10,
		errorCount: 0,
		errorRate: 0,
		avgDurationMs: 5,
		p95DurationMs: 10,
		hasSampling: false,
		...overrides,
	},
})

const state = (overrides: Partial<DeclutterState>): DeclutterState => ({
	...DECLUTTER_OFF,
	...overrides,
})

describe("applyDeclutter — identity", () => {
	it("returns the graph unchanged when everything is off", () => {
		const nodes = [node("a"), node("b")]
		const edges = [edge("a", "b")]
		const result = applyDeclutter(nodes, edges, DECLUTTER_OFF)
		expect(result.nodes).toBe(nodes)
		expect(result.edges).toBe(edges)
		expect(result.hiddenNodeCount).toBe(0)
		expect(result.hiddenEdgeCount).toBe(0)
		expect(result.dimmedNodeIds.size).toBe(0)
	})
})

describe("applyDeclutter — traffic filter", () => {
	const graph = () => ({
		nodes: [node("hot-src"), node("hot-dst"), node("cold-src"), node("cold-dst"), node("isolate")],
		edges: [
			edge("hot-src", "hot-dst", { callsPerSecond: 100 }),
			edge("cold-src", "cold-dst", { callsPerSecond: 0.5 }),
		],
	})

	it("hides edges below pct-of-peak and orphans their nodes", () => {
		const { nodes, edges } = graph()
		// threshold = 5% of 100 = 5 cps → cold edge (0.5) hidden
		const result = applyDeclutter(nodes, edges, state({ minTrafficPct: 5 }))
		expect(result.edges.map((e) => e.id)).toEqual([edgeIdFor("hot-src", "hot-dst")])
		expect(result.hiddenEdgeCount).toBe(1)
		expect(result.nodes.map((n) => n.id)).not.toContain("cold-src")
		expect(result.nodes.map((n) => n.id)).not.toContain("cold-dst")
		expect(result.hiddenNodeCount).toBe(2)
	})

	it("keeps true isolates (they never had edges)", () => {
		const { nodes, edges } = graph()
		const result = applyDeclutter(nodes, edges, state({ minTrafficPct: 5 }))
		expect(result.nodes.map((n) => n.id)).toContain("isolate")
	})

	it("never hides exempt nodes (current selection)", () => {
		const { nodes, edges } = graph()
		const result = applyDeclutter(nodes, edges, state({ minTrafficPct: 5 }), new Set(["cold-src"]))
		expect(result.nodes.map((n) => n.id)).toContain("cold-src")
		expect(result.nodes.map((n) => n.id)).not.toContain("cold-dst")
		expect(result.hiddenNodeCount).toBe(1)
	})

	it("0% threshold is the identity", () => {
		const { nodes, edges } = graph()
		const result = applyDeclutter(nodes, edges, state({ minTrafficPct: 0 }))
		expect(result.edges).toHaveLength(2)
		expect(result.nodes).toHaveLength(5)
	})

	it("never hides structural relation edges (they carry no traffic by definition)", () => {
		const { nodes, edges } = graph()
		// e.g. the Hyperdrive → origin-database link: zero traffic, pure structure.
		edges.push(
			edge("hot-dst", "cold-dst", {
				callCount: 0,
				callsPerSecond: 0,
				estimatedCallsPerSecond: 0,
				relation: "hyperdrive-origin",
			}),
		)
		const result = applyDeclutter(nodes, edges, state({ minTrafficPct: 5 }))
		expect(result.edges.map((e) => e.id)).toContain(edgeIdFor("hot-dst", "cold-dst"))
		// Its endpoint stays connected — kept edges never dangle.
		expect(result.nodes.map((n) => n.id)).toContain("cold-dst")
		// The zero-traffic TRAFFIC edge is still filtered as before.
		expect(result.edges.map((e) => e.id)).not.toContain(edgeIdFor("cold-src", "cold-dst"))
	})
})

describe("applyDeclutter — focus", () => {
	// chain: a → b → c → d, plus isolate x
	const graph = () => ({
		nodes: [node("a"), node("b"), node("c"), node("d"), node("x")],
		edges: [edge("a", "b"), edge("b", "c"), edge("c", "d")],
	})

	it("dim mode keeps topology and dims non-neighbors (1 hop, undirected)", () => {
		const { nodes, edges } = graph()
		const result = applyDeclutter(
			nodes,
			edges,
			state({ focus: { serviceId: "b", hops: 1, mode: "dim" } }),
		)
		expect(result.nodes).toHaveLength(5)
		expect(result.edges).toHaveLength(3)
		expect([...result.dimmedNodeIds].sort()).toEqual(["d", "x"])
		// c→d leaves the neighborhood → dimmed; a→b and b→c stay bright
		expect([...result.dimmedEdgeIds]).toEqual([edgeIdFor("c", "d")])
	})

	it("2 hops widens the neighborhood", () => {
		const { nodes, edges } = graph()
		const result = applyDeclutter(
			nodes,
			edges,
			state({ focus: { serviceId: "b", hops: 2, mode: "dim" } }),
		)
		expect([...result.dimmedNodeIds]).toEqual(["x"])
		expect(result.dimmedEdgeIds.size).toBe(0)
	})

	it("hide mode removes non-neighbors and their edges", () => {
		const { nodes, edges } = graph()
		const result = applyDeclutter(
			nodes,
			edges,
			state({ focus: { serviceId: "b", hops: 1, mode: "hide" } }),
		)
		expect(result.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"])
		expect(result.edges.map((e) => e.id).sort()).toEqual(
			[edgeIdFor("a", "b"), edgeIdFor("b", "c")].sort(),
		)
	})

	it("missing focus target is the identity plus focusMissing", () => {
		const { nodes, edges } = graph()
		const result = applyDeclutter(
			nodes,
			edges,
			state({ focus: { serviceId: "gone", hops: 1, mode: "hide" } }),
		)
		expect(result.focusMissing).toBe(true)
		expect(result.nodes).toHaveLength(5)
		expect(result.edges).toHaveLength(3)
	})

	it("focus neighborhood is exempt from the traffic filter", () => {
		const nodes = [node("hot-src"), node("hot-dst"), node("quiet"), node("root")]
		const edges = [
			edge("hot-src", "hot-dst", { callsPerSecond: 100 }),
			edge("root", "quiet", { callsPerSecond: 0.1 }),
		]
		const result = applyDeclutter(
			nodes,
			edges,
			state({ minTrafficPct: 5, focus: { serviceId: "root", hops: 1, mode: "dim" } }),
		)
		// The quiet edge itself is filtered, but its nodes survive via the focus.
		expect(result.edges.map((e) => e.id)).toEqual([edgeIdFor("hot-src", "hot-dst")])
		expect(result.nodes.map((n) => n.id)).toContain("root")
		expect(result.nodes.map((n) => n.id)).toContain("quiet")
	})
})

describe("applyDeclutter — namespace collapse", () => {
	// payments: [checkout, ledger]; platform: [gateway]; db node; external svc
	const graph = () => ({
		nodes: [
			node("checkout", { namespace: "payments", throughput: 30, errorRate: 0.1, avgLatencyMs: 10 }),
			node("ledger", { namespace: "payments", throughput: 10, errorRate: 0.02, avgLatencyMs: 30 }),
			node("gateway", { namespace: "platform" }),
			node("db:postgresql:main", { kind: "database" }),
			node("external"),
		],
		edges: [
			edge("gateway", "checkout", { callCount: 100, callsPerSecond: 10 }),
			edge("gateway", "ledger", { callCount: 50, callsPerSecond: 5, errorCount: 10, errorRate: 0.2 }),
			edge("checkout", "ledger", { callCount: 999, callsPerSecond: 99 }),
			edge("checkout", "db:postgresql:main", { callCount: 40, callsPerSecond: 4 }),
			edge("external", "gateway"),
		],
	})

	it("folds members into one aggregate with weighted metrics", () => {
		const { nodes, edges } = graph()
		const result = applyDeclutter(nodes, edges, state({ collapsedNamespaces: ["payments"] }))
		const agg = result.nodes.find((n) => n.id === nsAggregateId("payments"))
		expect(agg).toBeDefined()
		expect(agg!.data.kind).toBe("namespaceAggregate")
		expect(agg!.data.nsMemberCount).toBe(2)
		expect(agg!.data.throughput).toBe(40)
		// throughput-weighted: (0.1*30 + 0.02*10) / 40 = 0.08
		expect(agg!.data.errorRate).toBeCloseTo(0.08)
		// (10*30 + 30*10) / 40 = 15
		expect(agg!.data.avgLatencyMs).toBeCloseTo(15)
		expect(result.nodes.map((n) => n.id)).not.toContain("checkout")
		expect(result.nodes.map((n) => n.id)).not.toContain("ledger")
	})

	it("merges parallel remapped edges, drops intra-namespace ones, remaps db edges", () => {
		const { nodes, edges } = graph()
		const result = applyDeclutter(nodes, edges, state({ collapsedNamespaces: ["payments"] }))
		const agg = nsAggregateId("payments")

		// gateway→checkout and gateway→ledger merge into gateway→agg
		const inbound = result.edges.find((e) => e.id === edgeIdFor("gateway", agg))
		expect(inbound).toBeDefined()
		expect(inbound!.data!.callCount).toBe(150)
		expect(inbound!.data!.callsPerSecond).toBe(15)
		expect(inbound!.data!.errorCount).toBe(10)
		expect(inbound!.data!.errorRate).toBeCloseTo(10 / 150)

		// checkout→ledger is intra-namespace → gone
		expect(result.edges.some((e) => e.data!.callCount === 999)).toBe(false)

		// checkout→db remaps to agg→db
		expect(result.edges.some((e) => e.id === edgeIdFor(agg, "db:postgresql:main"))).toBe(true)

		// untouched edge survives as-is
		expect(result.edges.some((e) => e.id === edgeIdFor("external", "gateway"))).toBe(true)
	})

	it("does not mutate the input graph", () => {
		const { nodes, edges } = graph()
		const before = JSON.stringify({ nodes, edges })
		applyDeclutter(nodes, edges, state({ collapsedNamespaces: ["payments"] }))
		expect(JSON.stringify({ nodes, edges })).toBe(before)
	})

	it("produces a stable topology key regardless of edge order", () => {
		const { nodes, edges } = graph()
		const a = applyDeclutter(nodes, edges, state({ collapsedNamespaces: ["payments"] }))
		const b = applyDeclutter(nodes, [...edges].reverse(), state({ collapsedNamespaces: ["payments"] }))
		expect(topologyKey(a.nodes, a.edges)).toBe(topologyKey(b.nodes, b.edges))
	})

	it("collapsing both endpoints' namespaces links the two aggregates", () => {
		const { nodes, edges } = graph()
		const result = applyDeclutter(
			nodes,
			edges,
			state({ collapsedNamespaces: ["payments", "platform"] }),
		)
		const link = result.edges.find(
			(e) => e.id === edgeIdFor(nsAggregateId("platform"), nsAggregateId("payments")),
		)
		expect(link).toBeDefined()
		expect(link!.data!.callCount).toBe(150)
	})

	it("focus on a collapsed member follows it into the aggregate", () => {
		const { nodes, edges } = graph()
		const result = applyDeclutter(
			nodes,
			edges,
			state({
				collapsedNamespaces: ["payments"],
				focus: { serviceId: "checkout", hops: 1, mode: "hide" },
			}),
		)
		expect(result.focusMissing).toBe(false)
		const ids = result.nodes.map((n) => n.id).sort()
		// aggregate + its direct neighbors (gateway, db)
		expect(ids).toEqual(["db:postgresql:main", "gateway", nsAggregateId("payments")].sort())
	})
})

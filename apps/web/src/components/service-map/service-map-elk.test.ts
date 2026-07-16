import { describe, expect, it } from "vitest"
import type { Edge, Node } from "@xyflow/react"
import { buildElkGraph } from "./service-map-elk"
import { DEFAULT_LAYOUT_CONFIG, type ServiceEdgeData, type ServiceNodeData } from "./service-map-utils"

const node = (id: string, namespace?: string): Node<ServiceNodeData> => ({
	id,
	type: "serviceNode",
	position: { x: 0, y: 0 },
	data: {
		label: id,
		kind: "service",
		throughput: 1,
		tracedThroughput: 1,
		hasSampling: false,
		samplingWeight: 1,
		errorRate: 0,
		avgLatencyMs: 1,
		selected: false,
		namespace,
	},
})

const edge = (source: string, target: string): Edge<ServiceEdgeData> => ({
	id: `edge:${source}:${target}`,
	source,
	target,
	type: "serviceEdge",
	data: {
		callCount: 1,
		callsPerSecond: 1,
		estimatedCallsPerSecond: 1,
		errorCount: 0,
		errorRate: 0,
		avgDurationMs: 1,
		p95DurationMs: 1,
		hasSampling: false,
	},
})

describe("buildElkGraph", () => {
	it("flat graphs pack connected components (no hierarchy handling)", () => {
		const graph = buildElkGraph([node("a"), node("b")], [edge("a", "b")], DEFAULT_LAYOUT_CONFIG)
		expect(graph.layoutOptions!["elk.separateConnectedComponents"]).toBe("true")
		expect(graph.layoutOptions!["elk.aspectRatio"]).toBe("1.8")
		expect(graph.layoutOptions!["elk.hierarchyHandling"]).toBeUndefined()
		expect(graph.children!.map((c) => c.id).sort()).toEqual(["a", "b"])
	})

	it("namespaced graphs get compound containers with label padding instead", () => {
		const graph = buildElkGraph(
			[node("a", "payments"), node("b", "payments"), node("c")],
			[edge("a", "b")],
			DEFAULT_LAYOUT_CONFIG,
		)
		expect(graph.layoutOptions!["elk.hierarchyHandling"]).toBe("INCLUDE_CHILDREN")
		expect(graph.layoutOptions!["elk.separateConnectedComponents"]).toBeUndefined()
		const container = graph.children!.find((c) => c.id === "elkns:payments")
		expect(container).toBeDefined()
		expect(container!.children!.map((c) => c.id).sort()).toEqual(["a", "b"])
		expect(container!.layoutOptions!["elk.padding"]).toContain("top=")
		// namespace-less node stays top-level
		expect(graph.children!.some((c) => c.id === "c")).toBe(true)
	})

	it("switches to bounded node placement above the large-graph threshold", () => {
		const small = buildElkGraph([node("a")], [], DEFAULT_LAYOUT_CONFIG)
		expect(small.layoutOptions!["elk.layered.nodePlacement.strategy"]).toBe("NETWORK_SIMPLEX")

		const many = Array.from({ length: 301 }, (_, i) => node(`svc-${i}`))
		const large = buildElkGraph(many, [], DEFAULT_LAYOUT_CONFIG)
		expect(large.layoutOptions!["elk.layered.nodePlacement.strategy"]).toBe("BRANDES_KOEPF")
		expect(large.layoutOptions!["elk.layered.thoroughness"]).toBe("3")
	})

	it("always uses deterministic ordering + cycle breaking", () => {
		const graph = buildElkGraph([node("a")], [], DEFAULT_LAYOUT_CONFIG)
		expect(graph.layoutOptions!["elk.layered.cycleBreaking.strategy"]).toBe("GREEDY_MODEL_ORDER")
		expect(graph.layoutOptions!["elk.layered.considerModelOrder.strategy"]).toBe("NODES_AND_EDGES")
	})
})

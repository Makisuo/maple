import { describe, expect, it } from "vitest"
import type { Edge, Node } from "@xyflow/react"
import type { ServiceNodeData, ServiceEdgeData } from "../service-map-utils"
import { liveTopology } from "./live-topology"

const node = (id: string, data: Partial<ServiceNodeData> = {}): Node<ServiceNodeData> => ({
	id,
	position: { x: 0, y: 0 },
	data: {
		label: id,
		kind: "service",
		throughput: 120,
		tracedThroughput: 12,
		hasSampling: true,
		samplingWeight: 10,
		errorRate: 0.03,
		avgLatencyMs: 18,
		selected: false,
		...data,
	},
})
const edge = (
	source: string,
	target: string,
	data: Partial<ServiceEdgeData> = {},
): Edge<ServiceEdgeData> => ({
	id: `${source}->${target}`,
	source,
	target,
	data: {
		callCount: 120,
		callsPerSecond: 2,
		estimatedCallsPerSecond: 20,
		errorCount: 1,
		errorRate: 0.01,
		avgDurationMs: 12,
		maxDurationMs: 240,
		hasSampling: true,
		...data,
	},
})
const empty = new Set<string>()
describe("live 3D topology", () => {
	it("uses weighted rates and preserves max latency without inventing a percentile", () => {
		const topology = liveTopology(
			[
				node("api", { namespace: "checkout", runtime: "bun" }),
				node("db", { kind: "database", dbSystem: "postgresql", p95LatencyMs: 42 }),
			],
			[edge("api", "db")],
			empty,
			empty,
		)
		expect(topology.nodes[0]).toMatchObject({
			id: "api",
			throughput: 120,
			hasSampling: true,
			namespace: "checkout",
			runtime: "bun",
			errorRate: 0.03,
		})
		expect(topology.nodes[1]).toMatchObject({ kind: "database", system: "postgresql", p95LatencyMs: 42 })
		expect(topology.edges[0]).toMatchObject({
			callsPerSecond: 20,
			hasSampling: true,
			avgLatencyMs: 12,
			maxLatencyMs: 240,
		})
		expect(topology.nodes[1]?.runtime).toBeUndefined()
		expect(topology.edges[0]?.p95LatencyMs).toBeUndefined()
	})
	it("keeps structural relations idle and propagates the existing focus dim state", () => {
		const topology = liveTopology(
			[node("proxy"), node("db")],
			[
				edge("proxy", "db", {
					relation: "hyperdrive-origin",
					callsPerSecond: 0,
					estimatedCallsPerSecond: 0,
				}),
			],
			new Set(["db"]),
			new Set(["proxy->db"]),
		)
		expect(topology.nodes[1]?.dimmed).toBe(true)
		expect(topology.edges[0]).toMatchObject({
			relation: "hyperdrive-origin",
			callsPerSecond: 0,
			dimmed: true,
		})
	})
	it("handles collapsed namespaces, queue systems, and missing edge endpoints", () => {
		const topology = liveTopology(
			[
				node("ns", { kind: "namespaceAggregate", label: "workers", nsMemberCount: 8 }),
				node("queue", { kind: "database", dbSystem: "kafka" }),
			],
			[edge("ns", "queue"), edge("absent", "queue")],
			empty,
			empty,
		)
		expect(topology.nodes[0]?.label).toBe("workers (8)")
		expect(topology.nodes[1]?.kind).toBe("queue")
		expect(topology.edges).toHaveLength(1)
		expect(liveTopology([], [], empty, empty)).toEqual({ nodes: [], edges: [] })
	})
})

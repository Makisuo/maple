import { describe, expect, it } from "vitest"

import { oklchToHex } from "./color"
import { SERVICE_MAP_3D_TOPOLOGY } from "./fixture"
import { bezierControl, computeTiers, layoutGraph, nodeScale, pipeRadius, sampleQuadratic } from "./layout"

const { nodes, edges } = SERVICE_MAP_3D_TOPOLOGY

describe("computeTiers", () => {
	it("puts entry nodes on tier 0 and pushes callees down", () => {
		const tiers = computeTiers(nodes, edges)
		expect(tiers.get("browser")).toBe(0)
		expect(tiers.get("cdn-edge")).toBe(1)
		expect(tiers.get("api-gateway")).toBe(2)
		expect(tiers.get("storefront-bff")).toBe(3)
	})

	it("uses the longest path, so a node sits below every caller", () => {
		const tiers = computeTiers(nodes, edges)
		for (const edge of edges) {
			expect(tiers.get(edge.target)!).toBeGreaterThan(tiers.get(edge.source)!)
		}
	})

	it("terminates on a cycle instead of relaxing forever", () => {
		const cyclic = [
			{ id: "a", label: "a", kind: "service" as const, namespace: "n", platform: "unknown" as const, throughput: 1, errorRate: 0, p95LatencyMs: 1 },
			{ id: "b", label: "b", kind: "service" as const, namespace: "n", platform: "unknown" as const, throughput: 1, errorRate: 0, p95LatencyMs: 1 },
		]
		const loop = [
			{ source: "a", target: "b", callsPerSecond: 1, errorRate: 0, avgLatencyMs: 1, p95LatencyMs: 1 },
			{ source: "b", target: "a", callsPerSecond: 1, errorRate: 0, avgLatencyMs: 1, p95LatencyMs: 1 },
		]
		const tiers = computeTiers(cyclic, loop)
		expect(tiers.get("a")).toBeLessThanOrEqual(cyclic.length)
		expect(tiers.get("b")).toBeLessThanOrEqual(cyclic.length)
	})

	it("ignores edges pointing at nodes that are not in the graph", () => {
		const tiers = computeTiers(nodes, [
			...edges,
			{ source: "browser", target: "ghost", callsPerSecond: 1, errorRate: 0, avgLatencyMs: 1, p95LatencyMs: 1 },
		])
		expect(tiers.has("ghost")).toBe(false)
	})
})

describe("layoutGraph", () => {
	it("places every node exactly once in both modes", () => {
		for (const mode of ["floors", "rings"] as const) {
			const layout = layoutGraph(SERVICE_MAP_3D_TOPOLOGY, mode)
			expect(layout.positions.size).toBe(nodes.length)
			for (const [, position] of layout.positions) {
				expect(position.every(Number.isFinite)).toBe(true)
			}
		}
	})

	it("stacks storeys downward, one per tier", () => {
		const layout = layoutGraph(SERVICE_MAP_3D_TOPOLOGY, "floors")
		const y = (id: string) => layout.positions.get(id)![1]
		expect(y("browser")).toBeGreaterThan(y("api-gateway"))
		expect(y("api-gateway")).toBeGreaterThan(y("checkout-api"))
		expect(layout.tierCount).toBe(Math.max(...[...layout.tiers.values()]) + 1)
	})

	it("keeps a namespace's cluster on its own bearing, storey after storey", () => {
		const layout = layoutGraph(SERVICE_MAP_3D_TOPOLOGY, "floors")
		// Nodes fan out along the cluster's tangent, so it is the per-storey
		// centroid \u2014 not an individual node \u2014 that sits on the namespace bearing.
		const centroidBearing = (namespace: string, tier: number) => {
			const members = nodes.filter(
				(node) => node.namespace === namespace && layout.tiers.get(node.id) === tier,
			)
			expect(members.length).toBeGreaterThan(0)
			const [x, z] = members.reduce(
				(acc, node) => {
					const position = layout.positions.get(node.id)!
					return [acc[0] + position[0] / members.length, acc[1] + position[2] / members.length] as [
						number,
						number,
					]
				},
				[0, 0] as [number, number],
			)
			return Math.atan2(z, x)
		}
		const expected = layout.namespaceAngles.get("checkout")!
		const checkoutTiers = [
			...new Set(
				nodes.filter((node) => node.namespace === "checkout").map((node) => layout.tiers.get(node.id)!),
			),
		]
		expect(checkoutTiers.length).toBeGreaterThan(1)
		for (const tier of checkoutTiers) {
			expect(centroidBearing("checkout", tier)).toBeCloseTo(expected, 5)
		}
	})

	it("never collides two nodes on the same spot", () => {
		for (const mode of ["floors", "rings"] as const) {
			const layout = layoutGraph(SERVICE_MAP_3D_TOPOLOGY, mode)
			const keys = [...layout.positions.values()].map((p) => p.map((v) => v.toFixed(3)).join(","))
			expect(new Set(keys).size).toBe(keys.length)
		}
	})
})

describe("curves and scales", () => {
	it("bows the control point away from the world axis", () => {
		const from = [10, 0, 0] as const
		const to = [10, -7, 0] as const
		const control = bezierControl(from, to)
		expect(control[0]).toBeGreaterThan(10)
		expect(control[1]).toBeGreaterThan(-3.5)
	})

	it("spreads sibling pipes further out", () => {
		const from = [10, 0, 0] as const
		const to = [10, -7, 0] as const
		expect(bezierControl(from, to, 2)[0]).toBeGreaterThan(bezierControl(from, to, 0)[0])
	})

	it("samples the curve from endpoint to endpoint", () => {
		const from = [0, 0, 0] as const
		const to = [4, -4, 0] as const
		const control = bezierControl(from, to)
		expect(sampleQuadratic(from, control, to, 0)).toEqual([...from])
		expect(sampleQuadratic(from, control, to, 1)).toEqual([...to])
	})

	it("scales pipes and nodes sub-linearly with traffic", () => {
		expect(pipeRadius(100, 100)).toBeGreaterThan(pipeRadius(1, 100))
		expect(pipeRadius(100, 100) / pipeRadius(1, 100)).toBeLessThan(10)
		expect(nodeScale(5000, 100)).toBe(nodeScale(100, 100))
	})
})

describe("oklchToHex", () => {
	it("converts the achromatic ends", () => {
		expect(oklchToHex(1, 0, 0)).toBe("#ffffff")
		expect(oklchToHex(0, 0, 0)).toBe("#000000")
	})

	it("lands on red-500 for the error token", () => {
		expect(oklchToHex(0.637, 0.237, 25.331)).toBe("#fb2c36")
	})
})

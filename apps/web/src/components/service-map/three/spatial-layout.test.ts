import { describe, expect, it } from "vitest"
import { SERVICE_MAP_3D_TOPOLOGY as topology } from "@/lab/service-map-3d/fixture"
import { connectedIds, formatRate, spatialLayout } from "./spatial-layout"

describe("spatial service map", () => {
	it("distinguishes low-volume sampled traffic from idle connections", () => {
		expect(formatRate(0)).toBe("0/s")
		expect(formatRate(0.0004)).toBe("<0.1/s")
		expect(formatRate(0.025, true)).toBe("~<0.1/s")
		expect(formatRate(1240, true)).toBe("~1.2K/s")
	})
	it.each(["atlas", "cascade"] as const)("places every node without collisions in %s", (view) => {
		const layout = spatialLayout(topology, view)
		expect([...layout.positions.keys()].sort()).toEqual(topology.nodes.map((node) => node.id).sort())
		const positions = [...layout.positions.values()]
		expect(new Set(positions.map((position) => position.join(","))).size).toBe(topology.nodes.length)
		for (const position of positions) expect(position.every(Number.isFinite)).toBe(true)
	})
	it("keeps Atlas districts separate and their nodes inside the correct district", () => {
		const layout = spatialLayout(topology, "atlas")
		for (const district of layout.districts) {
			for (const other of layout.districts) {
				if (district === other) continue
				expect(
					Math.abs(district.position[0] - other.position[0]) >=
						(district.width + other.width) / 2 ||
						Math.abs(district.position[2] - other.position[2]) >=
							(district.depth + other.depth) / 2,
				).toBe(true)
			}
			for (const node of topology.nodes.filter((node) => node.namespace === district.id)) {
				const position = layout.positions.get(node.id)!
				expect(Math.abs(position[0] - district.position[0]) + 1.25).toBeLessThan(district.width / 2)
				expect(Math.abs(position[2] - district.position[2]) + 1.075).toBeLessThan(district.depth / 2)
			}
		}
	})
	it("routes every fixture call forward and downward in Cascade", () => {
		const { positions } = spatialLayout(topology, "cascade")
		for (const edge of topology.edges) {
			const from = positions.get(edge.source)!,
				to = positions.get(edge.target)!
			expect(to[0]).toBeGreaterThan(from[0])
			expect(to[1]).toBeLessThan(from[1])
		}
	})
	it("focus includes incoming and outgoing peers, without unrelated services", () => {
		expect(connectedIds(topology, "payments-api")).toEqual(
			new Set(["payments-api", "checkout-api", "ext:stripe"]),
		)
		expect(connectedIds(topology, null)).toBeNull()
	})
})

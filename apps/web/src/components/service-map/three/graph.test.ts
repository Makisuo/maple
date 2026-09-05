import { expect, it } from "vitest"
import { computeTiers } from "./graph"
import { spatialLayout } from "./spatial-layout"

it("keeps cycles on one terrace and ranks their downstream services correctly", () => {
	const nodes = ["entry", "a", "b", "sink", "isolated"].map((id) => ({ id }))
	const edges = [
		{ source: "entry", target: "a" },
		{ source: "a", target: "b" },
		{ source: "b", target: "a" },
		{ source: "b", target: "sink" },
		{ source: "sink", target: "sink" },
	]
	expect(computeTiers(nodes, edges)).toEqual(
		new Map([
			["entry", 0],
			["a", 1],
			["b", 1],
			["sink", 2],
			["isolated", 0],
		]),
	)
})
it("packs arbitrary live namespaces without intersecting districts, independent of row order", () => {
	const nodes = Array.from({ length: 73 }, (_, i) => ({
		id: `svc-${i}`,
		namespace: i < 36 ? "large-team" : `team-${i % 7}`,
	}))
	const topology = { nodes, edges: [] }
	const layout = spatialLayout(topology, "atlas")
	expect(layout.positions.size).toBe(73)
	expect(layout).toEqual(spatialLayout({ nodes: [...nodes].reverse(), edges: [] }, "atlas"))
	for (const a of layout.districts)
		for (const b of layout.districts) {
			if (a === b) continue
			expect(
				Math.abs(a.position[0] - b.position[0]) >= (a.width + b.width) / 2 ||
					Math.abs(a.position[2] - b.position[2]) >= (a.depth + b.depth) / 2,
			).toBe(true)
		}
	expect(spatialLayout({ nodes: [], edges: [] }, "atlas")).toEqual({ positions: new Map(), districts: [] })
})

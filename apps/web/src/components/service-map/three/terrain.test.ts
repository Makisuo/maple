import { describe, expect, it } from "vitest"
import * as THREE from "three"
import { SERVICE_MAP_3D_TOPOLOGY } from "@/lab/service-map-3d/fixture"
import { spatialLayout } from "./spatial-layout"
import { insideIsland, islandFootprint, islandGeometry } from "./terrain"

describe.each(["atlas", "cascade"] as const)("%s cutaway terrain", (view) => {
	const layout = spatialLayout(SERVICE_MAP_3D_TOPOLOGY, view)
	const island = islandFootprint(layout)

	it("uses equal sides with all four crisp corners", () => {
		expect(island.maxX - island.minX).toBe(island.maxZ - island.minZ)
		for (const x of [island.minX, island.maxX]) {
			for (const z of [island.minZ, island.maxZ]) {
				expect(island.outline.some((p) => p.x === x && p.y === z)).toBe(true)
			}
		}
	})

	it("contains every factory apron while excluding the surrounding air", () => {
		for (const [x, , z] of layout.positions.values()) {
			expect(insideIsland(island, x, z, 1.8)).toBe(true)
		}
		expect(insideIsland(island, island.maxX + 1, island.center.y)).toBe(false)
		expect(insideIsland(island, island.center.x, island.maxZ + 1)).toBe(false)
		expect(insideIsland(island, island.minX, island.minZ, 0.1)).toBe(false)
	})

	it("forms a closed, outward-facing solid without cracks between soil layers", () => {
		const terrain = islandGeometry(island, true)
		const edges = new Map<string, number>()
		let volume = 0
		for (const geometry of [terrain.top, terrain.earth]) {
			const positions = geometry.getAttribute("position")
			const index = geometry.getIndex()
			const count = index?.count ?? positions.count
			expect([...positions.array].every(Number.isFinite)).toBe(true)
			for (let i = 0; i < count; i += 3) {
				const points = [0, 1, 2].map((offset) =>
					new THREE.Vector3().fromBufferAttribute(
						positions,
						index ? index.getX(i + offset) : i + offset,
					),
				)
				const [a, b, c] = points
				if (!a || !b || !c) continue
				volume += a.dot(b.clone().cross(c)) / 6
				const keys = points.map((p) =>
					p
						.toArray()
						.map((v) => v.toFixed(4))
						.join(","),
				)
				for (let side = 0; side < 3; side++) {
					const edge = [keys[side], keys[(side + 1) % 3]].sort().join("|")
					edges.set(edge, (edges.get(edge) ?? 0) + 1)
				}
			}
			geometry.dispose()
		}
		expect([...edges.values()].every((count) => count === 2)).toBe(true)
		expect(volume).toBeGreaterThan(0)
	})
})

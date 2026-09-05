import { describe, expect, it } from "vitest"
import { SERVICE_MAP_3D_TOPOLOGY } from "@/lab/service-map-3d/fixture"
import { spatialLayout } from "./spatial-layout"
import { insideIsland, islandColumn, islandFootprint } from "./terrain"

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
	it("cuts stepped shoreline corners while preserving the service platforms", () => {
		const cell = 0.4
		expect(islandColumn(island, island.minX + cell / 2, island.minZ + cell / 2, cell).present).toBe(false)
		for (const district of layout.districts) {
			for (const sx of [-1, 1])
				for (const sz of [-1, 1]) {
					expect(
						islandColumn(
							island,
							district.position[0] + (sx * district.width) / 2,
							district.position[2] + (sz * district.depth) / 2,
							cell,
						).present,
					).toBe(true)
				}
		}
	})

	it("tapers the floating underside toward its rim", () => {
		const center = islandColumn(island, island.center.x, island.center.y, 0.4)
		const rim = islandColumn(island, island.maxX - 1.2, island.center.y, 0.4)
		expect(center.depth).toBeGreaterThan(rim.depth * 1.5)
		expect(center.depth / 0.4).toBeCloseTo(Math.round(center.depth / 0.4), 6)
	})
})

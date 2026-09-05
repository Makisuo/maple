import { describe, expect, it } from "vitest"
import { SERVICE_MAP_3D_TOPOLOGY } from "@/lab/service-map-3d/fixture"
import { GROUND_Y } from "./appearance"
import { factoryRoutes } from "./factory-routing"
import { spatialLayout } from "./spatial-layout"
import { islandColumn, islandFootprint } from "./terrain"
import { buildVoxelLandscape } from "./voxel-landscape"

describe.each(["atlas", "cascade"] as const)("%s voxel landscape", (view) => {
	const layout = spatialLayout(SERVICE_MAP_3D_TOPOLOGY, view)
	const routes = factoryRoutes(SERVICE_MAP_3D_TOPOLOGY, layout)
	const island = islandFootprint(layout)
	const result = buildVoxelLandscape(layout, routes, true)
	const grass = result.terrain.filter((part) => part.color.g > part.color.r)
	const cell = grass[0]?.matrix.elements[0] ?? 0

	it("uses small elevation steps and finite, positive block dimensions", () => {
		expect(cell).toBeGreaterThan(0)
		expect(cell).toBeLessThanOrEqual(0.41)
		const levels = new Set<number>()
		for (const part of [...result.terrain, ...result.plants]) {
			expect(part.matrix.elements.every(Number.isFinite)).toBe(true)
			for (const axis of [0, 5, 10]) expect(part.matrix.elements[axis]).toBeGreaterThan(0)
		}
		for (const part of grass) {
			const level =
				((part.matrix.elements[13] ?? 0) + (part.matrix.elements[5] ?? 0) / 2 - GROUND_Y) / cell
			expect(level).toBeCloseTo(Math.round(level), 6)
			levels.add(Math.round(level))
		}
		expect(levels.has(1)).toBe(true)
		expect(levels.size).toBeGreaterThan(2)
	})

	it("closes the exposed dirt columns up to their grass caps", () => {
		const edge = [...grass].sort((a, b) => (a.matrix.elements[12] ?? 0) - (b.matrix.elements[12] ?? 0))[0]
		const x = edge?.matrix.elements[12] ?? 0
		const z = edge?.matrix.elements[14] ?? 0
		const intervals = result.terrain
			.filter(
				(part) =>
					Math.abs((part.matrix.elements[12] ?? 0) - x) < 1e-6 &&
					Math.abs((part.matrix.elements[14] ?? 0) - z) < 1e-6,
			)
			.map((part) => [
				(part.matrix.elements[13] ?? 0) - (part.matrix.elements[5] ?? 0) / 2,
				(part.matrix.elements[13] ?? 0) + (part.matrix.elements[5] ?? 0) / 2,
			])
			.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))
		expect(intervals[0]?.[0]).toBeCloseTo(GROUND_Y - islandColumn(island, x, z, cell).depth, 6)
		for (let index = 1; index < intervals.length; index++)
			expect(intervals[index]?.[0]).toBeCloseTo(intervals[index - 1]?.[1] ?? 0, 6)
	})

	it("retains a lush meadow with bounded instance counts", () => {
		const blades = result.plants.filter(
			(part) =>
				Math.abs((part.matrix.elements[0] ?? 0) - 0.075) < 1e-6 &&
				(part.matrix.elements[5] ?? 0) > 0.1,
		)
		expect(blades.length).toBeGreaterThan(1000)
		expect(result.plants.length).toBeLessThan(40000)
		expect(result.terrain.length).toBeLessThan(80000)
	})
})

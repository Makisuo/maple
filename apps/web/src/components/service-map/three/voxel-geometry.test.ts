import { describe, expect, it } from "vitest"
import { VoxelGeometry } from "./voxel-geometry"

describe("VoxelGeometry", () => {
	it("omits interior faces while retaining the exact box footprint", () => {
		const geometry = new VoxelGeometry("box", 2, 2, 2, 1)
		// Eight cubes have 48 faces; only the 24 exterior faces should remain.
		expect(geometry.getAttribute("position").count).toBe(24 * 6)
		geometry.computeBoundingBox()
		expect(geometry.boundingBox?.min.toArray()).toEqual([-1, -1, -1])
		expect(geometry.boundingBox?.max.toArray()).toEqual([1, 1, 1])
		geometry.dispose()
	})

	it.each(["box", "cylinder", "sphere", "dome", "torus"] as const)(
		"builds finite flat faces for %s",
		(primitive) => {
			const geometry = new VoxelGeometry(primitive, 1.8, 1.8, 0.16, 0.18)
			const positions = geometry.getAttribute("position")
			const normals = geometry.getAttribute("normal")
			expect(positions.count).toBeGreaterThan(0)
			expect(Array.from(positions.array).every(Number.isFinite)).toBe(true)
			for (let i = 0; i < normals.count; i++) {
				expect(
					Math.abs(normals.getX(i)) + Math.abs(normals.getY(i)) + Math.abs(normals.getZ(i)),
				).toBe(1)
			}
			expect(geometry.getAttribute("color").count).toBe(positions.count)
			geometry.dispose()
		},
	)

	it("seats the tank dome above the cylinder without overlapping their side faces", () => {
		const body = new VoxelGeometry("cylinder", 1.72, 2, 1.72)
		const cap = new VoxelGeometry("dome", 1.72, 0.32, 1.72, 0.08)
		body.translate(0, 1.22, 0)
		cap.translate(0, 2.38, 0)
		body.computeBoundingBox()
		cap.computeBoundingBox()
		expect(cap.boundingBox?.min.y).toBeCloseTo(body.boundingBox?.max.y ?? 0, 5)
		expect(cap.boundingBox?.max.y).toBeCloseTo(2.54, 5)
		body.dispose()
		cap.dispose()
	})

	it("keeps sub-cell status lights visible", () => {
		const geometry = new VoxelGeometry("cylinder", 0.1, 0.1, 0.1)
		expect(geometry.getAttribute("position").count).toBe(36)
		geometry.dispose()
	})
})

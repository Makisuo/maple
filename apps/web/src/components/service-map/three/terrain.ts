import * as THREE from "three"
import type { SpatialLayout } from "./spatial-layout"

export const EARTH_DEPTH = 3.4

/** A square terrain tile contains the factories and grove, with crisp pixel-like corners. */
export function islandFootprint(layout: SpatialLayout) {
	const left = Math.min(...layout.districts.map((d) => d.position[0] - d.width / 2)) - 3.8
	const right = Math.max(...layout.districts.map((d) => d.position[0] + d.width / 2)) + 3.8
	const back = Math.min(...layout.districts.map((d) => d.position[2] - d.depth / 2)) - 3.3
	const front = Math.max(...layout.districts.map((d) => d.position[2] + d.depth / 2)) + 3.3
	const center = new THREE.Vector2((left + right) / 2, (back + front) / 2)
	const size = Math.ceil(Math.max(right - left, front - back) / 2) * 2
	const minX = center.x - size / 2,
		maxX = center.x + size / 2
	const minZ = center.y - size / 2,
		maxZ = center.y + size / 2
	const corners = [
		new THREE.Vector2(minX, minZ),
		new THREE.Vector2(maxX, minZ),
		new THREE.Vector2(maxX, maxZ),
		new THREE.Vector2(minX, maxZ),
	]
	const outline = corners.flatMap((corner, side) => {
		const next = corners[(side + 1) % 4]
		return next ? Array.from({ length: 24 }, (_, i) => corner.clone().lerp(next, i / 24)) : []
	})
	return { outline, center, minX, maxX, minZ, maxZ }
}

export type IslandFootprint = ReturnType<typeof islandFootprint>

/** Keep roots, flowers, and grass inside the actual shoreline, not its bounds. */
export function insideIsland(island: IslandFootprint, x: number, z: number, inset = 0) {
	let inside = false
	let clearance = Infinity
	for (let i = 0; i < island.outline.length; i++) {
		const a = island.outline[i],
			b = island.outline[(i + 1) % island.outline.length]
		if (!a || !b) continue
		if (a.y > z !== b.y > z && x < ((b.x - a.x) * (z - a.y)) / (b.y - a.y) + a.x) inside = !inside
		const dx = b.x - a.x,
			dz = b.y - a.y
		const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.y) * dz) / (dx * dx + dz * dz), 0, 1)
		clearance = Math.min(clearance, Math.hypot(x - a.x - t * dx, z - a.y - t * dz))
	}
	return inside && clearance >= inset
}

/** A conservative footprint frames the scene; the visible shoreline is stepped. */
export function islandDepth(island: IslandFootprint) {
	return Math.min(10, Math.max(EARTH_DEPTH, (island.maxX - island.minX) * 0.16))
}

export function islandColumn(island: IslandFootprint, x: number, z: number, cell: number) {
	const half = (island.maxX - island.minX) / 2
	const dx = Math.abs(x - island.center.x)
	const dz = Math.abs(z - island.center.y)
	const edgeX = half - dx
	const edgeZ = half - dz
	const rim = Math.floor(1.2 + 0.65 * Math.sin(x * 0.7 + z * 0.31) + 0.5 * Math.cos(z * 0.8)) * cell
	const present = edgeX >= rim && edgeZ >= rim && edgeX + edgeZ >= Math.min(2.4, half * 0.18) + rim
	const radial = Math.max(dx, dz) / half
	const contour = 0.4 * Math.sin(x * 0.72 + z * 0.27) + 0.25 * Math.cos(z * 0.64 - x * 0.35)
	const depth = Math.max(
		cell * 2,
		Math.round(
			(islandDepth(island) * (0.35 + 0.65 * Math.pow(Math.max(0, 1 - radial), 0.6)) + contour) / cell,
		) * cell,
	)
	return { present, depth }
}

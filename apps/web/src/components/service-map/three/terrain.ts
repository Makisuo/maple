import * as THREE from "three"
import { GROUND_Y, MAP_MATERIALS } from "./appearance"
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

function topGeometry(island: IslandFootprint, dark: boolean) {
	const geometry = new THREE.PlaneGeometry(island.maxX - island.minX, island.maxZ - island.minZ, 24, 24)
	geometry.rotateX(-Math.PI / 2)
	geometry.translate(island.center.x, GROUND_Y, island.center.y)
	const positions = geometry.getAttribute("position")
	const colors: number[] = []
	const materials = MAP_MATERIALS[dark ? "dark" : "light"]
	const base = new THREE.Color(materials.ground),
		high = new THREE.Color(materials.turf)
	for (let i = 0; i < positions.count; i++) {
		const x = positions.getX(i),
			z = positions.getZ(i)
		const color = base.clone().lerp(high, 0.3 + 0.12 * Math.sin(x * 0.3 + z * 0.2))
		colors.push(color.r, color.g, color.b)
	}
	geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
	return geometry
}

/** Flat soil strata share exact square edges, with no gaps or rounded taper. */
function earthGeometry(island: IslandFootprint, dark: boolean) {
	const levels = [0, -0.2, -0.62, -2.28, -EARTH_DEPTH]
	const palette = dark
		? ["#39752a", "#54301f", "#8e5129", "#665039"]
		: ["#488730", "#663920", "#a26230", "#796042"]
	const vertices: number[] = [],
		colors: number[] = []
	const point = (index: number, level: number) => {
		const wrapped = index % island.outline.length
		const p = island.outline[wrapped] ?? island.center
		const depth = levels[level] ?? 0
		return new THREE.Vector3(p.x, GROUND_Y + depth, p.y)
	}
	for (let layer = 0; layer < levels.length - 1; layer++) {
		for (let i = 0; i < island.outline.length; i++) {
			const a = point(i, layer),
				b = point(i + 1, layer)
			const c = point(i, layer + 1),
				d = point(i + 1, layer + 1)
			const pigment = new THREE.Color(palette[layer])
			for (const p of [a, b, c, b, d, c]) {
				vertices.push(p.x, p.y, p.z)
				colors.push(pigment.r, pigment.g, pigment.b)
			}
		}
	}
	// Close the underside so this stays a solid volume when the camera is lowered.
	for (let i = 0; i < island.outline.length; i++) {
		const bottom = new THREE.Vector3(island.center.x, GROUND_Y - EARTH_DEPTH, island.center.y)
		const color = new THREE.Color(palette[3])
		for (const p of [bottom, point(i, 4), point(i + 1, 4)]) {
			vertices.push(p.x, p.y, p.z)
			colors.push(color.r, color.g, color.b)
		}
	}
	const geometry = new THREE.BufferGeometry()
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3))
	geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
	geometry.computeVertexNormals()
	return geometry
}

export function islandGeometry(island: IslandFootprint, dark: boolean) {
	return { top: topGeometry(island, dark), earth: earthGeometry(island, dark) }
}

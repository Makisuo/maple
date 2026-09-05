import * as THREE from "three"
import { GROUND_Y, MAP_MATERIALS } from "./appearance"
import type { FactoryRoute } from "./factory-routing"
import type { Vec3 } from "./types"
import type { SpatialLayout } from "./spatial-layout"
import { islandColumn, islandDepth, islandFootprint } from "./terrain"

export interface VoxelPart {
	matrix: THREE.Matrix4
	color: THREE.Color
}

function block(position: Vec3, size: Vec3, color: string): VoxelPart {
	return {
		matrix: new THREE.Matrix4().compose(
			new THREE.Vector3(...position),
			new THREE.Quaternion(),
			new THREE.Vector3(...size),
		),
		color: new THREE.Color(color),
	}
}

/** The landscape uses a coarser voxel grid than machinery. Seeded colors and
 * placement keep it stable while the operator selects services or changes theme.
 * Repeated cubes are instanced; there are only two landscape draw calls. */
export function buildVoxelLandscape(layout: SpatialLayout, routes: FactoryRoute[], dark: boolean) {
	const terrain: VoxelPart[] = [],
		plants: VoxelPart[] = []
	const island = islandFootprint(layout)
	const material = MAP_MATERIALS[dark ? "dark" : "light"]
	const width = island.maxX - island.minX
	const count = Math.min(160, Math.ceil(width / 0.4))
	const cell = width / count
	let seed = 427
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
		return seed / 4294967296
	}
	const routePoints = routes.flatMap((link) => link.curve.getSpacedPoints(48))
	const nodes = [...layout.positions.values()]
	const districtAt = (x: number, z: number, margin = 0) =>
		layout.districts.find(
			(district) =>
				Math.abs(x - district.position[0]) < district.width / 2 + margin &&
				Math.abs(z - district.position[2]) < district.depth / 2 + margin,
		)
	const clear = (x: number, z: number, margin: number) =>
		!nodes.some((p) => Math.abs(x - p[0]) < 1.5 + margin && Math.abs(z - p[2]) < 1.3 + margin) &&
		!routePoints.some((p) => Math.hypot(p.x - x, p.z - z) < margin + 0.55)
	// Minecraft-style columns: elevation changes in whole cubes, forming
	// connected terraces. Both horizontal detail and vertical steps use the
	// finer grid; there is no separate coarse elevation grid.
	const heightCache = new Float64Array(count * count).fill(Number.NaN)
	const groundHeight = (x: number, z: number) => {
		const ix = Math.floor((x - island.minX) / cell)
		const iz = Math.floor((z - island.minZ) / cell)
		const index = ix * count + iz
		const cached = heightCache[index]
		if (cached !== undefined && Number.isFinite(cached)) return cached
		const px = island.minX + (ix + 0.5) * cell
		const pz = island.minZ + (iz + 0.5) * cell
		let clearance = 1
		for (const district of layout.districts) {
			const dx = Math.max(0, Math.abs(px - district.position[0]) - district.width / 2 - cell / 2)
			const dz = Math.max(0, Math.abs(pz - district.position[2]) - district.depth / 2 - cell / 2)
			clearance = Math.min(clearance, Math.hypot(dx, dz) / 2.5)
		}
		for (const point of routePoints)
			clearance = Math.min(
				clearance,
				Math.max(0, Math.hypot(point.x - px, point.z - pz) - 0.8 - cell / 2) / 2,
			)
		const roll =
			0.5 + 0.27 * Math.sin(px * 0.23 + Math.sin(pz * 0.17)) + 0.23 * Math.cos(pz * 0.21 - px * 0.11)
		const height = Math.round((roll * 1.6 * clearance) / cell) * cell
		heightCache[index] = height
		return height
	}
	const soil = dark
		? ["#d0aa70", "#b38a70", "#977677", "#80667a", "#675469"]
		: ["#deb980", "#c79c7f", "#ab8588", "#93788b", "#786579"]
	const columns = Array.from({ length: count * count }, (_, index) => {
		const x = island.minX + (Math.floor(index / count) + 0.5) * cell
		const z = island.minZ + ((index % count) + 0.5) * cell
		const column = islandColumn(island, x, z, cell)
		return { ...column, top: GROUND_Y + groundHeight(x, z), bottom: GROUND_Y - column.depth }
	})
	const columnAt = (x: number, z: number) =>
		x < 0 || z < 0 || x >= count || z >= count ? undefined : columns[x * count + z]
	const supported = (x: number, z: number) =>
		columnAt(Math.floor((x - island.minX) / cell), Math.floor((z - island.minZ) / cell))?.present === true
	for (let x = 0; x < count; x++) {
		for (let z = 0; z < count; z++) {
			const column = columnAt(x, z)
			if (!column?.present) continue
			const px = island.minX + (x + 0.5) * cell
			const pz = island.minZ + (z + 0.5) * cell
			const { top, bottom } = column
			const grassDepth = cell * 0.18
			const tone = 0.96 + ((Math.imul(x + 1, 73) ^ Math.imul(z + 1, 53)) & 3) * 0.015
			const grass = new THREE.Color(material.ground).multiplyScalar(tone)
			terrain.push(
				block([px, top - grassDepth / 2, pz], [cell, grassDepth, cell], `#${grass.getHexString()}`),
			)
			const neighbors = [columnAt(x - 1, z), columnAt(x + 1, z), columnAt(x, z - 1), columnAt(x, z + 1)]
			const edge = neighbors.some((neighbor) => !neighbor?.present)
			const neighborTop = Math.min(...neighbors.map((neighbor) => neighbor?.top ?? bottom))
			const neighborBottom = Math.max(...neighbors.map((neighbor) => neighbor?.bottom ?? top))
			// Keep exposed side and underside cubes, including shelves revealed by
			// the taper. There is no flat slab beneath this floating rock formation.
			for (let layer = 0; top - layer * cell > bottom + 1e-6; layer++) {
				const cubeTop = top - layer * cell - (layer === 0 ? grassDepth : 0)
				const cubeBottom = Math.max(bottom, top - (layer + 1) * cell)
				const underside = cubeBottom <= bottom + 1e-6
				if (!edge && !underside && cubeTop <= neighborTop && cubeBottom >= neighborBottom) continue
				const hash = (Math.imul(x + 1, 73) ^ Math.imul(z + 1, 53) ^ Math.imul(layer + 1, 97)) >>> 0
				const depth = Math.max(0, GROUND_Y - (cubeTop + cubeBottom) / 2)
				const band = Math.min(
					soil.length - 1,
					Math.floor((depth / islandDepth(island)) * 5 + (hash % 3) * 0.15),
				)
				const color = new THREE.Color(soil[band] ?? material.platform).multiplyScalar(
					0.94 + (hash % 5) * 0.025,
				)
				terrain.push(
					block(
						[px, (cubeTop + cubeBottom) / 2, pz],
						[cell, cubeTop - cubeBottom, cell],
						`#${color.getHexString()}`,
					),
				)
			}
		}
	}
	const trees: Vec3[] = []
	for (let attempt = 0; attempt < 700 && trees.length < 14; attempt++) {
		const x = island.minX + (2 + Math.floor(random() * (count - 4)) + 0.5) * cell
		const z = island.minZ + (2 + Math.floor(random() * (count - 4)) + 0.5) * cell
		if (
			!supported(x, z) ||
			districtAt(x, z, 1.5) ||
			!clear(x, z, 1.5) ||
			trees.some((p) => Math.hypot(p[0] - x, p[2] - z) < 3.4)
		)
			continue
		const floor = GROUND_Y + groundHeight(x, z)
		trees.push([x, floor, z])
		const leaf = ["#e6bc57", "#bd6348", "#d9944e", "#d9a95b"][trees.length % 4] ?? "#e7c66d"
		// Smaller trunk and leaf voxels retain the tree's overall dimensions.
		// The trunk ends exactly at the canopy underside to avoid depth overlap.
		const leafCell = 0.2
		for (let y = 0; y < 7; y++) {
			for (const dx of [-0.1, 0.1])
				for (const dz of [-0.1, 0.1]) {
					plants.push(
						block(
							[x + dx, floor + (y + 0.5) * leafCell, z + dz],
							[leafCell, leafCell, leafCell],
							y % 3 === 0 ? "#76553b" : "#7c5b3f",
						),
					)
				}
		}
		for (let ix = 0; ix < 10; ix++) {
			for (let iy = 0; iy < 8; iy++) {
				for (let iz = 0; iz < 10; iz++) {
					const dx = (ix + 0.5) * leafCell - 1
					const dy = 1.5 + iy * leafCell
					const dz = (iz + 0.5) * leafCell - 1
					if (dx * dx + dz * dz + (dy - 2) * (dy - 2) > 0.96) continue
					// Deeper autumn color under the crown, honey-colored tips above.
					const color = new THREE.Color(leaf)
						.lerp(new THREE.Color("#f2d486"), Math.max(0, dy - 2) * 0.28)
						.multiplyScalar(0.86 + iy * 0.018 + random() * 0.06)
					plants.push(
						block(
							[x + dx, floor + dy, z + dz],
							[leafCell, leafCell, leafCell],
							`#${color.getHexString()}`,
						),
					)
				}
			}
		}
	}
	const surfaceAt = (x: number, z: number) => {
		const district = districtAt(x, z)
		return district ? district.position[1] + 0.16 : GROUND_Y + groundHeight(x, z)
	}
	// A thin scattering of fallen leaves ties each canopy to the meadow.
	// Small solid pixels sit above the surface instead of fighting it for depth.
	for (const [index, tree] of trees.entries()) {
		for (let leaf = 0; leaf < 28; leaf++) {
			const angle = random() * Math.PI * 2
			const radius = 0.4 + random() * 1.5
			const x = tree[0] + Math.cos(angle) * radius
			const z = tree[2] + Math.sin(angle) * radius
			if (!supported(x, z) || !clear(x, z, 0.4)) continue
			const color = ["#d6a34e", "#b66545", "#dfb55d", "#c17d43"][(index + leaf) % 4] ?? "#d6a34e"
			for (const [dx, dz] of [
				[0, 0],
				[-0.045, 0],
				[0.045, 0],
				[0, -0.045],
				[0, 0.045],
			] as const) {
				if (!supported(x + dx, z + dz)) continue
				plants.push(
					block([x + dx, surfaceAt(x + dx, z + dz) + 0.015, z + dz], [0.045, 0.03, 0.045], color),
				)
			}
		}
	}
	// Soft clusters of fine, stepped blades restore the meadow around the
	// machinery. Each blade sits on its own terrain tile, including at ledges.
	for (let attempt = 0; attempt < 3200; attempt++) {
		const x = island.minX + 0.5 + random() * (width - 1)
		const z = island.minZ + 0.5 + random() * (width - 1)
		if (!supported(x, z) || !clear(x, z, 0.45)) continue
		const patch = Math.sin(x * 0.55 + Math.cos(z * 0.38)) * Math.cos(z * 0.47)
		if (patch < -0.45) continue
		const scale = districtAt(x, z) ? 0.75 : 1
		const pigment = new THREE.Color(
			patch > 0.45 ? "#739c50" : patch < -0.05 ? "#496f42" : material.grass,
		).multiplyScalar(0.94 + random() * 0.1)
		const color = `#${pigment.getHexString()}`
		const tip = `#${pigment.clone().lerp(new THREE.Color("#9bbd6a"), 0.24).getHexString()}`
		const direction = (Math.floor(random() * 4) * Math.PI) / 2
		for (const [dx, dz, height] of [
			[-0.11, -0.02, 0.32],
			[0, 0.07, 0.48],
			[0.11, 0, 0.24],
			[0.02, -0.1, 0.36],
		] as const) {
			const leanX = dx * Math.cos(direction) - dz * Math.sin(direction)
			const leanZ = dx * Math.sin(direction) + dz * Math.cos(direction)
			const px = x + leanX,
				pz = z + leanZ
			if (!supported(px, pz)) continue
			const y = surfaceAt(px, pz)
			const tall = height * scale * (0.85 + random() * 0.3)
			const stem = tall * 0.7
			plants.push(block([px, y + stem / 2, pz], [0.075, stem, 0.075], color))
			plants.push(
				block(
					[px + leanX * 0.22, y + stem + (tall - stem) / 2, pz + leanZ * 0.22],
					[0.055, tall - stem, 0.055],
					tip,
				),
			)
		}
		if (attempt % 18 === 0 && patch > 0.1) {
			const y = surfaceAt(x, z)
			plants.push(block([x, y + 0.23, z], [0.035, 0.46, 0.035], "#a58b50"))
			plants.push(block([x, y + 0.5, z], [0.075, 0.12, 0.055], "#d1b577"))
		}
		if (attempt % 40 === 0) {
			const y = surfaceAt(x, z)
			const flower = attempt % 80 === 0 ? "#d9a353" : "#e8d4ac"
			plants.push(block([x, y + 0.24, z], [0.05, 0.48, 0.05], "#6c8744"))
			for (const [dx, dz] of [
				[-0.08, 0],
				[0.08, 0],
				[0, -0.08],
				[0, 0.08],
			] as const) {
				plants.push(block([x + dx, y + 0.5, z + dz], [0.075, 0.06, 0.075], flower))
			}
			plants.push(block([x, y + 0.53, z], [0.075, 0.06, 0.075], "#c49439"))
		}
	}
	return { terrain, plants }
}

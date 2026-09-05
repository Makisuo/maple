import * as THREE from "three"

export type VoxelPrimitive = "box" | "cylinder" | "sphere" | "dome" | "torus"

/** A solid voxel shell: shared interior faces are omitted, so a tiled surface
 * stays one draw call rather than one mesh per cube. Dimensions retain the
 * machine's original footprint and connection anchors. */
export class VoxelGeometry extends THREE.BufferGeometry {
	constructor(primitive: VoxelPrimitive = "box", width = 1, height = 1, depth = 1, cell = 0.1) {
		super()
		const size = [width, height, depth] as const
		const counts = size.map((length) => Math.max(1, Math.min(64, Math.round(length / cell))))
		const [nx = 1, ny = 1, nz = 1] = counts
		const steps = [size[0] / nx, size[1] / ny, size[2] / nz] as const
		const occupied = (x: number, y: number, z: number) => {
			if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return false
			const px = ((x + 0.5) / nx - 0.5) * 2
			const py = ((y + 0.5) / ny - 0.5) * 2
			const pz = ((z + 0.5) / nz - 0.5) * 2
			if (primitive === "dome") return px * px + Math.pow((y + 0.5) / ny, 2) + pz * pz <= 1.08
			if (primitive === "sphere") return px * px + py * py + pz * pz <= 1.08
			if (primitive === "cylinder") return px * px + pz * pz <= 1.08
			// Torus lies in XY, matching Three's native geometry.
			if (primitive === "torus") return Math.pow(Math.hypot(px, py) - 0.76, 2) / 0.09 + pz * pz <= 1.1
			return true
		}
		const positions: number[] = [],
			normals: number[] = [],
			colors: number[] = []
		const indexedCube = new THREE.BoxGeometry(1, 1, 1)
		const cube = indexedCube.toNonIndexed()
		indexedCube.dispose()
		const vertices = cube.getAttribute("position")
		const normal = cube.getAttribute("normal")
		const neighbors = [
			[1, 0, 0],
			[-1, 0, 0],
			[0, 1, 0],
			[0, -1, 0],
			[0, 0, 1],
			[0, 0, -1],
		] as const
		for (let x = 0; x < nx; x++)
			for (let y = 0; y < ny; y++)
				for (let z = 0; z < nz; z++) {
					if (!occupied(x, y, z)) continue
					const tone =
						0.94 +
						((Math.imul(x + 3, 73) ^ Math.imul(y + 5, 97) ^ Math.imul(z + 7, 53)) & 7) * 0.008
					neighbors.forEach(([dx, dy, dz], face) => {
						if (occupied(x + dx, y + dy, z + dz)) return
						for (let v = face * 6; v < face * 6 + 6; v++) {
							positions.push(
								(x + 0.5 + vertices.getX(v)) * steps[0] - size[0] / 2,
								(y + 0.5 + vertices.getY(v)) * steps[1] - size[1] / 2,
								(z + 0.5 + vertices.getZ(v)) * steps[2] - size[2] / 2,
							)
							normals.push(normal.getX(v), normal.getY(v), normal.getZ(v))
							colors.push(tone, tone, tone)
						}
					})
				}
		cube.dispose()
		this.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
		this.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3))
		this.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
		this.computeBoundingSphere()
	}
}

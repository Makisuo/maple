import { memo, useMemo } from "react"
import * as THREE from "three"
import type { IslandFootprint } from "./terrain"

// Scenery must never intercept service selection or canvas drag gestures.
const noRaycast = () => {}

/** World-space clouds retain depth and parallax around the floating island.
 * The sun stays a graphic disc in the viewport, matching the sunset reference. */
export const Sky = memo(function Sky({ island }: { island: IslandFootprint }) {
	const width = island.maxX - island.minX
	const clouds = useMemo(() => {
		const parts: { matrix: THREE.Matrix4; color: THREE.Color }[] = []
		const cell = width * 0.018
		for (const [cx, cy, cz, length, depth] of [
			[-0.16, -0.15, -0.82, 13, 5],
			[0.52, -0.2, -0.46, 10, 4],
			[-0.61, -0.3, 0.17, 11, 5],
			[0.31, -0.36, 0.63, 12, 4],
		] as const) {
			for (let x = 0; x < length; x++) {
				for (let z = 0; z < depth; z++) {
					const nx = ((x + 0.5) / length) * 2 - 1
					const nz = ((z + 0.5) / depth) * 2 - 1
					if (nx * nx + nz * nz > 1.1) continue
					const layers = Math.abs(nx) < 0.55 && Math.abs(nz) < 0.6 ? 3 : 1
					for (let y = 0; y < layers; y++) {
						const matrix = new THREE.Matrix4().compose(
							new THREE.Vector3(
								island.center.x + cx * width + (x - length / 2) * cell,
								cy * width + y * cell * 0.55,
								island.center.y + cz * width + (z - depth / 2) * cell,
							),
							new THREE.Quaternion(),
							new THREE.Vector3(cell, cell * 0.55, cell),
						)
						parts.push({ matrix, color: new THREE.Color(y === 0 ? "#d8becb" : "#f8e5cc") })
					}
				}
			}
		}
		return parts
	}, [island, width])
	return (
		<group>
			<instancedMesh
				args={[undefined, undefined, clouds.length]}
				raycast={noRaycast}
				ref={(mesh) => {
					if (!mesh) return
					clouds.forEach((part, index) => {
						mesh.setMatrixAt(index, part.matrix)
						mesh.setColorAt(index, part.color)
					})
					mesh.instanceMatrix.needsUpdate = true
					if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
					mesh.computeBoundingSphere()
				}}
			>
				<boxGeometry />
				<meshStandardMaterial roughness={1} emissive="#dbc4cb" emissiveIntensity={0.18} />
			</instancedMesh>
		</group>
	)
})

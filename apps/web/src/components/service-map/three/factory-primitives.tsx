import { extend, type ThreeElement } from "@react-three/fiber"
import { VoxelGeometry } from "./voxel-geometry"
import * as THREE from "three"
import type { Vec3 } from "./types"

extend({ VoxelGeometry })
declare module "@react-three/fiber" {
	interface ThreeElements {
		voxelGeometry: ThreeElement<typeof VoxelGeometry>
	}
}

export function MachineBox({
	size,
	position = [0, 0, 0],
	color,
}: {
	size: [number, number, number]
	position?: Vec3
	color: string
}) {
	return (
		<mesh position={[...position]} castShadow receiveShadow>
			<voxelGeometry args={["box", ...size]} />
			<meshLambertMaterial color={color} vertexColors />
		</mesh>
	)
}

/** Repeated screws, louvers, and belt rollers cost one draw per assembly. */
export function BoxInstances({
	size,
	positions,
	color,
}: {
	size: [number, number, number]
	positions: Vec3[]
	color: string
}) {
	return (
		<instancedMesh
			castShadow
			receiveShadow
			args={[undefined, undefined, positions.length]}
			ref={(mesh) => {
				if (!mesh) return
				const matrix = new THREE.Matrix4()
				positions.forEach((position, index) =>
					mesh.setMatrixAt(index, matrix.makeTranslation(...position)),
				)
				mesh.instanceMatrix.needsUpdate = true
				mesh.computeBoundingSphere()
			}}
		>
			<voxelGeometry args={["box", ...size]} />
			<meshStandardMaterial color={color} roughness={0.8} vertexColors />
		</instancedMesh>
	)
}

export function Axle({
	position,
	radius,
	length,
	color,
	axis = "y",
}: {
	position: Vec3
	radius: number
	length: number
	color: string
	axis?: "x" | "y" | "z"
}) {
	return (
		<mesh
			position={[...position]}
			rotation={axis === "x" ? [0, 0, Math.PI / 2] : axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0]}
			castShadow
			receiveShadow
		>
			<voxelGeometry args={["cylinder", radius * 2, length, radius * 2, Math.max(0.03, radius / 6)]} />
			<meshLambertMaterial color={color} vertexColors />
		</mesh>
	)
}

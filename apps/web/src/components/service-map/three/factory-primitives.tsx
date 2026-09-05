import { extend, type ThreeElement } from "@react-three/fiber"
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js"
import * as THREE from "three"
import type { Vec3 } from "./types"

extend({ RoundedBoxGeometry })
declare module "@react-three/fiber" {
	interface ThreeElements {
		roundedBoxGeometry: ThreeElement<typeof RoundedBoxGeometry>
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
			<roundedBoxGeometry args={[...size, 1, 0.045]} />
			<meshLambertMaterial color={color} />
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
			<boxGeometry args={size} />
			<meshStandardMaterial color={color} roughness={0.8} />
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
			<cylinderGeometry args={[radius, radius, length, 20]} />
			<meshStandardMaterial color={color} roughness={0.5} metalness={0.4} />
		</mesh>
	)
}

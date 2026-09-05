import { memo, useMemo } from "react"
import type { FactoryRoute } from "./factory-routing"
import type { SpatialLayout } from "./spatial-layout"
import { buildVoxelLandscape, type VoxelPart } from "./voxel-landscape"

function VoxelInstances({ parts }: { parts: VoxelPart[] }) {
	return (
		<instancedMesh
			args={[undefined, undefined, parts.length]}
			castShadow
			receiveShadow
			ref={(mesh) => {
				if (!mesh) return
				parts.forEach((part, index) => {
					mesh.setMatrixAt(index, part.matrix)
					mesh.setColorAt(index, part.color)
				})
				mesh.instanceMatrix.needsUpdate = true
				if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
				mesh.computeBoundingSphere()
			}}
		>
			<boxGeometry />
			<meshLambertMaterial />
		</instancedMesh>
	)
}

export const Landscape = memo(function Landscape({
	layout,
	routes,
	dark,
}: {
	layout: SpatialLayout
	routes: FactoryRoute[]
	dark: boolean
}) {
	const { terrain, plants } = useMemo(
		() => buildVoxelLandscape(layout, routes, dark),
		[layout, routes, dark],
	)
	return (
		<group>
			<VoxelInstances parts={terrain} />
			<VoxelInstances parts={plants} />
		</group>
	)
})

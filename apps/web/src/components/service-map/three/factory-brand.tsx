import { useMemo } from "react"
import * as THREE from "three"
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js"
import { MAPLE_MARK_PATH } from "@maple/ui/components/icons/maple-mark"
import { useMountEffect } from "@/hooks/use-mount-effect"
import type { Vec3 } from "./types"
import { FACTORY_FINISH } from "./appearance"
import { MachineBox } from "./factory-primitives"

/** The real Maple artwork, including its eye knockouts, pressed into enamel. */
export function FactoryBadge({ position, muted }: { position: Vec3; muted: boolean }) {
	const geometry = useMemo(() => {
		const svg = new SVGLoader().parse(
			`<svg xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="${MAPLE_MARK_PATH}" /></svg>`,
		)
		const mark = new THREE.ShapeGeometry(
			svg.paths.flatMap((path) => SVGLoader.createShapes(path)),
			8,
		)
		mark.translate(-369.5, -369.5, 0)
		mark.scale(0.00041, -0.00041, 1)
		return mark
	}, [])
	useMountEffect(() => () => geometry.dispose())
	return (
		<group position={[...position]}>
			<MachineBox size={[0.44, 0.44, 0.045]} color={muted ? "#a29b82" : "#f0dfbc"} />
			<mesh geometry={geometry} position={[0, 0, 0.025]}>
				<meshStandardMaterial
					color={muted ? "#807254" : FACTORY_FINISH.amber}
					roughness={0.9}
					side={THREE.DoubleSide}
				/>
			</mesh>
		</group>
	)
}

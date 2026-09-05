import { memo, useRef } from "react"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"
import type { Node3D } from "./types"
import type { Vec3 } from "./types"
import { FACTORY_FINISH, MAP_MATERIALS } from "./appearance"
import { health, HEALTH_COLOR, nodeHeight, type SpatialView } from "./spatial-layout"
import { Axle, BoxInstances, MachineBox } from "./factory-primitives"
import { FactoryBadge } from "./factory-brand"
import { resolveMachineBadge } from "./factory-badge"

interface Finish {
	body: string
	trim: string
	dark: string
	signal: string
	steel: string
}

function RoofFan({ y, running, finish }: { y: number; running: boolean; finish: Finish }) {
	const rotor = useRef<THREE.Group>(null)
	useFrame((_, delta) => {
		if (running && rotor.current) rotor.current.rotation.y += Math.min(delta, 0.05) * 2.4
	})
	return (
		<group position={[0, y, 0]}>
			<Axle position={[0, 0.035, 0]} radius={0.57} length={0.1} color={finish.dark} />
			<group ref={rotor} position={[0, 0.1, 0]}>
				{[0, 1, 2, 3].map((blade) => (
					<group key={blade} rotation={[0, (blade * Math.PI) / 2, 0]}>
						<mesh position={[0.33, 0, 0]}>
							<boxGeometry args={[0.4, 0.035, 0.15]} />
							<meshStandardMaterial color={finish.steel} roughness={0.85} metalness={0.15} />
						</mesh>
					</group>
				))}
			</group>
			<mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.12, 0]}>
				<voxelGeometry args={["torus", 1.2, 1.2, 0.12, 0.06]} />
				<meshStandardMaterial vertexColors color={finish.trim} roughness={0.65} />
			</mesh>
			<Axle position={[0, 0.12, 0]} radius={0.12} length={0.15} color={finish.trim} />
		</group>
	)
}

function StackLight({ y, finish }: { y: number; finish: Finish }) {
	return (
		<group position={[0.82, y, -0.55]}>
			<Axle position={[0, 0.22, 0]} radius={0.055} length={0.44} color={finish.steel} />
			<Axle position={[0, 0.47, 0]} radius={0.13} length={0.19} color={finish.signal} />
			<Axle position={[0, 0.59, 0]} radius={0.15} length={0.06} color={finish.dark} />
		</group>
	)
}

function Processor({ height, finish, running }: { height: number; finish: Finish; running: boolean }) {
	return (
		<group>
			<MachineBox size={[2.1, height, 1.65]} position={[0, height / 2 + 0.2, 0]} color={finish.body} />
			<MachineBox size={[2.2, 0.14, 1.75]} position={[0, height + 0.2, 0]} color={finish.trim} />
			<MachineBox
				size={[0.76, 0.42, 0.06]}
				position={[0.42, height * 0.6 + 0.2, 0.85]}
				color={finish.dark}
			/>
			<BoxInstances
				size={[0.07, 0.15, 0.025]}
				positions={[0, 0.04, 0.08, 0.02].map((rise, index) => [
					0.23 + index * 0.13,
					height * 0.6 + 0.13 + rise,
					0.89,
				])}
				color={finish.signal}
			/>
			<BoxInstances
				size={[0.5, 0.04, 0.025]}
				positions={[0, 1, 2, 3, 4].map((i) => [-0.58, height * 0.55 + i * 0.12, 0.84])}
				color={finish.dark}
			/>
			<group position={[0.4, height + 0.29, 0]} scale={0.82}>
				<RoofFan y={0} finish={finish} running={running} />
			</group>
			<StackLight y={height + 0.23} finish={finish} />
		</group>
	)
}

function StorageTank({ height, finish }: { height: number; finish: Finish }) {
	return (
		<group>
			<Axle position={[0, height / 2 + 0.22, 0]} radius={0.86} length={height} color={finish.body} />
			{[0.1, 0.5, 0.9].map((fraction) => (
				<mesh
					key={fraction}
					position={[0, height * fraction + 0.23, 0]}
					rotation={[-Math.PI / 2, 0, 0]}
				>
					<voxelGeometry args={["torus", 1.86, 1.86, 0.16, 0.09]} />
					<meshStandardMaterial
						vertexColors
						color={finish.steel}
						metalness={0.15}
						roughness={0.85}
					/>
				</mesh>
			))}
			<mesh position={[0, height + 0.38, 0]} castShadow receiveShadow>
				<voxelGeometry args={["dome", 1.72, 0.32, 1.72, 0.08]} />
				<meshStandardMaterial vertexColors color={finish.trim} roughness={0.65} metalness={0.1} />
			</mesh>
			<Axle position={[0, height + 0.55, -0.48]} radius={0.12} length={0.26} color={finish.steel} />
			<MachineBox
				size={[0.25, height * 0.62, 0.07]}
				position={[0, height * 0.55 + 0.2, 0.87]}
				color={finish.dark}
			/>
			<MachineBox
				size={[0.12, height * 0.38, 0.025]}
				position={[0, height * 0.43 + 0.2, 0.92]}
				color={finish.signal}
			/>
			<BoxInstances
				size={[0.055, height, 0.055]}
				positions={[
					[0.64, height / 2 + 0.2, 0.74],
					[0.95, height / 2 + 0.2, 0.74],
				]}
				color={finish.steel}
			/>
			<BoxInstances
				size={[0.39, 0.05, 0.05]}
				positions={Array.from({ length: Math.ceil(height / 0.25) }, (_, i) => [
					0.8,
					0.3 + i * 0.25,
					0.74,
				])}
				color={finish.steel}
			/>
		</group>
	)
}

function LoadingBay({ height, finish, running }: { height: number; finish: Finish; running: boolean }) {
	const press = useRef<THREE.Group>(null)
	const elapsed = useRef(0)
	useFrame((_, delta) => {
		if (!running || !press.current) return
		elapsed.current += Math.min(delta, 0.05)
		press.current.position.y = -0.14 * (1 - Math.cos(elapsed.current * 2.8))
	})
	return (
		<group>
			<MachineBox size={[2.2, 0.36, 1.7]} position={[0, 0.38, 0]} color={finish.dark} />
			<BoxInstances
				size={[0.12, 0.1, 1.45]}
				positions={[-0.85, -0.57, -0.28, 0, 0.28, 0.57, 0.85].map((x) => [x, 0.61, 0])}
				color={finish.steel}
			/>
			<BoxInstances
				size={[0.2, height + 0.55, 0.22]}
				positions={[
					[-0.95, height / 2 + 0.42, -0.6],
					[0.95, height / 2 + 0.42, -0.6],
				]}
				color={finish.body}
			/>
			<MachineBox size={[2.3, 0.28, 0.45]} position={[0, height + 0.67, -0.6]} color={finish.body} />
			<group ref={press}>
				<Axle position={[0, height + 0.24, -0.6]} radius={0.06} length={0.65} color={finish.steel} />
				<MachineBox size={[0.8, 0.2, 0.7]} position={[0, height - 0.04, -0.3]} color={finish.trim} />
			</group>
			<MachineBox size={[0.55, 0.48, 0.5]} position={[-0.3, 0.91, 0.05]} color="#b99057" />
			<MachineBox size={[0.58, 0.055, 0.12]} position={[-0.3, 1.18, 0.05]} color="#e4c58c" />
			<StackLight y={height + 0.7} finish={finish} />
		</group>
	)
}

function Gateway({ height, finish }: { height: number; finish: Finish }) {
	return (
		<group>
			<BoxInstances
				size={[0.4, height, 1.35]}
				positions={[
					[-0.87, height / 2 + 0.2, 0],
					[0.87, height / 2 + 0.2, 0],
				]}
				color={finish.body}
			/>
			<MachineBox size={[2.2, 0.42, 1.55]} position={[0, height + 0.08, 0]} color={finish.body} />
			<MachineBox size={[1.1, 0.18, 0.04]} position={[0, height + 0.09, 0.8]} color={finish.dark} />
			<BoxInstances
				size={[0.13, 0.065, 0.04]}
				positions={[-0.37, -0.12, 0.12, 0.37].map((x) => [x, height + 0.1, 0.84])}
				color={finish.signal}
			/>
			<Axle position={[0, 0.47, 0]} radius={0.28} length={1.5} color={finish.steel} axis="x" />
			<BoxInstances
				size={[0.14, 0.025, 0.14]}
				positions={[
					[-0.88, height + 0.31, -0.45],
					[0.88, height + 0.31, -0.45],
					[-0.88, height + 0.31, 0.45],
					[0.88, height + 0.31, 0.45],
				]}
				color={finish.steel}
			/>
			<StackLight y={height + 0.3} finish={finish} />
		</group>
	)
}

function PumpStation({ height, finish, running }: { height: number; finish: Finish; running: boolean }) {
	const wheel = useRef<THREE.Group>(null)
	useFrame((_, delta) => {
		if (running && wheel.current) wheel.current.rotation.z -= Math.min(delta, 0.05) * 1.2
	})
	return (
		<group>
			<MachineBox
				size={[1.8, height * 0.45, 1.4]}
				position={[0, height * 0.225 + 0.2, 0]}
				color={finish.body}
			/>
			<Axle
				position={[0, height * 0.5 + 0.62, 0]}
				radius={0.55}
				length={1.7}
				color={finish.trim}
				axis="x"
			/>
			<group position={[0, height * 0.5 + 0.62, 0.64]}>
				<group ref={wheel}>
					<mesh>
						<voxelGeometry args={["torus", 0.92, 0.92, 0.16, 0.06]} />
						<meshStandardMaterial vertexColors color={finish.body} roughness={0.65} />
					</mesh>
					{[0, 1, 2, 3, 4, 5].map((i) => (
						<group key={i} rotation={[0, 0, (i * Math.PI) / 3]}>
							<mesh position={[0.24, 0, 0]}>
								<boxGeometry args={[0.22, 0.05, 0.055]} />
								<meshStandardMaterial
									color={finish.steel}
									metalness={0.15}
									roughness={0.85}
								/>
							</mesh>
						</group>
					))}
					<Axle position={[0, 0, 0]} radius={0.14} length={0.1} color={finish.steel} axis="z" />
				</group>
			</group>
			<StackLight y={height * 0.5 + 1.15} finish={finish} />
		</group>
	)
}

function machineKind(node: Node3D) {
	if (node.kind === "database") return "tank"
	if (node.kind === "queue" || node.id.endsWith("worker")) return "loader"
	if (node.kind === "external") return "pump"
	if (node.kind === "edge" || node.platform === "cloudflare") return "gateway"
	return "processor"
}

const MACHINE_MODELS = {
	processor: Processor,
	tank: StorageTank,
	loader: LoadingBay,
	gateway: Gateway,
	pump: PumpStation,
}

function badgeMount(
	kind: ReturnType<typeof machineKind>,
	height: number,
): { position: Vec3; rotation: Vec3; scale?: number } {
	// Roof plates share the machine's orientation and stay legible from above.
	// Tank plates sit on the cap; gantries carry a tilted sign.
	switch (kind) {
		case "processor":
			return { position: [-0.64, height + 0.31, 0], rotation: [-Math.PI / 2, 0, 0] }
		case "tank":
			return { position: [-0.24, height + 0.55, 0.12], rotation: [-Math.PI / 2, 0, 0], scale: 0.9 }
		case "gateway":
			return { position: [0, height + 0.33, 0], rotation: [-Math.PI / 2, 0, 0] }
		case "loader":
			return { position: [0, height + 0.72, -0.12], rotation: [-Math.PI / 5, 0, 0] }
		case "pump":
			return { position: [-0.48, height * 0.225 + 0.2, 0.99], rotation: [-Math.PI / 6, 0, 0] }
	}
}

export const FactoryMachine = memo(function FactoryMachine({
	node,
	position,
	view,
	dimmed,
	selected,
	dark,
	running,
	onSelect,
}: {
	node: Node3D
	position: Vec3
	view: SpatialView
	dimmed: boolean
	selected: boolean
	dark: boolean
	running: boolean
	onSelect: (id: string | null) => void
}) {
	const materials = MAP_MATERIALS[dark ? "dark" : "light"]
	const kind = machineKind(node)
	const badge = resolveMachineBadge(node)
	const height = view === "atlas" ? nodeHeight(node) : 1.15
	const finish: Finish = {
		body: dimmed ? materials.dimmed : FACTORY_FINISH.paint[kind],
		trim: dimmed ? materials.dimmed : materials.cap,
		dark: materials.seam,
		steel: dimmed ? materials.dimmed : FACTORY_FINISH.steel,
		signal: dimmed ? materials.dimmed : HEALTH_COLOR[health(node.errorRate)],
	}
	const machineProps = { height, finish, running: running && !dimmed }
	const Model = MACHINE_MODELS[kind]
	return (
		<group
			position={[...position]}
			onClick={(event) => {
				event.stopPropagation()
				onSelect(selected ? null : node.id)
			}}
		>
			<MachineBox
				size={[2.65, 0.2, 2.2]}
				position={[0, 0.1, 0]}
				color={selected ? "#c7a15b" : materials.base}
			/>
			<Model {...machineProps} />
			{badge && <FactoryBadge {...badgeMount(kind, height)} muted={dimmed} badge={badge} />}
			{[-1, 1].map((side) => (
				<Axle
					key={side}
					position={[side * 1.08, 0.72, 0]}
					radius={0.22}
					length={0.6}
					color={finish.steel}
					axis="x"
				/>
			))}
			{[-1, 1].map((side) => (
				<Axle
					key={`z:${side}`}
					position={[0, 0.72, side * 1.03]}
					radius={0.22}
					length={0.54}
					color={finish.steel}
					axis="z"
				/>
			))}
			{selected && (
				<mesh position={[0, 0.12, 0]} rotation={[-Math.PI / 2, 0, Math.PI / 4]}>
					<ringGeometry args={[1.85, 1.93, 4]} />
					<meshBasicMaterial color="#d3ad69" side={THREE.DoubleSide} />
				</mesh>
			)}
		</group>
	)
})

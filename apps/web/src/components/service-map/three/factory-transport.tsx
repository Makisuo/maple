import { useMemo } from "react"
import * as THREE from "three"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { connectionStyle, FACTORY_FINISH, GROUND_Y, MAP_MATERIALS } from "./appearance"
import { CurveSection, beltGeometry, type FactoryLink } from "./factory-routing"
import { Axle, MachineBox } from "./factory-primitives"
import { useFactoryMotion } from "./factory-motion"

interface TransportProps {
	link: FactoryLink
	running: boolean
	active: boolean
	dimmed: boolean
	dark: boolean
}

function PipeTraffic({
	link,
	running,
	dimmed,
	color,
}: {
	link: FactoryLink
	running: boolean
	dimmed: boolean
	color: string
}) {
	const count = Math.min(10, 3 + Math.ceil(Math.sqrt(link.edge.callsPerSecond) / 8))
	const motion = useFactoryMotion(link, running, count, 3.2 + link.edge.avgLatencyMs / 180)
	return (
		<instancedMesh args={[undefined, undefined, count]} frustumCulled={false} visible={!dimmed}>
			<sphereGeometry args={[link.radius * 0.68, 10, 8]}>
				<instancedBufferAttribute attach="attributes-factoryPhase" args={[motion.phases, 1]} />
			</sphereGeometry>
			<meshBasicMaterial color={color} {...motion.material} />
		</instancedMesh>
	)
}

function Supports({ link, dark }: { link: FactoryLink; dark: boolean }) {
	const materials = MAP_MATERIALS[dark ? "dark" : "light"]
	return (
		<group>
			{[0.25, 0.75].map((t) => {
				const point = link.curve.getPointAt(t)
				const height = point.y - GROUND_Y - 0.12
				return (
					<group key={t}>
						<Axle
							position={[point.x, GROUND_Y + height / 2, point.z]}
							radius={0.055}
							length={height}
							color={materials.base}
						/>
						<MachineBox
							size={[0.4, 0.07, 0.4]}
							position={[point.x, GROUND_Y + 0.035, point.z]}
							color={materials.base}
						/>
					</group>
				)
			})}
		</group>
	)
}

function Signpost({ link }: { link: FactoryLink }) {
	const base = link.curve.getPointAt(0.5)
	return (
		<group>
			<mesh position={[base.x, base.y + 0.5, base.z]}>
				<cylinderGeometry args={[0.035, 0.035, 0.8, 8]} />
				<meshStandardMaterial color="#a3a69a" metalness={0.5} roughness={0.5} />
			</mesh>
			<mesh position={[base.x, base.y + 0.9, base.z]}>
				<sphereGeometry args={[0.07, 10, 8]} />
				<meshStandardMaterial color="#c5bd9f" metalness={0.4} roughness={0.5} />
			</mesh>
		</group>
	)
}

function Pipeline({ link, running, active, dimmed, dark }: TransportProps) {
	const { color } = connectionStyle(link.edge.errorRate, dark, active, dimmed)
	const metal = dimmed ? (dark ? "#414b43" : "#a7b4a8") : active ? "#d4ba86" : FACTORY_FINISH.pipe
	const sections = useMemo(
		() => [new CurveSection(link.curve, 0, 0.38), new CurveSection(link.curve, 0.62, 1)],
		[link.curve],
	)
	const glass = useMemo(() => new CurveSection(link.curve, 0.38, 0.62), [link.curve])
	const collars = useMemo(
		() =>
			[0.035, 0.38, 0.62, 0.965].map((t) => ({
				point: link.curve.getPointAt(t),
				rotation: new THREE.Quaternion().setFromUnitVectors(
					new THREE.Vector3(0, 1, 0),
					link.curve.getTangentAt(t).normalize(),
				),
			})),
		[link.curve],
	)
	const valve = link.curve.getPointAt(0.18)
	return (
		<group>
			{sections.map((section, i) => (
				<mesh key={i} castShadow receiveShadow>
					<tubeGeometry args={[section, 48, link.radius, 10, false]} />
					<meshStandardMaterial color={metal} roughness={0.44} metalness={0.48} />
				</mesh>
			))}
			<mesh renderOrder={2}>
				<tubeGeometry args={[glass, 32, link.radius, 12, false]} />
				<meshStandardMaterial
					color={dark ? "#afcbbc" : "#698b7b"}
					roughness={0.15}
					metalness={0.15}
					transparent
					opacity={dimmed ? 0.1 : 0.28}
					depthWrite={false}
					side={THREE.DoubleSide}
				/>
			</mesh>
			{collars.map(({ point, rotation }, i) => (
				<mesh key={i} position={point} quaternion={rotation} castShadow>
					<cylinderGeometry args={[link.radius * 1.48, link.radius * 1.48, 0.13, 16]} />
					<meshStandardMaterial
						color={dimmed ? metal : FACTORY_FINISH.collar}
						roughness={0.5}
						metalness={0.4}
					/>
				</mesh>
			))}
			<group position={valve}>
				<Axle position={[0, 0.23, 0]} radius={0.035} length={0.46} color={metal} />
				<mesh position={[0, 0.46, 0]} rotation={[-Math.PI / 2, 0, 0]}>
					<torusGeometry args={[0.22, 0.035, 6, 20]} />
					<meshStandardMaterial color={dimmed ? metal : "#d29543"} roughness={0.6} />
				</mesh>
				<mesh position={[0, 0.46, 0]}>
					<boxGeometry args={[0.4, 0.03, 0.04]} />
					<meshStandardMaterial color={metal} />
				</mesh>
			</group>
			<Supports link={link} dark={dark} />
			{link.edge.callsPerSecond > 0 && (
				<PipeTraffic
					link={link}
					running={running}
					dimmed={dimmed}
					color={active ? "#f0c775" : color}
				/>
			)}
		</group>
	)
}

function BeltCargo({ link, running, dimmed }: { link: FactoryLink; running: boolean; dimmed: boolean }) {
	const count = Math.min(8, 3 + Math.ceil(link.edge.callsPerSecond / 50))
	const motion = useFactoryMotion(link, running, count, 7, 0.27, true)
	return (
		<group visible={!dimmed}>
			<instancedMesh args={[undefined, undefined, count]} frustumCulled={false}>
				<boxGeometry args={[0.42, 0.42, 0.44]}>
					<instancedBufferAttribute attach="attributes-factoryPhase" args={[motion.phases, 1]} />
				</boxGeometry>
				<meshStandardMaterial color="#c49a5b" roughness={0.85} {...motion.material} />
			</instancedMesh>
			<instancedMesh args={[undefined, undefined, count]} frustumCulled={false}>
				<boxGeometry args={[0.1, 0.43, 0.45]}>
					<instancedBufferAttribute attach="attributes-factoryPhase" args={[motion.phases, 1]} />
				</boxGeometry>
				<meshStandardMaterial color="#e9cd8f" roughness={0.7} {...motion.material} />
			</instancedMesh>
		</group>
	)
}

function ConveyorTreads({ link, running, dimmed }: { link: FactoryLink; running: boolean; dimmed: boolean }) {
	const count = Math.min(100, Math.ceil(link.curve.getLength() / 0.5))
	const motion = useFactoryMotion(link, running, count, 7 * 0.86, 0.09)
	return (
		<instancedMesh args={[undefined, undefined, count]} frustumCulled={false}>
			<boxGeometry args={[0.77, 0.035, 0.12]}>
				<instancedBufferAttribute attach="attributes-factoryPhase" args={[motion.phases, 1]} />
			</boxGeometry>
			<meshStandardMaterial
				color={dimmed ? "#424d41" : "#5d6959"}
				roughness={0.95}
				{...motion.material}
			/>
		</instancedMesh>
	)
}

function Conveyor({ link, running, dimmed, dark }: TransportProps) {
	const deck = useMemo(() => beltGeometry(link.curve, 0.8), [link.curve])
	const left = useMemo(() => beltGeometry(link.curve, 0.1, -0.45), [link.curve])
	const right = useMemo(() => beltGeometry(link.curve, 0.1, 0.45), [link.curve])
	useMountEffect(() => () => {
		deck.dispose()
		left.dispose()
		right.dispose()
	})
	const rollers = useMemo(() => {
		const count = Math.min(120, Math.ceil(link.curve.getLength() / 0.38))
		return Array.from({ length: count }, (_, i) => {
			const t = i / Math.max(1, count - 1),
				point = link.curve.getPointAt(t),
				tangent = link.curve.getTangentAt(t)
			const side = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize()
			const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), side)
			return new THREE.Matrix4().compose(
				point.add(new THREE.Vector3(0, 0.025, 0)),
				rotation,
				new THREE.Vector3(1, 1, 1),
			)
		})
	}, [link.curve])
	return (
		<group>
			<mesh geometry={deck} castShadow receiveShadow>
				<meshStandardMaterial
					color={dark ? "#2e3833" : "#697568"}
					side={THREE.DoubleSide}
					roughness={0.95}
				/>
			</mesh>
			{[left, right].map((geometry, i) => (
				<mesh key={i} geometry={geometry} position={[0, 0.09, 0]} castShadow>
					<meshStandardMaterial
						color={dimmed ? "#667166" : "#d09d58"}
						side={THREE.DoubleSide}
						roughness={0.55}
						metalness={0.3}
					/>
				</mesh>
			))}
			<instancedMesh
				args={[undefined, undefined, rollers.length]}
				ref={(mesh) => {
					if (!mesh) return
					rollers.forEach((matrix, index) => mesh.setMatrixAt(index, matrix))
					mesh.instanceMatrix.needsUpdate = true
					mesh.computeBoundingSphere()
				}}
			>
				<cylinderGeometry args={[0.055, 0.055, 0.76, 10]} />
				<meshStandardMaterial
					color={dimmed ? "#505b50" : "#879285"}
					roughness={0.6}
					metalness={0.45}
				/>
			</instancedMesh>
			<Supports link={link} dark={dark} />
			<ConveyorTreads link={link} running={running} dimmed={dimmed} />
			{link.edge.callsPerSecond > 0 && <BeltCargo link={link} running={running} dimmed={dimmed} />}
		</group>
	)
}

export function FactoryTransport(props: TransportProps) {
	const direction = useMemo(
		() => ({
			point: props.link.curve.getPointAt(0.58),
			rotation: new THREE.Quaternion().setFromUnitVectors(
				new THREE.Vector3(0, 1, 0),
				props.link.curve.getTangentAt(0.58),
			),
		}),
		[props.link.curve],
	)
	return (
		<group>
			{props.link.kind === "conveyor" ? <Conveyor {...props} /> : <Pipeline {...props} />}
			<mesh position={direction.point} quaternion={direction.rotation} visible={!props.dimmed}>
				<coneGeometry args={[props.link.radius * 0.7, 0.3, 6]} />
				<meshBasicMaterial color="#e4c787" />
			</mesh>
			{(props.link.prominent || props.active) && <Signpost link={props.link} />}
		</group>
	)
}

import { memo, useEffect, useMemo, useRef } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"

import { useMountEffect } from "@/hooks/use-mount-effect"

import { edgeColor, nodeColor, type ColorMode3D } from "./color"
import type { Edge3D, Node3D, Topology3D } from "./fixture"
import {
	bezierControl,
	fitCamera,
	layoutGraph,
	nodeScale,
	pipeRadius,
	type Layout3DMode,
	type Vec3,
} from "./layout"

/**
 * The WebGL half of the 3D service-map experiment.
 *
 * Everything here is built once per (topology, layout, colorMode) and then only
 * animated — `useFrame` writes into pre-allocated instance matrices and never
 * touches React state, so the flow animation costs no re-renders.
 */

const BACKDROP = "#0a0d14"
/** Label height as a share of viewport height (sprites are size-attenuation-free). */
const LABEL_HEIGHT = 0.045
const vec = ([x, y, z]: Vec3) => new THREE.Vector3(x, y, z)

interface Pipe {
	edge: Edge3D
	curve: THREE.QuadraticBezierCurve3
	radius: number
	color: THREE.Color
	/** Packets per second this pipe should launch. */
	packetRate: number
	packetCount: number
	/** Seconds a packet takes to traverse, from the edge's own latency. */
	travelSeconds: number
}

/** One shared radial-gradient sprite, tinted per node — cheap stand-in for bloom. */
function makeHaloTexture(): THREE.Texture {
	const size = 128
	const canvas = document.createElement("canvas")
	canvas.width = size
	canvas.height = size
	const ctx = canvas.getContext("2d")
	if (ctx) {
		const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
		gradient.addColorStop(0, "rgba(255,255,255,0.9)")
		gradient.addColorStop(0.35, "rgba(255,255,255,0.28)")
		gradient.addColorStop(1, "rgba(255,255,255,0)")
		ctx.fillStyle = gradient
		ctx.fillRect(0, 0, size, size)
	}
	const texture = new THREE.CanvasTexture(canvas)
	texture.colorSpace = THREE.SRGBColorSpace
	return texture
}

/**
 * Labels are canvas textures rather than `troika`/`drei` text: no font fetch, no
 * extra dependency, and a sprite always faces the camera for free.
 */
function makeLabelTexture(text: string, sub: string): { texture: THREE.Texture; aspect: number } {
	const scale = 2
	const font = `600 ${13 * scale}px ui-sans-serif, system-ui, sans-serif`
	const subFont = `${10 * scale}px ui-monospace, monospace`
	const measure = document.createElement("canvas").getContext("2d")
	if (measure) measure.font = font
	const textWidth = measure?.measureText(text).width ?? text.length * 8 * scale
	if (measure) measure.font = subFont
	const subWidth = sub ? (measure?.measureText(sub).width ?? 0) : 0
	const padding = 10 * scale
	const width = Math.ceil(Math.max(textWidth, subWidth) + padding * 2)
	const height = Math.ceil((sub ? 34 : 22) * scale)

	const canvas = document.createElement("canvas")
	canvas.width = width
	canvas.height = height
	const ctx = canvas.getContext("2d")
	if (ctx) {
		ctx.fillStyle = "rgba(8,11,18,0.72)"
		ctx.beginPath()
		ctx.roundRect(0, 0, width, height, 6 * scale)
		ctx.fill()
		ctx.textBaseline = "top"
		ctx.fillStyle = "rgba(244,247,255,0.96)"
		ctx.font = font
		ctx.fillText(text, padding, 4 * scale)
		if (sub) {
			ctx.fillStyle = "rgba(160,172,196,0.9)"
			ctx.font = subFont
			ctx.fillText(sub, padding, 20 * scale)
		}
	}
	const texture = new THREE.CanvasTexture(canvas)
	texture.colorSpace = THREE.SRGBColorSpace
	return { texture, aspect: width / height }
}

const geometryFor = (node: Node3D): THREE.BufferGeometry => {
	switch (node.kind) {
		case "edge":
			return new THREE.SphereGeometry(0.95, 32, 24)
		case "database":
			return new THREE.CylinderGeometry(0.85, 0.85, 1.25, 36)
		case "queue":
			return new THREE.CapsuleGeometry(0.5, 1.5, 8, 24)
		case "external":
			return new THREE.OctahedronGeometry(1.05, 0)
		default:
			return new THREE.BoxGeometry(1.5, 1.15, 1.5)
	}
}

const VIEW_DIRECTION: Vec3 = [0.66, 0.34, 0.72]
const CAMERA_FOV = 46
/** Share of the frustum the graph should occupy after framing. */
const FRAME_FILL = 0.9
/** Frames to keep re-fitting while the canvas settles into its flex parent. */
const SETTLE_FRAMES = 30

/**
 * Place the camera so the graph is both fully visible and optically centred.
 *
 * {@link fitCamera} gives the starting distance and the geometric centre, but a
 * perspective view of a deep graph is not balanced around its geometric centre:
 * near nodes project further from the axis than far ones, so the mass drifts to
 * whichever side is closest. These passes measure the projected bounds and slide
 * the orbit target until they are symmetric, re-fitting the distance as they go.
 */
function frameCamera(
	camera: THREE.PerspectiveCamera,
	target: THREE.Vector3,
	points: ReadonlyArray<Vec3>,
	aspect: number,
): void {
	const direction = vec(VIEW_DIRECTION).normalize()
	const probe = new THREE.Vector3()
	const right = new THREE.Vector3()
	const up = new THREE.Vector3()
	let distance = fitCamera(points, { direction: VIEW_DIRECTION, fovDegrees: CAMERA_FOV, aspect })
		.distance

	for (let pass = 0; pass < 4; pass++) {
		camera.position.copy(target).addScaledVector(direction, distance)
		camera.lookAt(target)
		camera.updateMatrixWorld()

		let minX = Infinity
		let maxX = -Infinity
		let minY = Infinity
		let maxY = -Infinity
		for (const point of points) {
			probe.set(point[0], point[1], point[2]).project(camera)
			minX = Math.min(minX, probe.x)
			maxX = Math.max(maxX, probe.x)
			minY = Math.min(minY, probe.y)
			maxY = Math.max(maxY, probe.y)
		}

		const halfHeight = Math.tan((CAMERA_FOV * Math.PI) / 360) * distance
		right.setFromMatrixColumn(camera.matrixWorld, 0)
		up.setFromMatrixColumn(camera.matrixWorld, 1)
		target
			.addScaledVector(right, ((minX + maxX) / 2) * halfHeight * aspect)
			.addScaledVector(up, ((minY + maxY) / 2) * halfHeight)

		distance *= Math.min(1.6, Math.max(0.7, Math.max(maxX - minX, maxY - minY) / 2 / FRAME_FILL))
	}

	camera.position.copy(target).addScaledVector(direction, distance)
	camera.lookAt(target)
	camera.updateMatrixWorld()
}

/**
 * Orbit controls, re-framed whenever the layout changes — a camera left where
 * the previous layout put it either clips the new one or stares at empty space.
 */
function Controls({
	autoRotate,
	points,
	layoutId,
}: {
	autoRotate: boolean
	points: ReadonlyArray<Vec3>
	layoutId: string
}) {
	const camera = useThree((state) => state.camera)
	const domElement = useThree((state) => state.gl.domElement)
	const controls = useRef<OrbitControls | null>(null)

	useEffect(() => {
		const instance = new OrbitControls(camera, domElement)
		instance.enableDamping = true
		instance.dampingFactor = 0.08
		instance.minDistance = 8
		instance.maxDistance = 320
		controls.current = instance
		return () => {
			instance.dispose()
			controls.current = null
		}
	}, [camera, domElement])

	const framedFor = useRef<string | null>(null)
	const settleFrames = useRef(0)

	useEffect(() => {
		settleFrames.current = 0
	}, [layoutId])

	// Framing happens on the first frame rather than in an effect: `<Canvas>` is
	// the parent, so R3F applies its own `camera` prop after every child effect
	// has run and would snap the camera back off a freshly fitted position.
	useFrame(() => {
		const instance = controls.current
		if (!instance) return

		// Re-fit for the first few frames, not just once: the canvas grows into its
		// flex parent over the first paints, and its reported size lags a frame
		// behind, so a single early fit leaves the graph off-centre for good.
		const rect = domElement.getBoundingClientRect()
		const aspect = rect.width / Math.max(rect.height, 1)
		const key = `${layoutId}@${aspect.toFixed(3)}`
		const settling = settleFrames.current < SETTLE_FRAMES
		if (settling) settleFrames.current += 1
		if ((settling || framedFor.current !== key) && camera instanceof THREE.PerspectiveCamera) {
			framedFor.current = key
			camera.fov = CAMERA_FOV
			camera.near = 0.1
			camera.far = 600
			camera.aspect = aspect
			camera.updateProjectionMatrix()
			const target = vec(fitCamera(points, {
				direction: VIEW_DIRECTION,
				fovDegrees: CAMERA_FOV,
				aspect,
			}).target)
			frameCamera(camera, target, points, aspect)
			instance.target.copy(target)
		}

		instance.autoRotate = autoRotate
		instance.autoRotateSpeed = 0.55
		instance.update()
	})

	return null
}

interface NodeMeshProps {
	node: Node3D
	position: Vec3
	color: string
	scale: number
	halo: THREE.Texture
	state: "normal" | "focused" | "dimmed"
	onSelect: (id: string | null) => void
	onHover: (id: string | null) => void
}

const NodeMesh = memo(function NodeMesh({
	node,
	position,
	color,
	scale,
	halo,
	state,
	onSelect,
	onHover,
}: NodeMeshProps) {
	const geometry = useMemo(() => geometryFor(node), [node])
	const label = useMemo(
		() => makeLabelTexture(node.label, node.system ?? node.namespace),
		[node.label, node.system, node.namespace],
	)
	useEffect(() => () => {
		geometry.dispose()
		label.texture.dispose()
	}, [geometry, label])

	const three = useMemo(() => new THREE.Color(color), [color])
	const dimmed = state === "dimmed"
	const focused = state === "focused"
	const spin = useRef<THREE.Mesh>(null)

	useFrame((_, delta) => {
		if (node.kind === "external" && spin.current) spin.current.rotation.y += delta * 0.4
	})

	return (
		<group position={vec(position)}>
			<mesh
				ref={spin}
				geometry={geometry}
				scale={scale}
				onPointerOver={(event) => {
					event.stopPropagation()
					onHover(node.id)
				}}
				onPointerOut={() => onHover(null)}
				onClick={(event) => {
					event.stopPropagation()
					onSelect(node.id)
				}}
			>
				<meshStandardMaterial
					color={three}
					emissive={three}
					emissiveIntensity={focused ? 0.85 : dimmed ? 0.05 : 0.3}
					roughness={0.34}
					metalness={0.3}
					transparent
					opacity={dimmed ? 0.24 : 1}
				/>
			</mesh>
			<sprite scale={[scale * 5.6, scale * 5.6, 1]}>
				<spriteMaterial
					map={halo}
					color={three}
					transparent
					opacity={dimmed ? 0.05 : focused ? 0.5 : 0.24}
					depthWrite={false}
					blending={THREE.AdditiveBlending}
				/>
			</sprite>
			{!dimmed && (
				// `sizeAttenuation: false` pins the label to a constant share of the
				// viewport, so text stays readable at any zoom instead of turning into
				// a billboard the size of the node it labels.
				<sprite position={[0, scale * 1.55, 0]} scale={[LABEL_HEIGHT * label.aspect, LABEL_HEIGHT, 1]}>
					<spriteMaterial
						map={label.texture}
						transparent
						sizeAttenuation={false}
						opacity={focused ? 1 : 0.88}
						depthWrite={false}
						depthTest={false}
					/>
				</sprite>
			)}
		</group>
	)
})

function Pipes({ pipes, dimmedEdges }: { pipes: ReadonlyArray<Pipe>; dimmedEdges: ReadonlySet<number> }) {
	const geometries = useMemo(
		() => pipes.map((pipe) => new THREE.TubeGeometry(pipe.curve, 48, pipe.radius, 10, false)),
		[pipes],
	)
	useEffect(() => () => geometries.forEach((geometry) => geometry.dispose()), [geometries])

	return (
		<group>
			{geometries.map((geometry, index) => {
				const pipe = pipes[index]!
				const dimmed = dimmedEdges.has(index)
				return (
					<mesh key={`${pipe.edge.source}->${pipe.edge.target}`} geometry={geometry}>
						<meshStandardMaterial
							color={pipe.color}
							emissive={pipe.color}
							emissiveIntensity={dimmed ? 0.04 : 0.32}
							roughness={0.5}
							metalness={0.15}
							transparent
							opacity={dimmed ? 0.06 : 0.42}
						/>
					</mesh>
				)
			})}
		</group>
	)
}

interface Packet {
	pipe: number
	offset: number
	speed: number
}

/**
 * Every in-flight call in the whole graph as one `InstancedMesh`: a packet's
 * position is `curve.getPointAt(t)`, its cadence is the edge's call rate and its
 * speed the edge's latency, so a slow, busy pipe visibly congests.
 */
function Packets({
	pipes,
	packets,
	dimmedEdges,
	running,
}: {
	pipes: ReadonlyArray<Pipe>
	packets: ReadonlyArray<Packet>
	dimmedEdges: ReadonlySet<number>
	running: boolean
}) {
	const mesh = useRef<THREE.InstancedMesh>(null)
	const clock = useRef(0)
	const dummy = useMemo(() => new THREE.Object3D(), [])
	const point = useMemo(() => new THREE.Vector3(), [])

	useEffect(() => {
		const instance = mesh.current
		if (!instance) return
		const color = new THREE.Color()
		packets.forEach((packet, index) => {
			instance.setColorAt(index, color.copy(pipes[packet.pipe]!.color).offsetHSL(0, 0, 0.22))
		})
		if (instance.instanceColor) instance.instanceColor.needsUpdate = true
	}, [packets, pipes])

	useFrame((_, delta) => {
		const instance = mesh.current
		if (!instance) return
		if (running) clock.current += delta
		const time = clock.current
		packets.forEach((packet, index) => {
			const pipe = pipes[packet.pipe]!
			const t = (packet.offset + time * packet.speed) % 1
			pipe.curve.getPoint(t, point)
			dummy.position.copy(point)
			const scale = dimmedEdges.has(packet.pipe) ? 0 : Math.max(0.11, pipe.radius * 0.85)
			dummy.scale.setScalar(scale)
			dummy.updateMatrix()
			instance.setMatrixAt(index, dummy.matrix)
		})
		instance.instanceMatrix.needsUpdate = true
	})

	if (packets.length === 0) return null

	return (
		<instancedMesh ref={mesh} args={[undefined, undefined, packets.length]} frustumCulled={false}>
			<sphereGeometry args={[1, 10, 8]} />
			<meshBasicMaterial toneMapped={false} blending={THREE.AdditiveBlending} transparent depthWrite={false} />
		</instancedMesh>
	)
}

/** One faint disc per storey, so the floors read as floors and not as free space. */
function TierPlanes({ tierCount, radius }: { tierCount: number; radius: number }) {
	return (
		<group>
			{Array.from({ length: tierCount }, (_, tier) => (
				<mesh key={tier} position={[0, -tier * 7 - 1.4, 0]} rotation={[-Math.PI / 2, 0, 0]}>
					<ringGeometry args={[radius * 1.34, radius * 1.4, 96]} />
					<meshBasicMaterial
						color="#3d5680"
						transparent
						opacity={0.16}
						side={THREE.DoubleSide}
						depthWrite={false}
					/>
				</mesh>
			))}
		</group>
	)
}

export interface ServiceMap3DProps {
	topology: Topology3D
	layoutMode: Layout3DMode
	colorMode: ColorMode3D
	flowing: boolean
	autoRotate: boolean
	selectedId: string | null
	onSelect: (id: string | null) => void
	onHover: (id: string | null) => void
}

export function ServiceMap3D({
	topology,
	layoutMode,
	colorMode,
	flowing,
	autoRotate,
	selectedId,
	onSelect,
	onHover,
}: ServiceMap3DProps) {
	const halo = useMemo(makeHaloTexture, [])
	useEffect(() => () => halo.dispose(), [halo])

	// R3F measures the canvas' parent once on mount, and here that happens while
	// the app shell is still laying out — leaving the canvas sized to the full
	// window and overflowing past the sidebar. One synthetic resize after the
	// first paint makes it re-measure against the settled layout.
	useMountEffect(() => {
		const frame = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")))
		return () => cancelAnimationFrame(frame)
	})

	const layout = useMemo(() => layoutGraph(topology, layoutMode), [topology, layoutMode])
	const peakThroughput = useMemo(
		() => topology.nodes.reduce((max, node) => Math.max(max, node.throughput), 1),
		[topology],
	)
	const peakRate = useMemo(
		() => topology.edges.reduce((max, edge) => Math.max(max, edge.callsPerSecond), 1),
		[topology],
	)

	const framePoints = useMemo(() => [...layout.positions.values()], [layout])

	const pipes = useMemo<Pipe[]>(() => {
		const nodesById = new Map(topology.nodes.map((node) => [node.id, node]))
		const seen = new Map<string, number>()
		return topology.edges.flatMap((edge) => {
			const from = layout.positions.get(edge.source)
			const to = layout.positions.get(edge.target)
			const source = nodesById.get(edge.source)
			if (!from || !to || !source) return []
			// Fan sibling pipes out of a shared plane so parallel runs stay legible.
			const key = `${edge.source}|${(layout.tiers.get(edge.target) ?? 0) - (layout.tiers.get(edge.source) ?? 0)}`
			const spread = seen.get(key) ?? 0
			seen.set(key, spread + 1)

			const curve = new THREE.QuadraticBezierCurve3(
				vec(from),
				vec(bezierControl(from, to, spread)),
				vec(to),
			)
			const rate = edge.callsPerSecond
			return [
				{
					edge,
					curve,
					radius: pipeRadius(rate, peakRate),
					color: new THREE.Color(edgeColor(edge.errorRate, nodeColor(source, colorMode))),
					packetRate: rate,
					packetCount: Math.max(2, Math.min(26, Math.round(Math.sqrt(rate) * 1.1))),
					travelSeconds: Math.min(4, Math.max(0.55, edge.avgLatencyMs / 120)),
				},
			]
		})
	}, [topology, layout, colorMode, peakRate])

	const packets = useMemo<Packet[]>(
		() =>
			pipes.flatMap((pipe, index) =>
				Array.from({ length: pipe.packetCount }, (_, packet) => ({
					pipe: index,
					offset: packet / pipe.packetCount,
					speed: 1 / pipe.travelSeconds,
				})),
			),
		[pipes],
	)

	const neighbours = useMemo(() => {
		if (!selectedId) return null
		const ids = new Set<string>([selectedId])
		const edges = new Set<number>()
		pipes.forEach((pipe, index) => {
			if (pipe.edge.source === selectedId || pipe.edge.target === selectedId) {
				edges.add(index)
				ids.add(pipe.edge.source)
				ids.add(pipe.edge.target)
			}
		})
		return { ids, edges }
	}, [selectedId, pipes])

	const dimmedEdges = useMemo(() => {
		if (!neighbours) return new Set<number>()
		return new Set(pipes.map((_, index) => index).filter((index) => !neighbours.edges.has(index)))
	}, [neighbours, pipes])

	return (
		<Canvas
			// No `camera` prop on purpose: R3F re-applies that prop after its
			// children's effects, which raced with — and sometimes undid — the fit
			// below. `Controls` owns the camera instead, lens included.
			dpr={[1, 2]}
			onPointerMissed={() => onSelect(null)}
			style={{ background: BACKDROP }}
		>
			<fogExp2 attach="fog" args={[BACKDROP, 0.0125]} />
			<ambientLight intensity={0.55} />
			<hemisphereLight args={["#7fa8ff", "#0b0f18", 0.7]} />
			<directionalLight position={[18, 26, 14]} intensity={1.1} />
			<pointLight position={[-20, -20, -12]} intensity={40} color="#4f7dff" distance={90} />

			<Controls autoRotate={autoRotate} points={framePoints} layoutId={layoutMode} />
			{layoutMode === "floors" && <TierPlanes tierCount={layout.tierCount} radius={layout.radius} />}
			<Pipes pipes={pipes} dimmedEdges={dimmedEdges} />
			<Packets pipes={pipes} packets={packets} dimmedEdges={dimmedEdges} running={flowing} />

			{topology.nodes.map((node) => {
				const position = layout.positions.get(node.id)
				if (!position) return null
				const state = !neighbours
					? "normal"
					: node.id === selectedId
						? "focused"
						: neighbours.ids.has(node.id)
							? "normal"
							: "dimmed"
				return (
					<NodeMesh
						key={node.id}
						node={node}
						position={position}
						color={nodeColor(node, colorMode)}
						scale={nodeScale(node.throughput, peakThroughput)}
						halo={halo}
						state={state}
						onSelect={onSelect}
						onHover={onHover}
					/>
				)
			})}
		</Canvas>
	)
}

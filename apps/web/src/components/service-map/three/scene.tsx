import { Component, useMemo, useRef, type ReactNode, type RefObject } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { useMountEffect } from "@/hooks/use-mount-effect"
import type { Topology3D } from "./types"
import type { Vec3 } from "./types"
import { GROUND_Y, MAP_MATERIALS } from "./appearance"
import { connectedIds, type SpatialLayout, type SpatialView } from "./spatial-layout"
import { MachineBox } from "./factory-primitives"
import { FactoryMachine } from "./factory-machines"
import { Landscape } from "./landscape"
import { Sky } from "./sky"
import { islandDepth, islandFootprint } from "./terrain"
import { FactoryTransport } from "./factory-transport"
import type { FactoryLink, FactoryRoute } from "./factory-routing"

export interface CameraCommand {
	action: "reset" | "in" | "out"
	serial: number
}
export interface SceneProps {
	topology: Topology3D
	layout: SpatialLayout
	links: FactoryLink[]
	routes: FactoryRoute[]
	view: SpatialView
	selectedId: string | null
	onSelect: (id: string | null) => void
	flowing: boolean
	dark: boolean
	command: CameraCommand
	labels: RefObject<Map<string, HTMLElement>>
}

const vector = (p: Vec3) => new THREE.Vector3(...p)

/** The camera and HTML labels share one projection. Labels stay sharp at every
 * zoom, expose actual buttons, and never cause React renders during orbit. */
function CameraRig({
	topology,
	layout,
	links,
	view,
	labels,
	selectedId,
	command,
}: Pick<SceneProps, "topology" | "layout" | "links" | "view" | "labels" | "selectedId" | "command">) {
	const { camera, gl, invalidate, size } = useThree()
	const controls = useRef<OrbitControls | null>(null)
	const lastFrame = useRef("")
	const lastCommand = useRef(-1)
	const lastProjection = useRef("")
	const probe = useMemo(() => new THREE.Vector3(), [])
	const linksById = useMemo(() => new Map(links.map((link) => [link.id, link])), [links])
	const nodesById = useMemo(() => new Map(topology.nodes.map((node) => [node.id, node])), [topology.nodes])
	const labelRevision = useMemo(
		() =>
			JSON.stringify([
				topology.nodes.map((node) => [node.id, node.label, node.throughput, node.dimmed]),
				links.map((link) => [link.id, link.edge.callsPerSecond]),
			]),
		[topology.nodes, links],
	)
	const layoutKey = useMemo(() => JSON.stringify([...layout.positions]), [layout])
	const bounds = useMemo(() => {
		const points = layout.districts.flatMap((district) =>
			[-1, 1].flatMap((x) =>
				[-1, 1].map(
					(z) =>
						new THREE.Vector3(
							district.position[0] + (x * district.width) / 2,
							district.position[1],
							district.position[2] + (z * district.depth) / 2,
						),
				),
			),
		)
		const island = islandFootprint(layout)
		for (const point of island.outline) {
			points.push(new THREE.Vector3(point.x, GROUND_Y - islandDepth(island), point.y))
			points.push(new THREE.Vector3(point.x, GROUND_Y + 3.2, point.y))
		}
		for (const point of layout.positions.values())
			points.push(vector(point).add(new THREE.Vector3(0, 4, 0)))
		return { points, center: new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3()) }
	}, [layout])
	useMountEffect(() => {
		const orbit = new OrbitControls(camera, gl.domElement)
		orbit.enableDamping = true
		orbit.dampingFactor = 0.12
		orbit.minPolarAngle = 0.18
		orbit.maxPolarAngle = Math.PI / 2.1
		orbit.minZoom = 0.05
		orbit.maxZoom = 100
		const onChange = () => invalidate()
		orbit.addEventListener("change", onChange)
		controls.current = orbit
		invalidate()
		return () => {
			orbit.removeEventListener("change", onChange)
			orbit.dispose()
			controls.current = null
		}
	})
	useFrame(() => {
		const orbit = controls.current
		if (!orbit || !(camera instanceof THREE.OrthographicCamera)) return
		const frameKey = `${view}:${size.width}:${size.height}:${layoutKey}`
		const newCommand = lastCommand.current !== command.serial
		if (lastFrame.current !== frameKey || (newCommand && command.action === "reset")) {
			lastFrame.current = frameKey
			camera.position
				.copy(bounds.center)
				.add(view === "atlas" ? new THREE.Vector3(0, 38, 23) : new THREE.Vector3(5, 34, 29))
			camera.lookAt(bounds.center)
			camera.zoom = 1
			camera.updateProjectionMatrix()
			camera.updateMatrixWorld()
			let left = Infinity,
				right = -Infinity,
				top = -Infinity,
				bottom = Infinity
			for (const point of bounds.points) {
				probe.copy(point).project(camera)
				left = Math.min(left, probe.x)
				right = Math.max(right, probe.x)
				top = Math.max(top, probe.y)
				bottom = Math.min(bottom, probe.y)
			}
			const shift = new THREE.Vector3()
				.setFromMatrixColumn(camera.matrixWorld, 0)
				.multiplyScalar(((left + right) * (camera.right - camera.left)) / 4)
				.addScaledVector(
					new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1),
					((top + bottom) * (camera.top - camera.bottom)) / 4,
				)
			camera.position.add(shift)
			const framing = size.width < 600 ? 1.9 : 2.1
			camera.zoom = Math.min(framing / (right - left), framing / (top - bottom))
			orbit.target.copy(bounds.center).add(shift)
			camera.updateProjectionMatrix()
			invalidate()
		} else if (newCommand) {
			camera.zoom = THREE.MathUtils.clamp(
				camera.zoom * (command.action === "in" ? 1.25 : 0.8),
				0.05,
				100,
			)
			camera.updateProjectionMatrix()
		}
		lastCommand.current = command.serial
		orbit.update()
		camera.updateMatrixWorld()
		const projectionKey = `${frameKey}:${selectedId}:${labelRevision}:${labels.current.size}:${camera.zoom}:${camera.matrixWorld.elements.join(",")}`
		if (lastProjection.current === projectionKey) return
		lastProjection.current = projectionKey
		// Declutter labels in screen space. The selected service wins every collision;
		// the full keyboard-accessible inventory stays available in the inspector.
		const related = connectedIds(topology, selectedId)
		const occupied = [...labels.current]
			.filter(([id]) => id.startsWith("overlay:"))
			.map(([, element]) => ({
				x: element.offsetLeft + element.offsetWidth / 2,
				y: element.offsetTop + element.offsetHeight / 2,
				width: element.offsetWidth,
				height: element.offsetHeight,
			}))
		const priority = (id: string) =>
			id === selectedId
				? 4
				: related?.has(id)
					? 3
					: nodesById.has(id)
						? nodesById.get(id)?.dimmed
							? 1
							: 2
						: linksById.has(id)
							? 0.5
							: 0
		const entries = [...labels.current]
			.sort(
				([a], [b]) =>
					priority(b) - priority(a) ||
					(nodesById.get(b)?.throughput ?? 0) - (nodesById.get(a)?.throughput ?? 0),
			)
			.map(([id, element]) => ({
				id,
				element,
				width: element.offsetWidth,
				height: element.offsetHeight,
			}))
		for (const { id, element, width, height } of entries) {
			const position = layout.positions.get(id)
			const link = linksById.get(id)
			const district = position
				? undefined
				: layout.districts.find((item) => `district:${item.id}` === id)
			if (position) probe.set(position[0], position[1], position[2] + 1.3)
			else if (district)
				probe.set(
					district.position[0] - district.width / 2 + 0.35,
					district.position[1],
					district.position[2] + district.depth / 2,
				)
			else if (link) probe.copy(link.signPosition)
			else continue
			probe.project(camera)
			const x = (probe.x * 0.5 + 0.5) * size.width
			const y = (-probe.y * 0.5 + 0.5) * size.height + (district ? 8 : link ? -height : 4)
			const hidden =
				(Boolean(position) && related !== null && !related.has(id)) ||
				probe.z < -1 ||
				probe.z > 1 ||
				x < 20 ||
				x > size.width - 20 ||
				y < 20 ||
				y > size.height - 25 ||
				occupied.some(
					(other) =>
						Math.abs(other.x - x) < (other.width + width) / 2 + 3 &&
						Math.abs(other.y - (y + height / 2)) < (other.height + height) / 2 + 2,
				)
			element.style.cssText = `transform:translate3d(${x}px,${y}px,0) translateX(-50%);visibility:${hidden ? "hidden" : "visible"};opacity:${element.style.opacity};background-color:${element.style.backgroundColor}`
			if (!hidden) occupied.push({ x, y: y + height / 2, width, height })
		}
	})
	return null
}

function MapScene(props: SceneProps) {
	const { topology, layout, links, routes, view, selectedId, onSelect, dark, flowing } = props
	const related = connectedIds(topology, selectedId)
	const materials = MAP_MATERIALS[dark ? "dark" : "light"]
	const layoutKey = useMemo(() => JSON.stringify([...layout.positions]), [layout])
	const island = useMemo(() => islandFootprint(layout), [layout])
	const highestPlatform = Math.max(0, ...layout.districts.map((district) => district.position[1]))
	const shadowExtent = (island.maxX - island.minX) / Math.SQRT2 + highestPlatform / 2 + 4
	const lightTarget = useMemo(() => {
		const target = new THREE.Object3D()
		target.position.set(island.center.x, highestPlatform / 2, island.center.y)
		return target
	}, [island, highestPlatform])
	const keyLight = useRef<THREE.DirectionalLight>(null)
	const lastShadow = useRef("")
	const shadowRevision = JSON.stringify([
		layoutKey,
		topology.nodes.map((node) => [node.id, node.throughput, node.kind, node.platform]),
		links.map((link) => [link.geometryKey, link.radius]),
	])
	useFrame(() => {
		// Rebuild when geometry changes, not during orbit or selection. A stable
		// world-space shadow map avoids crawling edges and repeated shadow passes.
		if (keyLight.current && lastShadow.current !== shadowRevision) {
			keyLight.current.shadow.needsUpdate = true
			lastShadow.current = shadowRevision
		}
	})
	return (
		<>
			<primitive object={lightTarget} />
			<hemisphereLight args={["#ffe9cf", "#9b829f", 1.45]} />
			<directionalLight
				ref={keyLight}
				key={layoutKey}
				target={lightTarget}
				position={[
					island.center.x - shadowExtent * 0.95,
					highestPlatform / 2 + shadowExtent * 1.15,
					island.center.y + shadowExtent * 0.75,
				]}
				intensity={2.5}
				color="#ffe0a8"
				castShadow
				shadow-mapSize={[4096, 4096]}
				shadow-camera-left={-shadowExtent}
				shadow-camera-right={shadowExtent}
				shadow-camera-top={shadowExtent}
				shadow-camera-bottom={-shadowExtent}
				shadow-camera-near={0.5}
				shadow-camera-far={shadowExtent * 4}
				shadow-bias={-0.00015}
				shadow-normalBias={0.04}
				shadow-intensity={0.42}
				shadow-autoUpdate={false}
				shadow-needsUpdate
			/>
			<directionalLight
				target={lightTarget}
				position={[
					island.center.x + shadowExtent,
					highestPlatform + shadowExtent * 0.6,
					island.center.y - shadowExtent,
				]}
				intensity={0.7}
				color="#e1c5e7"
			/>
			<Sky island={island} />
			<Landscape key={`${view}:${dark}:${layoutKey}`} layout={layout} routes={routes} dark={dark} />
			<CameraRig {...props} />
			{layout.districts.map((district) => {
				// Every platform has a real underside meeting the common ground plane.
				// Cascade's depth remains encoded by the top surface of each terrace.
				const top = district.position[1] + 0.16
				const height = top - GROUND_Y
				return (
					<group key={district.id}>
						<MachineBox
							position={[district.position[0], GROUND_Y + height / 2, district.position[2]]}
							size={[district.width, height - 0.04, district.depth]}
							color={materials.platform}
						/>
						<MachineBox
							position={[district.position[0], top - 0.06, district.position[2]]}
							size={[district.width + 0.04, 0.12, district.depth + 0.04]}
							color={materials.turf}
						/>
					</group>
				)
			})}
			{links.map((link) => {
				const active = link.edge.source === selectedId || link.edge.target === selectedId
				return (
					<FactoryTransport
						key={JSON.stringify([
							view,
							link.id,
							link.geometryKey,
							link.edge.callsPerSecond,
							link.edge.avgLatencyMs,
						])}
						link={link}
						active={active}
						dimmed={Boolean(link.edge.dimmed) || (selectedId !== null && !active)}
						dark={dark}
						running={
							flowing &&
							!link.edge.dimmed &&
							link.edge.callsPerSecond > 0 &&
							(selectedId === null || active)
						}
					/>
				)
			})}
			{topology.nodes.map((node) => {
				const position = layout.positions.get(node.id)
				return (
					position && (
						<FactoryMachine
							key={`${view}:${node.id}`}
							node={node}
							position={position}
							view={view}
							dimmed={Boolean(node.dimmed) || (related !== null && !related.has(node.id))}
							selected={node.id === selectedId}
							dark={dark}
							running={flowing}
							onSelect={onSelect}
						/>
					)
				)
			})}
		</>
	)
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false }
	static getDerivedStateFromError() {
		return { failed: true }
	}
	render() {
		return this.state.failed ? (
			<div className="absolute inset-0 grid place-content-center gap-2 p-8 text-center text-sm">
				<p>3D rendering is unavailable.</p>
				<p className="text-muted-foreground">
					Use the service list to inspect connections, or reload to retry.
				</p>
			</div>
		) : (
			this.props.children
		)
	}
}

export function ServiceMap3D(props: SceneProps) {
	return (
		<SceneBoundary>
			<Canvas
				orthographic
				shadows="soft"
				dpr={[1, 2]}
				frameloop={props.flowing ? "always" : "demand"}
				gl={{
					antialias: true,
					alpha: true,
					toneMapping: THREE.ACESFilmicToneMapping,
					toneMappingExposure: 1.05,
				}}
				onPointerMissed={() => props.onSelect(null)}
				style={{ position: "absolute", inset: 0 }}
			>
				<MapScene {...props} />
			</Canvas>
		</SceneBoundary>
	)
}

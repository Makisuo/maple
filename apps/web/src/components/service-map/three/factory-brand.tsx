import { useMemo } from "react"
import * as THREE from "three"
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js"
import { useMountEffect } from "@/hooks/use-mount-effect"
import type { Vec3 } from "./types"
import { MachineBox } from "./factory-primitives"
import type { MachineBadge } from "./factory-badge"

/** Shared SVG artwork, including its knockouts, pressed into enamel. */
function BadgeMark({ path, size, color }: { path: string; size: number; color: string }) {
	const geometry = useMemo(() => {
		const svg = new SVGLoader().parse(
			`<svg xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="${path}" /></svg>`,
		)
		const mark = new THREE.ShapeGeometry(
			svg.paths.flatMap((path) => SVGLoader.createShapes(path)),
			8,
		)
		mark.computeBoundingBox()
		const bounds = mark.boundingBox
		if (!bounds) return mark
		const center = bounds.getCenter(new THREE.Vector3())
		const dimensions = bounds.getSize(new THREE.Vector3())
		const scale = size / Math.max(dimensions.x, dimensions.y)
		mark.translate(-center.x, -center.y, 0)
		mark.scale(scale, -scale, 1)
		return mark
	}, [path, size])
	useMountEffect(() => () => geometry.dispose())
	return (
		<mesh geometry={geometry} position={[0, 0, 0.058]}>
			<meshStandardMaterial color={color} roughness={0.9} side={THREE.DoubleSide} />
		</mesh>
	)
}

function BadgeWordmark({ text, color }: { text: string; color: string }) {
	const canvas = useMemo(() => {
		const canvas = document.createElement("canvas")
		canvas.width = canvas.height = 256
		const context = canvas.getContext("2d")
		if (!context) return null
		context.fillStyle = "white"
		context.font = "bold 80px sans-serif"
		context.textAlign = "center"
		context.textBaseline = "middle"
		context.fillText(text, 128, 128, 224)
		return canvas
	}, [text])
	if (!canvas) return null
	return (
		<mesh position={[0, 0, 0.058]}>
			<planeGeometry args={[0.7, 0.7]} />
			<meshStandardMaterial color={color} transparent roughness={0.9}>
				<canvasTexture attach="map" args={[canvas]} colorSpace={THREE.SRGBColorSpace} />
			</meshStandardMaterial>
		</mesh>
	)
}

export function FactoryBadge({
	position,
	rotation,
	scale = 1,
	muted,
	badge,
}: {
	position: Vec3
	rotation: Vec3
	scale?: number
	muted: boolean
	badge: MachineBadge
}) {
	const color = muted ? "#777560" : "#293b39"
	return (
		<group position={[...position]} rotation={[...rotation]} scale={scale}>
			<MachineBox size={[0.86, 0.86, 0.07]} color={muted ? "#81816b" : "#667569"} />
			<MachineBox
				size={[0.78, 0.78, 0.025]}
				position={[0, 0, 0.04]}
				color={muted ? "#aaa78b" : "#f2e9d3"}
			/>
			{badge.wordmark ? (
				<BadgeWordmark key={badge.wordmark} text={badge.wordmark} color={color} />
			) : badge.path ? (
				<BadgeMark key={badge.path} path={badge.path} size={0.6} color={color} />
			) : null}
		</group>
	)
}

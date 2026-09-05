import { useMemo, type ReactNode } from "react"
import * as THREE from "three"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { GROUND_Y, MAP_MATERIALS } from "./appearance"
import type { FactoryLink } from "./factory-routing"
import type { Vec3 } from "./types"
import type { SpatialLayout } from "./spatial-layout"
import { EARTH_DEPTH, insideIsland, islandFootprint, islandGeometry, type IslandFootprint } from "./terrain"

interface PlantPart {
	matrix: THREE.Matrix4
	color: THREE.Color
}

function part(position: Vec3, scale: Vec3, color: string, rotation: Vec3 = [0, 0, 0]): PlantPart {
	return {
		matrix: new THREE.Matrix4().compose(
			new THREE.Vector3(...position),
			new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
			new THREE.Vector3(...scale),
		),
		color: new THREE.Color(color),
	}
}

/** Seeded placement stays put during selection, orbit, and theme changes. */
function meadow(layout: SpatialLayout, links: FactoryLink[], dark: boolean) {
	let seed = 427
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
		return seed / 4294967296
	}
	const materials = MAP_MATERIALS[dark ? "dark" : "light"]
	const trunks: PlantPart[] = [],
		crowns: PlantPart[] = [],
		grass: PlantPart[] = []
	const stems: PlantPart[] = [],
		blossoms: PlantPart[] = [],
		leaves: PlantPart[] = []
	const districts = layout.districts
	const nodes = [...layout.positions.values()]
	const island = islandFootprint(layout)
	const { minX, maxX, minZ, maxZ } = island
	const inDistrict = (x: number, z: number, margin = 0) =>
		districts.find(
			(d) =>
				Math.abs(x - d.position[0]) < d.width / 2 + margin &&
				Math.abs(z - d.position[2]) < d.depth / 2 + margin,
		)
	const surface = (x: number, z: number) => {
		const district = inDistrict(x, z)
		return district ? district.position[1] + 0.16 : GROUND_Y
	}
	const clearOfMachines = (x: number, z: number, margin: number) =>
		!nodes.some((p) => Math.abs(x - p[0]) < 1.45 + margin && Math.abs(z - p[2]) < 1.25 + margin)
	const routes = links.flatMap((link) => link.curve.getSpacedPoints(36))
	const trees: { x: number; z: number; scale: number; color: string }[] = []
	// Small groves in the free space around plots. Their crowns never intersect
	// machinery or a transport route; the graph keeps the center of the scene.
	for (let attempt = 0; attempt < 700 && trees.length < 14; attempt++) {
		const x = minX + random() * (maxX - minX)
		const z = minZ + random() * (maxZ - minZ)
		if (
			!insideIsland(island, x, z, 1.65) ||
			inDistrict(x, z, 1.25) ||
			routes.some((p) => Math.hypot(p.x - x, p.z - z) < 1.65)
		)
			continue
		if (trees.some((tree) => Math.hypot(tree.x - x, tree.z - z) < 3.4)) continue
		const scale = 0.68 + random() * 0.35
		const color = ["#5ba77e", "#91b25b", "#c89139"][trees.length % 3] ?? "#c89139"
		trees.push({ x, z, scale, color })
		trunks.push(part([x, GROUND_Y + 0.85 * scale, z], [scale, 1.7 * scale, scale], "#716045"))
		for (const side of [-1, 1])
			trunks.push(
				part(
					[x + side * 0.25 * scale, GROUND_Y + 1.35 * scale, z],
					[0.55 * scale, 0.95 * scale, 0.55 * scale],
					"#716045",
					[0, 0, side * -0.65],
				),
			)
		for (const [dx, dy, dz, sx, sy, sz] of [
			[0, 2.23, 0, 0.85, 0.97, 0.82],
			[-0.59, 1.94, 0.06, 0.73, 0.7, 0.73],
			[0.59, 1.97, 0.04, 0.74, 0.74, 0.72],
			[0.04, 1.88, -0.55, 0.64, 0.71, 0.61],
		] as const)
			crowns.push(
				part(
					[x + dx * scale, GROUND_Y + dy * scale, z + dz * scale],
					[sx * scale, sy * scale, sz * scale],
					color,
					[0, random() * Math.PI, 0],
				),
			)
		// A few fallen palmate leaves tie the canopy to the meadow below it.
		for (let i = 0; i < 10; i++) {
			const angle = random() * Math.PI * 2,
				radius = 0.35 + random() * 1.15
			const lx = x + Math.cos(angle) * radius,
				lz = z + Math.sin(angle) * radius
			leaves.push(part([lx, GROUND_Y + 0.018, lz], [0.1, 0.1, 0.1], color, [-Math.PI / 2, 0, angle]))
		}
		// Broad leaf sprays break up the silhouette like painted foliage.
		for (let i = 0; i < 46; i++) {
			const angle = random() * Math.PI * 2
			const radius = (0.45 + random() * 0.65) * scale
			const size = (0.16 + random() * 0.13) * scale
			leaves.push(
				part(
					[
						x + Math.cos(angle) * radius,
						GROUND_Y + (1.94 + random() * 0.7) * scale,
						z + Math.sin(angle) * radius * 0.8,
					],
					[size, size, size],
					color,
					[-0.75 - random() * 0.75, random() * 0.5, angle],
				),
			)
		}
	}
	// Grass grows on terrace tops as well as the common ground. It leaves a
	// service apron around every machine and is batched into a single draw.
	for (let i = 0; i < 4800; i++) {
		const x = minX + random() * (maxX - minX),
			z = minZ + random() * (maxZ - minZ)
		if (!insideIsland(island, x, z, 0.18) || !clearOfMachines(x, z, 0.18)) continue
		const patch =
			Math.sin(x * 0.37 + Math.cos(z * 0.51) * 2) * Math.cos(z * 0.43 + Math.sin(x * 0.69)) * 1.6
		if (patch < -0.6) continue
		const scale = (0.7 + random() * 0.55) * (inDistrict(x, z) ? 0.7 : 1)
		grass.push(
			part(
				[x, surface(x, z) + 0.008, z],
				[scale, scale, scale],
				patch > 0.8 ? "#a2cb5d" : patch < 0 ? "#559f78" : materials.grass,
				[0, random() * Math.PI, 0],
			),
		)
	}
	const patches = [
		...trees.map((tree) => [tree.x + 1, tree.z + 0.7] as const),
		...districts.map(
			(d) => [d.position[0] - d.width / 2 + 0.45, d.position[2] + d.depth / 2 - 0.5] as const,
		),
	]
	for (const [px, pz] of patches) {
		for (let i = 0; i < 8; i++) {
			const x = px + (random() - 0.5) * 1.25,
				z = pz + (random() - 0.5) * 1.25
			if (!insideIsland(island, x, z, 0.3) || !clearOfMachines(x, z, 0.3)) continue
			const y = surface(x, z),
				height = 0.35 + random() * 0.27
			stems.push(part([x, y + height / 2, z], [1, height, 1], "#607a40"))
			const flower = i % 4 === 0 ? "#d6b26a" : "#efe2bd"
			for (let petal = 0; petal < 5; petal++) {
				const angle = (petal * Math.PI * 2) / 5
				blossoms.push(
					part(
						[x + Math.cos(angle) * 0.11, y + height, z + Math.sin(angle) * 0.11],
						[0.105, 0.032, 0.075],
						flower,
						[0, -angle, 0],
					),
				)
			}
			blossoms.push(part([x, y + height + 0.025, z], [0.042, 0.028, 0.042], "#c79032"))
		}
	}
	return { trunks, crowns, grass, stems, blossoms, leaves }
}

/** Embedded chunks overlap the closed terrain shell; every exposed face has depth. */
function soilBorder(island: IslandFootprint, dark: boolean) {
	let seed = 913
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
		return seed / 4294967296
	}
	const blocks: PlantPart[] = [],
		rocks: PlantPart[] = []
	const soil = dark
		? (["#704023", "#9a5c2e", "#814925"] as const)
		: (["#854b28", "#ad6935", "#95552b"] as const)
	const stone = ["#7c775e", "#989074", "#877b60"] as const
	for (let i = 0; i < island.outline.length; i++) {
		const p = island.outline[i],
			next = island.outline[(i + 1) % island.outline.length]
		if (!p || !next) continue
		const tangent = next.clone().sub(p).normalize()
		const normal = new THREE.Vector2(tangent.y, -tangent.x)
		const center = p.clone().lerp(next, 0.5)
		const angle = Math.atan2(normal.x, normal.y)
		const width = p.distanceTo(next)
		const at = (along: number, depth: number, outward: number): Vec3 => [
			center.x + tangent.x * along + normal.x * outward,
			GROUND_Y - depth,
			center.y + tangent.y * along + normal.y * outward,
		]
		// Recess the sod cap slightly below the meadow. Coplanar cap and terrain
		// faces otherwise fight for depth along the rim as the camera moves.
		const lipHeight = 0.24 + random() * 0.36
		blocks.push(
			part(
				at(0, lipHeight / 2 + 0.025, -0.05),
				[width * (0.55 + random() * 0.35), lipHeight, 0.45 + random() * 0.3],
				i % 3 === 0 ? "#3c7126" : "#4e892c",
				[0, angle, 0],
			),
		)
		// Broad clay clods and deeper ledges cast small shadows onto the cut face.
		for (const layer of [0, 1]) {
			if (random() < 0.24) continue
			const height = 0.45 + random() * 0.65
			const depth = layer === 0 ? 0.85 + random() * 0.35 : EARTH_DEPTH - 0.7 - random() * 0.3
			blocks.push(
				part(
					at((random() - 0.5) * width * 0.25, depth, -0.04),
					[width * (0.55 + random() * 0.4), height, 0.5 + random() * 0.65],
					soil[(i + layer) % soil.length] ?? soil[0],
					[0, angle, (random() - 0.5) * 0.08],
				),
			)
		}
		// Small, occasional mineral chips keep the cut face from reading as a rock wall.
		if (random() < 0.32) {
			const depth = 0.75 + random() * 2
			rocks.push(
				part(
					at((random() - 0.5) * width * 0.75, depth, 0.035),
					[0.3 + random() * 0.38, 0.2 + random() * 0.25, 0.26 + random() * 0.24],
					stone[i % stone.length] ?? stone[0],
					[random() * 0.3, angle, (random() - 0.5) * 0.5],
				),
			)
		}
		if (random() < 0.22) {
			// Angular, branching roots sit against the soil rather than floating off it.
			const bend = (random() - 0.5) * 0.6
			const points = [
				at(0, 0.3, 0.29),
				at(bend, 0.85, 0.34),
				at(bend - 0.18, 1.5, 0.24),
				at(bend + 0.12, 1.85, 0.2),
			]
			const root = (a: Vec3, b: Vec3, thickness: number) => {
				const start = new THREE.Vector3(...a),
					end = new THREE.Vector3(...b)
				const direction = end.clone().sub(start)
				blocks.push({
					matrix: new THREE.Matrix4().compose(
						start.add(end).multiplyScalar(0.5),
						new THREE.Quaternion().setFromUnitVectors(
							new THREE.Vector3(0, 1, 0),
							direction.clone().normalize(),
						),
						new THREE.Vector3(thickness, direction.length(), thickness),
					),
					color: new THREE.Color("#b88342"),
				})
			}
			for (let j = 0; j < points.length - 1; j++) {
				const a = points[j],
					b = points[j + 1]
				if (a && b) root(a, b, 0.09 - j * 0.018)
			}
			const fork = points[1]
			if (fork) root(fork, at(bend + 0.45, 1.3, 0.26), 0.055)
		}
	}
	return { blocks, rocks }
}

function PlantInstances({
	parts,
	children,
	shadow = false,
	vertexColors = false,
	side = THREE.DoubleSide,
}: {
	parts: PlantPart[]
	children: ReactNode
	shadow?: boolean
	vertexColors?: boolean
	side?: THREE.Side
}) {
	return (
		<instancedMesh
			args={[undefined, undefined, parts.length]}
			castShadow={shadow}
			receiveShadow
			ref={(mesh) => {
				if (!mesh) return
				parts.forEach((item, i) => {
					mesh.setMatrixAt(i, item.matrix)
					mesh.setColorAt(i, item.color)
				})
				mesh.instanceMatrix.needsUpdate = true
				if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
				mesh.computeBoundingSphere()
			}}
		>
			{children}
			<meshLambertMaterial vertexColors={vertexColors} side={side} />
		</instancedMesh>
	)
}

function grassGeometry() {
	const vertices: number[] = [],
		colors: number[] = [],
		indices: number[] = []
	// Broad, simple blade silhouettes echo the reference's painted grass clumps.
	for (let blade = 0; blade < 4; blade++) {
		const angle = blade * 2.1,
			height = 0.66 + (blade % 3) * 0.15
		const dx = Math.cos(angle),
			dz = Math.sin(angle),
			width = 0.15 + (blade % 2) * 0.025
		const start = vertices.length / 3
		for (const t of [0, 0.62]) {
			const lean = t * t * 0.36,
				halfWidth = width * (1 - t * 0.42)
			for (const side of [-1, 1]) {
				vertices.push(
					dx * lean - dz * halfWidth * side,
					height * t,
					dz * lean + dx * halfWidth * side,
				)
				colors.push(0.75 + t * 0.25, 0.83 + t * 0.17, 0.68 + t * 0.2)
			}
		}
		vertices.push(dx * 0.45, height, dz * 0.45)
		colors.push(1, 1, 0.87)
		// Give both faces upward normals. DoubleSide would invert the painted
		// lighting on back faces, creating dark shards as the camera orbits.
		for (const [a, b, c] of [
			[0, 1, 2],
			[1, 3, 2],
			[2, 3, 4],
		] as const)
			indices.push(start + a, start + b, start + c, start + c, start + b, start + a)
	}
	const geometry = new THREE.BufferGeometry()
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3))
	geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
	geometry.setIndex(indices)
	// Upward normals give each clump the meadow's soft, even cartoon lighting.
	geometry.setAttribute(
		"normal",
		new THREE.Float32BufferAttribute(
			Array.from({ length: vertices.length }, (_, i) => (i % 3 === 1 ? 1 : 0)),
			3,
		),
	)
	return geometry
}

function leafGeometry() {
	const leaf = new THREE.Shape()
	const outline = [
		[0, -0.7],
		[-0.12, -0.26],
		[-0.65, -0.34],
		[-0.48, -0.1],
		[-1, 0.25],
		[-0.65, 0.32],
		[-0.76, 0.68],
		[-0.34, 0.46],
		[-0.4, 1],
		[-0.2, 0.74],
		[0, 1.4],
		[0.2, 0.74],
		[0.4, 1],
		[0.34, 0.46],
		[0.76, 0.68],
		[0.65, 0.32],
		[1, 0.25],
		[0.48, -0.1],
		[0.65, -0.34],
		[0.12, -0.26],
	] as const
	outline.forEach(([x, y], i) => (i === 0 ? leaf.moveTo(x, y) : leaf.lineTo(x, y)))
	leaf.closePath()
	return new THREE.ShapeGeometry(leaf)
}

function canopyGeometry() {
	const geometry = new THREE.SphereGeometry(1, 14, 10)
	const positions = geometry.getAttribute("position")
	const colors: number[] = []
	for (let i = 0; i < positions.count; i++) {
		const x = positions.getX(i),
			y = positions.getY(i),
			z = positions.getZ(i)
		const contour = 1 + 0.045 * Math.sin(x * 9 + z * 5) * Math.cos(y * 8)
		positions.setXYZ(i, x * contour, y * contour, z * contour)
		const tone = 0.68 + 0.32 * (y * 0.5 + 0.5)
		colors.push(tone, tone, tone * 0.94)
	}
	geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
	geometry.computeVertexNormals()
	return geometry
}

export function Landscape({
	layout,
	links,
	dark,
}: {
	layout: SpatialLayout
	links: FactoryLink[]
	dark: boolean
}) {
	const plants = useMemo(() => meadow(layout, links, dark), [layout, links, dark])
	const border = useMemo(() => soilBorder(islandFootprint(layout), dark), [layout, dark])
	const turf = useMemo(grassGeometry, [])
	const leaf = useMemo(leafGeometry, [])
	const canopy = useMemo(canopyGeometry, [])
	const terrain = useMemo(() => islandGeometry(islandFootprint(layout), dark), [layout, dark])
	useMountEffect(() => () => {
		turf.dispose()
		leaf.dispose()
		canopy.dispose()
		terrain.top.dispose()
		terrain.earth.dispose()
	})
	return (
		<group>
			<mesh geometry={terrain.top} receiveShadow>
				<meshLambertMaterial vertexColors />
			</mesh>
			<mesh geometry={terrain.earth} castShadow receiveShadow>
				<meshLambertMaterial vertexColors />
			</mesh>
			<PlantInstances parts={plants.grass} vertexColors side={THREE.FrontSide}>
				<primitive object={turf} attach="geometry" />
			</PlantInstances>
			<PlantInstances parts={border.blocks} shadow>
				<boxGeometry args={[1, 1, 1]} />
			</PlantInstances>
			<PlantInstances parts={border.rocks} shadow>
				<dodecahedronGeometry args={[0.65, 0]} />
			</PlantInstances>
			<PlantInstances parts={plants.trunks} shadow>
				<cylinderGeometry args={[0.085, 0.14, 1, 7]} />
			</PlantInstances>
			<PlantInstances parts={plants.crowns} shadow vertexColors>
				<primitive object={canopy} attach="geometry" />
			</PlantInstances>
			<PlantInstances parts={plants.stems}>
				<cylinderGeometry args={[0.014, 0.02, 1, 5]} />
			</PlantInstances>
			<PlantInstances parts={plants.blossoms}>
				<sphereGeometry args={[1, 6, 4]} />
			</PlantInstances>
			<PlantInstances parts={plants.leaves}>
				<primitive object={leaf} attach="geometry" />
			</PlantInstances>
		</group>
	)
}

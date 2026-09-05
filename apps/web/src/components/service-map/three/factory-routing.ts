import * as THREE from "three"
import type { Edge3D, Topology3D } from "./types"
import type { SpatialLayout } from "./spatial-layout"

export interface FactoryRoute {
	id: string
	source: string
	target: string
	geometryKey: string
	kind: "pipe" | "conveyor"
	curve: THREE.CurvePath<THREE.Vector3>
	signPosition: THREE.Vector3
}

export interface FactoryLink extends FactoryRoute {
	edge: Edge3D
	radius: number
	prominent: boolean
}

export interface RoutingTopology {
	nodes: ReadonlyArray<Pick<Topology3D["nodes"][number], "id" | "kind">>
	edges: ReadonlyArray<Pick<Edge3D, "source" | "target">>
}

/** Round a Manhattan route into actual elbows, without the overshoot of a
 * free spline. All distances are physical scene units. */
export function roundedRoute(points: THREE.Vector3[], radius = 0.65) {
	const path = new THREE.CurvePath<THREE.Vector3>()
	const first = points[0],
		last = points.at(-1)
	if (!first || !last) return path
	let previous = first
	for (const [i, corner] of points.entries()) {
		const next = points[i + 1]
		if (i === 0 || !next) continue
		const cut = Math.min(radius, corner.distanceTo(previous) * 0.45, corner.distanceTo(next) * 0.45)
		const enter = corner.clone().lerp(previous, cut / Math.max(corner.distanceTo(previous), 0.001))
		const leave = corner.clone().lerp(next, cut / Math.max(corner.distanceTo(next), 0.001))
		if (previous.distanceTo(enter) > 0.001) path.add(new THREE.LineCurve3(previous, enter))
		path.add(new THREE.QuadraticBezierCurve3(enter, corner, leave))
		previous = leave
	}
	path.add(new THREE.LineCurve3(previous, last))
	return path
}

export class CurveSection extends THREE.Curve<THREE.Vector3> {
	constructor(
		readonly curve: THREE.Curve<THREE.Vector3>,
		readonly start: number,
		readonly end: number,
	) {
		super()
	}
	getPoint(t: number, target = new THREE.Vector3()) {
		return this.curve.getPointAt(this.start + (this.end - this.start) * t, target)
	}
}

export function factoryRoutes(topology: RoutingTopology, layout: SpatialLayout): FactoryRoute[] {
	const nodes = new Map(topology.nodes.map((node) => [node.id, node]))
	return topology.edges
		.toSorted((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
		.flatMap((edge, index) => {
			const source = layout.positions.get(edge.source),
				target = layout.positions.get(edge.target)
			if (!source || !target) return []
			const kind =
				nodes.get(edge.source)?.kind === "queue" || nodes.get(edge.target)?.kind === "queue"
					? "conveyor"
					: "pipe"
			const a = new THREE.Vector3(...source),
				b = new THREE.Vector3(...target)
			const alongX = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z)
			const direction = Math.sign(alongX ? b.x - a.x : b.z - a.z) || 1
			const side = alongX ? "x" : "z"
			a[side] += direction * 1.3
			b[side] -= direction * 1.3
			a.y += 0.72
			b.y += 0.72
			const lead = a.clone()
			lead[side] += direction * 0.6
			const tail = b.clone()
			tail[side] -= direction * 0.6
			const high = Math.max(a.y, b.y) + (kind === "pipe" ? 0.75 + (index % 3) * 0.22 : 0)
			const entry = lead.clone().setY(high),
				exit = tail.clone().setY(high)
			const middle = entry.clone()
			middle[side] = (entry[side] + exit[side]) / 2
			const turn = exit.clone()
			turn[side] = middle[side]
			const waypoints =
				kind === "conveyor"
					? [a, lead, middle, turn, tail, b]
					: [a, lead, entry, middle, turn, exit, tail, b]
			const clean = waypoints.filter((point, i) => {
				const previous = waypoints[i - 1]
				return !previous || point.distanceTo(previous) > 0.01
			})
			const curve = roundedRoute(clean, kind === "conveyor" ? 1.1 : 0.5)
			return [
				{
					id: `link:${JSON.stringify([edge.source, edge.target])}`,
					source: edge.source,
					target: edge.target,
					geometryKey: JSON.stringify(clean.map((point) => point.toArray())),
					kind,
					curve,
					signPosition: curve.getPointAt(0.5).add(new THREE.Vector3(0, 0.9, 0)),
				},
			]
		})
}

/** Metrics update independently of route geometry and its GPU resources. */
export function decorateRoutes(routes: FactoryRoute[], edges: ReadonlyArray<Edge3D>): FactoryLink[] {
	const byId = new Map(edges.map((edge) => [JSON.stringify([edge.source, edge.target]), edge]))
	const peak = Math.max(1, ...edges.map((edge) => edge.callsPerSecond))
	return routes.flatMap((route) => {
		const edge = byId.get(JSON.stringify([route.source, route.target]))
		if (!edge) return []
		return [
			{
				...route,
				edge,
				radius: 0.105 + Math.sqrt(edge.callsPerSecond / peak) * 0.085,
				prominent:
					!edge.relation &&
					(route.kind === "conveyor" ||
						edge.callsPerSecond >= peak * 0.15 ||
						edge.errorRate >= 0.015),
			},
		]
	})
}

export function factoryLinks(topology: Topology3D, layout: SpatialLayout): FactoryLink[] {
	return decorateRoutes(factoryRoutes(topology, layout), topology.edges)
}

/** A ribbon follows the belt's horizontal normal, remaining upright on ramps. */
export function beltGeometry(curve: THREE.Curve<THREE.Vector3>, width: number, offset = 0) {
	const vertices: number[] = [],
		indices: number[] = []
	for (let i = 0; i <= 80; i++) {
		const t = i / 80,
			point = curve.getPointAt(t),
			tangent = curve.getTangentAt(t)
		const side = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize()
		for (const direction of [-1, 1]) {
			const vertex = point.clone().addScaledVector(side, (direction * width) / 2 + offset)
			vertices.push(vertex.x, vertex.y, vertex.z)
		}
		if (i < 80) {
			const n = i * 2
			indices.push(n, n + 2, n + 1, n + 1, n + 2, n + 3)
		}
	}
	const geometry = new THREE.BufferGeometry()
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3))
	geometry.setIndex(indices)
	geometry.computeVertexNormals()
	return geometry
}

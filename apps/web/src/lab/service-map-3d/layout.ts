import type { Edge3D, Node3D, Topology3D } from "./fixture"

/**
 * Pure layout math for the 3D map — no `three` import, so it unit-tests in
 * jsdom without a WebGL context. The scene consumes plain `[x, y, z]` tuples
 * and builds its own curve objects from {@link bezierControl}.
 */

export type Vec3 = readonly [number, number, number]

export type Layout3DMode = "floors" | "rings"

export interface Layout3D {
	positions: ReadonlyMap<string, Vec3>
	tiers: ReadonlyMap<string, number>
	/** Namespace → the angle (radians) its column sits at, for floor labels. */
	namespaceAngles: ReadonlyMap<string, number>
	tierCount: number
	radius: number
	/** Centre of the laid-out graph, and the radius of the sphere enclosing it. */
	center: Vec3
	extent: number
}

const FLOOR_GAP = 7
const FLOOR_RADIUS = 13
const CLUSTER_SPACING = 4.4
const RING_INNER = 7
const RING_GAP = 6.5

/**
 * Longest-path depth from every entry node (in-degree 0), which is what makes
 * a request read top-to-bottom. Cycles can't extend a node past `nodes.length`,
 * so the relaxation loop is bounded rather than trusting the graph to be a DAG.
 */
export function computeTiers(nodes: ReadonlyArray<Node3D>, edges: ReadonlyArray<Edge3D>): Map<string, number> {
	const ids = new Set(nodes.map((node) => node.id))
	const real = edges.filter((e) => ids.has(e.source) && ids.has(e.target))
	const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0]))
	for (const e of real) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1)

	const tiers = new Map<string, number>(nodes.map((node) => [node.id, 0]))
	const roots = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id)
	// Every node starts at 0; roots stay there and the rest get pushed down.
	let frontier = roots.length > 0 ? roots : [nodes[0]?.id].filter((id): id is string => id !== undefined)

	for (let pass = 0; pass < nodes.length && frontier.length > 0; pass++) {
		const next: string[] = []
		for (const id of frontier) {
			const depth = tiers.get(id) ?? 0
			for (const e of real) {
				if (e.source !== id) continue
				if ((tiers.get(e.target) ?? 0) >= depth + 1) continue
				tiers.set(e.target, depth + 1)
				next.push(e.target)
			}
		}
		frontier = next
	}

	return tiers
}

const namespaceOrder = (nodes: ReadonlyArray<Node3D>, tiers: ReadonlyMap<string, number>): string[] => {
	const minTier = new Map<string, number>()
	for (const node of nodes) {
		const tier = tiers.get(node.id) ?? 0
		const current = minTier.get(node.namespace)
		if (current === undefined || tier < current) minTier.set(node.namespace, tier)
	}
	return [...minTier.keys()].sort((a, b) => (minTier.get(a) ?? 0) - (minTier.get(b) ?? 0) || a.localeCompare(b))
}

/**
 * `floors`: one storey per tier, each namespace pinned to the same compass
 * bearing on every storey — so a namespace's services stack into a column and
 * the calls between them read as vertical plumbing.
 *
 * `rings`: concentric rings, tier → radius, a shallow cone. Reads better for
 * fan-out breadth, worse for depth.
 */
export function layoutGraph(topology: Topology3D, mode: Layout3DMode): Layout3D {
	const { nodes, edges } = topology
	const tiers = computeTiers(nodes, edges)
	const tierCount = nodes.reduce((max, node) => Math.max(max, tiers.get(node.id) ?? 0), 0) + 1

	const namespaces = namespaceOrder(nodes, tiers)
	const namespaceAngles = new Map<string, number>(
		namespaces.map((ns, index) => [ns, (index / Math.max(1, namespaces.length)) * Math.PI * 2]),
	)

	const positions = new Map<string, Vec3>()

	if (mode === "floors") {
		const groups = new Map<string, Node3D[]>()
		for (const node of nodes) {
			const key = `${tiers.get(node.id) ?? 0}::${node.namespace}`
			const group = groups.get(key)
			if (group) group.push(node)
			else groups.set(key, [node])
		}
		for (const [key, group] of groups) {
			const tier = Number(key.split("::")[0])
			const angle = namespaceAngles.get(group[0]!.namespace) ?? 0
			const cx = Math.cos(angle) * FLOOR_RADIUS
			const cz = Math.sin(angle) * FLOOR_RADIUS
			// Spread the cluster along the tangent so it faces the centre.
			const tx = -Math.sin(angle)
			const tz = Math.cos(angle)
			const span = (group.length - 1) / 2
			group.forEach((node, index) => {
				const offset = (index - span) * CLUSTER_SPACING
				positions.set(node.id, [cx + tx * offset, -tier * FLOOR_GAP, cz + tz * offset])
			})
		}
	} else {
		const byTier = new Map<number, Node3D[]>()
		for (const node of nodes) {
			const tier = tiers.get(node.id) ?? 0
			const list = byTier.get(tier)
			if (list) list.push(node)
			else byTier.set(tier, [node])
		}
		for (const [tier, list] of byTier) {
			const sorted = [...list].sort(
				(a, b) => a.namespace.localeCompare(b.namespace) || a.label.localeCompare(b.label),
			)
			const radius = RING_INNER + tier * RING_GAP
			sorted.forEach((node, index) => {
				const angle = (index / sorted.length) * Math.PI * 2 + tier * 0.35
				positions.set(node.id, [
					Math.cos(angle) * radius,
					-tier * 2.4 + (index % 2 === 0 ? 0.9 : -0.9),
					Math.sin(angle) * radius,
				])
			})
		}
	}

	return {
		positions,
		tiers,
		namespaceAngles,
		tierCount,
		radius: mode === "floors" ? FLOOR_RADIUS : RING_INNER + (tierCount - 1) * RING_GAP,
		...bounds(positions),
	}
}

/** Bounding sphere of the laid-out nodes — what the camera rig frames on. */
function bounds(positions: ReadonlyMap<string, Vec3>): { center: Vec3; extent: number } {
	const list = [...positions.values()]
	if (list.length === 0) return { center: [0, 0, 0], extent: 1 }
	const min: [number, number, number] = [Infinity, Infinity, Infinity]
	const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
	for (const position of list) {
		for (let axis = 0; axis < 3; axis++) {
			min[axis] = Math.min(min[axis]!, position[axis]!)
			max[axis] = Math.max(max[axis]!, position[axis]!)
		}
	}
	const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
	const extent = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2)
	return { center, extent }
}

/**
 * Control point for the pipe between two nodes: bowed away from the world axis
 * and lifted, so parallel runs separate instead of z-fighting into one stripe.
 * `spread` fans sibling pipes out of a shared plane.
 */
export function bezierControl(from: Vec3, to: Vec3, spread = 0): Vec3 {
	const mid: Vec3 = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2]
	const dx = to[0] - from[0]
	const dy = to[1] - from[1]
	const dz = to[2] - from[2]
	const distance = Math.hypot(dx, dy, dz)
	const radial = Math.hypot(mid[0], mid[2]) || 1
	const bow = distance * 0.16 + 0.9
	const outward = 1 + spread * 0.35
	return [
		mid[0] + (mid[0] / radial) * bow * outward,
		mid[1] + Math.abs(dy) * 0.06 + bow * 0.35,
		mid[2] + (mid[2] / radial) * bow * outward,
	]
}

/** Quadratic Bézier sample — the same curve the scene's `TubeGeometry` follows. */
export function sampleQuadratic(from: Vec3, control: Vec3, to: Vec3, t: number): Vec3 {
	const inv = 1 - t
	const a = inv * inv
	const b = 2 * inv * t
	const c = t * t
	return [
		a * from[0] + b * control[0] + c * to[0],
		a * from[1] + b * control[1] + c * to[1],
		a * from[2] + b * control[2] + c * to[2],
	]
}

/** Pipe radius from throughput — sqrt so a 100× busier edge is ~10× fatter, not 100×. */
export const pipeRadius = (callsPerSecond: number, peak: number): number =>
	0.055 + 0.34 * Math.sqrt(Math.min(1, callsPerSecond / Math.max(peak, 1)))

/** Node radius from throughput, on the same sqrt scale. */
export const nodeScale = (throughput: number, peak: number): number =>
	0.75 + 0.95 * Math.sqrt(Math.min(1, throughput / Math.max(peak, 1)))

export interface CameraFit {
	/** Point the camera should orbit around. */
	target: Vec3
	/** Distance from `target` along the view direction. */
	distance: number
}

/**
 * Closed-form camera fit: the smallest orbit distance that keeps every node
 * inside the frustum, plus the target that centres them.
 *
 * Done in the camera's own basis rather than by projecting through the camera:
 * at mount the canvas has not been measured yet, so `camera.aspect` and the
 * projection matrix are not yet trustworthy — but the DOM element's size is.
 * Bounding-sphere framing is not enough either, since a tilted view of a tall
 * storey stack projects taller than the sphere implies.
 */
export function fitCamera(
	points: ReadonlyArray<Vec3>,
	options: {
		direction: Vec3
		fovDegrees: number
		aspect: number
		/** Share of the frustum the graph should fill; 1 means touching the edges. */
		fill?: number
	},
): CameraFit {
	const { direction, fovDegrees, aspect, fill = 0.95 } = options
	if (points.length === 0) return { target: [0, 0, 0], distance: 10 }

	const dir = normalize(direction)
	// `dir` is never vertical for our view angles, so world-up is a safe reference.
	const right = normalize(cross([0, 1, 0], dir))
	const up = cross(dir, right)

	const axes = [right, up, dir] as const
	const min: [number, number, number] = [Infinity, Infinity, Infinity]
	const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
	for (const point of points) {
		for (let axis = 0; axis < 3; axis++) {
			const projected = dot(point, axes[axis]!)
			min[axis] = Math.min(min[axis]!, projected)
			max[axis] = Math.max(max[axis]!, projected)
		}
	}

	const mid = [0, 1, 2].map((axis) => (min[axis]! + max[axis]!) / 2)
	const target: Vec3 = [
		right[0] * mid[0]! + up[0] * mid[1]! + dir[0] * mid[2]!,
		right[1] * mid[0]! + up[1] * mid[1]! + dir[1] * mid[2]!,
		right[2] * mid[0]! + up[2] * mid[1]! + dir[2] * mid[2]!,
	]

	const tanVertical = Math.tan(((fovDegrees / 2) * Math.PI) / 180) * fill
	const tanHorizontal = tanVertical * Math.max(aspect, 0.2)

	// Solve per point rather than padding by half the depth range: a point at
	// lateral offset `a` and depth offset `c` needs `distance >= a / tan + c`,
	// and the binding point is usually a near one, not the deepest.
	let distance = 1
	for (const point of points) {
		const a = Math.abs(dot(point, right) - mid[0]!)
		const b = Math.abs(dot(point, up) - mid[1]!)
		const c = dot(point, dir) - mid[2]!
		distance = Math.max(distance, Math.max(a / tanHorizontal, b / tanVertical) + c)
	}

	return { target, distance: Math.max(distance, 1) }
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
]

const normalize = (v: Vec3): Vec3 => {
	const length = Math.hypot(v[0], v[1], v[2]) || 1
	return [v[0] / length, v[1] / length, v[2] / length]
}

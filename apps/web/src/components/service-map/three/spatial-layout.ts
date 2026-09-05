import type { Edge3D, Node3D } from "./types"
import { computeTiers } from "./graph"
import type { Vec3 } from "./types"

export interface SpatialTopology {
	nodes: ReadonlyArray<Pick<Node3D, "id" | "namespace">>
	edges: ReadonlyArray<Pick<Edge3D, "source" | "target">>
}

export type SpatialView = "atlas" | "cascade"
export interface District {
	id: string
	label: string
	position: Vec3
	width: number
	depth: number
}
export interface SpatialLayout {
	positions: ReadonlyMap<string, Vec3>
	districts: ReadonlyArray<District>
}

export function spatialLayout(topology: SpatialTopology, view: SpatialView): SpatialLayout {
	const positions = new Map<string, Vec3>()
	const districts: District[] = []
	if (view === "atlas") {
		const tiers = computeTiers(topology.nodes, topology.edges)
		const namespaces = [...new Set(topology.nodes.map((node) => node.namespace))]
		const groups = namespaces
			.map((namespace) => {
				const nodes = topology.nodes
					.filter((node) => node.namespace === namespace)
					.toSorted(
						(a, b) => (tiers.get(a.id) ?? 0) - (tiers.get(b.id) ?? 0) || a.id.localeCompare(b.id),
					)
				const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)))
				return {
					namespace,
					nodes,
					columns,
					width: columns * 4.2 + 0.7,
					depth: Math.ceil(nodes.length / columns) * 4.2 + 1.1,
					tier: Math.min(...nodes.map((node) => tiers.get(node.id) ?? 0)),
				}
			})
			.sort(
				(a, b) =>
					b.width * b.depth - a.width * a.depth ||
					a.tier - b.tier ||
					a.namespace.localeCompare(b.namespace),
			)
		const gap = 2.8
		// Balance namespace stacks across columns so a large team doesn't leave
		// an entire empty row beside the smaller database / service groups.
		const columns = Array.from({ length: Math.max(1, Math.ceil(Math.sqrt(groups.length))) }, () => ({
			groups: [] as typeof groups,
			width: 0,
			depth: 0,
		}))
		for (const group of groups) {
			const column = columns.toSorted((a, b) => a.depth - b.depth)[0]
			if (!column) continue
			column.groups.push(group)
			column.width = Math.max(column.width, group.width)
			column.depth += group.depth + gap
		}
		const totalDepth = Math.max(0, ...columns.map((column) => column.depth - gap))
		let x = 0
		for (const column of columns) {
			let z = (totalDepth - (column.depth - gap)) / 2
			for (const group of column.groups) {
				const cx = x + column.width / 2,
					cz = z + group.depth / 2
				group.nodes.forEach((node, index) =>
					positions.set(node.id, [
						cx + ((index % group.columns) - (group.columns - 1) / 2) * 4.2,
						0,
						cz +
							(Math.floor(index / group.columns) -
								(Math.ceil(group.nodes.length / group.columns) - 1) / 2) *
								4.2,
					]),
				)
				districts.push({
					id: group.namespace,
					label: group.namespace,
					position: [cx, -0.16, cz],
					width: group.width,
					depth: group.depth,
				})
				z += group.depth + gap
			}
			x += column.width + gap
		}
	} else {
		const tiers = computeTiers(topology.nodes, topology.edges)
		const count = Math.max(0, ...tiers.values()) + 1
		for (let tier = 0; tier < count; tier++) {
			const group = topology.nodes
				.filter((node) => tiers.get(node.id) === tier)
				.toSorted((a, b) => a.namespace.localeCompare(b.namespace) || a.id.localeCompare(b.id))
			if (!group.length) continue
			const x = (tier - (count - 1) / 2) * 5.2
			const y = (count - 1 - tier) * 0.75
			group.forEach((node, index) =>
				positions.set(node.id, [x, y, (index - (group.length - 1) / 2) * 4.3]),
			)
			districts.push({
				id: `tier-${tier}`,
				label: tier === 0 ? "entry" : `depth ${tier}`,
				position: [x, y - 0.16, 0],
				width: 4.3,
				depth: group.length * 4.3 + 0.7,
			})
		}
	}
	if (districts.length > 0) {
		const cx =
			(Math.min(...districts.map((d) => d.position[0] - d.width / 2)) +
				Math.max(...districts.map((d) => d.position[0] + d.width / 2))) /
			2
		const cz =
			(Math.min(...districts.map((d) => d.position[2] - d.depth / 2)) +
				Math.max(...districts.map((d) => d.position[2] + d.depth / 2))) /
			2
		for (const [id, position] of positions)
			positions.set(id, [position[0] - cx, position[1], position[2] - cz])
		for (const district of districts)
			district.position = [district.position[0] - cx, district.position[1], district.position[2] - cz]
	}
	return { positions, districts }
}

export const nodeHeight = (node: Node3D) => 0.5 + Math.log10(Math.max(1, node.throughput)) * 0.48
export const health = (rate: number) => (rate > 0.05 ? "degraded" : rate > 0.01 ? "elevated" : "healthy")
export const HEALTH_COLOR = { healthy: "#79ad9b", elevated: "#d3a65c", degraded: "#dc7b6d" } as const
const rateFormatter = new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" })
export const formatRate = (rate: number, estimated = false) =>
	`${estimated ? "~" : ""}${rate > 0 && rate < 0.1 ? "<0.1" : rateFormatter.format(rate)}/s`
export const formatLatency = (ms: number | undefined) =>
	ms === undefined ? "—" : `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`
export const formatError = (rate: number) => `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`

export function connectedIds(
	topology: SpatialTopology,
	selectedId: string | null,
): ReadonlySet<string> | null {
	if (!selectedId) return null
	const ids = new Set([selectedId])
	for (const edge of topology.edges) {
		if (edge.source === selectedId || edge.target === selectedId) {
			ids.add(edge.source)
			ids.add(edge.target)
		}
	}
	return ids
}

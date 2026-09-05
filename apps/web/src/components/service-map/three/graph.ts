import type { Edge3D, Node3D } from "./types"

/** Collapse cycles first, then rank the resulting DAG by longest dependency path. */
export function computeTiers(
	nodes: ReadonlyArray<Pick<Node3D, "id">>,
	edges: ReadonlyArray<Pick<Edge3D, "source" | "target">>,
): Map<string, number> {
	const adjacency = new Map(nodes.map((node) => [node.id, [] as string[]]))
	for (const edge of edges) {
		if (adjacency.has(edge.target)) adjacency.get(edge.source)?.push(edge.target)
	}
	const indices = new Map<string, number>(),
		low = new Map<string, number>()
	const stack: string[] = [],
		onStack = new Set<string>(),
		component = new Map<string, number>()
	let index = 0,
		componentCount = 0
	const visit = (id: string) => {
		indices.set(id, index)
		low.set(id, index++)
		stack.push(id)
		onStack.add(id)
		for (const target of adjacency.get(id) ?? []) {
			if (!indices.has(target)) {
				visit(target)
				low.set(id, Math.min(low.get(id) ?? 0, low.get(target) ?? 0))
			} else if (onStack.has(target)) low.set(id, Math.min(low.get(id) ?? 0, indices.get(target) ?? 0))
		}
		if (low.get(id) !== indices.get(id)) return
		let member: string | undefined
		do {
			member = stack.pop()
			if (member === undefined) break
			onStack.delete(member)
			component.set(member, componentCount)
		} while (member !== id)
		componentCount++
	}
	for (const id of [...adjacency.keys()].sort()) if (!indices.has(id)) visit(id)
	const outgoing = Array.from({ length: componentCount }, () => new Set<number>())
	const indegree = Array<number>(componentCount).fill(0),
		depth = Array<number>(componentCount).fill(0)
	for (const edge of edges) {
		const from = component.get(edge.source),
			to = component.get(edge.target)
		if (from === undefined || to === undefined || from === to || outgoing[from]?.has(to)) continue
		outgoing[from]?.add(to)
		indegree[to] = (indegree[to] ?? 0) + 1
	}
	const queue = indegree.flatMap((count, i) => (count === 0 ? [i] : []))
	for (let i = 0; i < queue.length; i++) {
		const from = queue[i]
		if (from === undefined) continue
		for (const to of outgoing[from] ?? []) {
			depth[to] = Math.max(depth[to] ?? 0, (depth[from] ?? 0) + 1)
			indegree[to] = (indegree[to] ?? 1) - 1
			if (indegree[to] === 0) queue.push(to)
		}
	}
	return new Map(nodes.map((node) => [node.id, depth[component.get(node.id) ?? 0] ?? 0]))
}

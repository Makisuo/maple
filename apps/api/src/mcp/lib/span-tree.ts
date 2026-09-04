import type { SpanNode } from "@maple/query-engine/observability"

/**
 * A trace can contain thousands of spans (the underlying SQL fetches up to
 * `SPAN_HIERARCHY_MAX_SPANS = 5_000`). Rendering all of them into an LLM
 * response blows up the context window and is unreadable. `selectOverviewSpans`
 * prunes a span tree down to an *overview* — the spans most worth showing —
 * while keeping the tree connected to its root(s).
 *
 * Selection policy (best-first, mirrors Sentry's trace-overview heuristic):
 *   1. Always keep every error span and every root, plus the ancestor chain of
 *      anything kept (so the tree never has dangling children).
 *   2. Fill the remaining budget with the highest-scoring spans, where
 *      `score = durationMs + descendantCount * 4 + (service-entry ? 250 : 0)`.
 *
 * Errors/roots/ancestors are kept even if they exceed the budget — correctness
 * (never hiding an error) wins over the soft size target.
 */

const ENTRY_KINDS = new Set(["Server", "Consumer"])
const ENTRY_BOOST = 250
const DESCENDANT_WEIGHT = 4

export interface OverviewSelection {
	/** Pruned tree — new node objects whose `children` contain only kept spans. */
	readonly roots: SpanNode[]
	/** Number of spans present in `roots`. */
	readonly renderedCount: number
	/** Number of spans in the original tree. */
	readonly totalCount: number
	/** True when spans were dropped (`renderedCount < totalCount`). */
	readonly truncated: boolean
	/**
	 * For each parent whose children were partially dropped, the count and summed
	 * root-duration of the omitted subtrees. Keyed by parent spanId (the empty
	 * string `""` keys omissions at the root level). Empty when not truncated.
	 */
	readonly omittedByParent: ReadonlyMap<string, { count: number; totalDurationMs: number }>
}

const isError = (n: SpanNode): boolean => n.statusCode === "Error"
const isEntry = (n: SpanNode): boolean => ENTRY_KINDS.has(n.spanKind)
const key = (n: SpanNode): string => n.spanId as string

/** Walk every node once, invoking `visit(node, parent)`. */
function forEachNode(
	roots: ReadonlyArray<SpanNode>,
	visit: (node: SpanNode, parent: SpanNode | null) => void,
): void {
	const stack: Array<{ node: SpanNode; parent: SpanNode | null }> = roots.map((node) => ({
		node,
		parent: null,
	}))
	while (stack.length > 0) {
		const { node, parent } = stack.pop()!
		visit(node, parent)
		for (const child of node.children) stack.push({ node: child, parent: node })
	}
}

/** Total spans in a subtree, including the node itself. */
function subtreeSize(node: SpanNode): number {
	let count = 1
	for (const child of node.children) count += subtreeSize(child)
	return count
}

/**
 * Prune `roots` to at most ~`budget` spans, biasing toward errors, roots and
 * long/structural spans. Returns the original tree unchanged when it already
 * fits within `budget` (so small traces render exactly as before).
 */
export interface OverviewOptions {
	/**
	 * Keep only error spans, their ancestor chains and the roots — no budget fill. Applies even
	 * to traces that would fit the budget, since the point is to strip the healthy spans.
	 */
	readonly errorsOnly?: boolean
}

export function selectOverviewSpans(
	roots: ReadonlyArray<SpanNode>,
	budget: number,
	options: OverviewOptions = {},
): OverviewSelection {
	let totalCount = 0
	const parentOf = new Map<string, SpanNode | null>()
	forEachNode(roots, (node, parent) => {
		totalCount += 1
		parentOf.set(key(node), parent)
	})

	if (totalCount <= budget && !options.errorsOnly) {
		return {
			roots: roots as SpanNode[],
			renderedCount: totalCount,
			totalCount,
			truncated: false,
			omittedByParent: new Map(),
		}
	}

	const selected = new Set<string>()
	const addWithAncestors = (node: SpanNode): void => {
		let current: SpanNode | null = node
		while (current && !selected.has(key(current))) {
			selected.add(key(current))
			current = parentOf.get(key(current)) ?? null
		}
	}

	// 1. Always keep errors and roots (+ their ancestor chains).
	const candidates: SpanNode[] = []
	forEachNode(roots, (node) => {
		const root = parentOf.get(key(node)) === null
		if (isError(node) || root) addWithAncestors(node)
		else candidates.push(node)
	})

	// 2. Fill remaining budget by score, highest first.
	if (!options.errorsOnly) {
		candidates.sort((a, b) => score(b) - score(a))
		for (const node of candidates) {
			if (selected.size >= budget) break
			addWithAncestors(node)
		}
	}

	// 3. Rebuild a pruned tree of new nodes; record omissions per parent.
	const omittedByParent = new Map<string, { count: number; totalDurationMs: number }>()
	const rebuild = (node: SpanNode): SpanNode => {
		const keptChildren: SpanNode[] = []
		let omittedCount = 0
		let omittedDurationMs = 0
		for (const child of node.children) {
			if (selected.has(key(child))) {
				keptChildren.push(rebuild(child))
			} else {
				omittedCount += subtreeSize(child)
				omittedDurationMs += child.durationMs
			}
		}
		if (omittedCount > 0) {
			omittedByParent.set(key(node), { count: omittedCount, totalDurationMs: omittedDurationMs })
		}
		return { ...node, children: keptChildren }
	}

	const prunedRoots = roots.filter((r) => selected.has(key(r))).map(rebuild)

	return {
		roots: prunedRoots,
		renderedCount: selected.size,
		totalCount,
		truncated: selected.size < totalCount,
		omittedByParent,
	}
}

function score(node: SpanNode): number {
	return node.durationMs + (subtreeSize(node) - 1) * DESCENDANT_WEIGHT + (isEntry(node) ? ENTRY_BOOST : 0)
}

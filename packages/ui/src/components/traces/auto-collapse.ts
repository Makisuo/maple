import type { SpanNode } from "../../lib/types"

// Traces below this many total spans expand fully (unchanged behaviour).
export const LONG_TRACE_THRESHOLD = 25
// On large traces, levels above this depth always stay expanded; everything at
// or below it folds into a `+N` badge. depth 0 = root, so this shows root + 2 levels.
export const MIN_COLLAPSE_DEPTH = 3

export function countDescendants(node: SpanNode): number {
	let count = 0
	for (const child of node.children) {
		count += 1 + countDescendants(child)
	}
	return count
}

function countSpans(nodes: SpanNode[]): number {
	let count = nodes.length
	for (const node of nodes) {
		count += countSpans(node.children)
	}
	return count
}

/** Every span id that has children — i.e. the full "expand all" set. */
export function collectAllCollapsibleIds(nodes: SpanNode[]): Set<string> {
	const ids = new Set<string>()
	const visit = (node: SpanNode) => {
		if (node.children.length > 0) {
			ids.add(node.spanId)
			node.children.forEach(visit)
		}
	}
	nodes.forEach(visit)
	return ids
}

/**
 * Every ancestor of `spanId`, i.e. the set of ids that must be expanded for that
 * span to be visible in the tree. Empty when the span is a root or is absent.
 */
export function collectAncestorIds(nodes: SpanNode[], spanId: string): Set<string> {
	const nodeById = new Map<string, SpanNode>()
	const index = (node: SpanNode) => {
		nodeById.set(node.spanId, node)
		node.children.forEach(index)
	}
	nodes.forEach(index)

	return collectAncestorIdsFromIndex(nodeById, spanId)
}

function collectAncestorIdsFromIndex(nodeById: Map<string, SpanNode>, spanId: string): Set<string> {
	const ancestors = new Set<string>()
	let current = nodeById.get(spanId)
	while (current?.parentSpanId) {
		const parent = nodeById.get(current.parentSpanId)
		if (!parent) break
		ancestors.add(parent.spanId)
		current = parent
	}
	return ancestors
}

export interface ComputeDefaultExpandedOptions {
	/** Keep this span's ancestor chain expanded so it's never hidden by auto-collapse. */
	keepVisibleSpanId?: string
}

/**
 * Compute the initial set of expanded span ids for a trace view.
 *
 * Small traces (<= LONG_TRACE_THRESHOLD spans) expand everything. Larger traces
 * keep the top levels (depth < MIN_COLLAPSE_DEPTH) expanded and fold everything
 * below into `+N` badges, while keeping the ancestor chain of every error span
 * expanded so failures stay visible.
 */
export function computeDefaultExpandedSpanIds(
	rootSpans: SpanNode[],
	opts: ComputeDefaultExpandedOptions = {},
): Set<string> {
	if (countSpans(rootSpans) <= LONG_TRACE_THRESHOLD) {
		return collectAllCollapsibleIds(rootSpans)
	}

	const expanded = new Set<string>()
	const nodeById = new Map<string, SpanNode>()

	// Post-order walk. Returns whether this subtree (including the node itself)
	// contains an error, so ancestors of any error can be kept expanded.
	const visit = (node: SpanNode): { hasError: boolean } => {
		nodeById.set(node.spanId, node)

		let subtreeHasError = node.statusCode === "Error"
		for (const child of node.children) {
			if (visit(child).hasError) subtreeHasError = true
		}

		if (node.children.length > 0) {
			// Keep the top levels expanded and reveal any branch containing an error;
			// fold everything else below the depth cut.
			if (node.depth < MIN_COLLAPSE_DEPTH || subtreeHasError) {
				expanded.add(node.spanId)
			}
		}

		return { hasError: subtreeHasError }
	}

	rootSpans.forEach(visit)

	// Force the selected/deep-linked span's ancestor chain open.
	if (opts.keepVisibleSpanId) {
		for (const id of collectAncestorIdsFromIndex(nodeById, opts.keepVisibleSpanId)) {
			expanded.add(id)
		}
	}

	return expanded
}

import type { Span, SpanHierarchyRow, SpanNode } from "./api"

function parseAttributes(value: string | null | undefined): Record<string, string> {
	if (!value) return {}
	try {
		const parsed = JSON.parse(value)
		return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
	} catch {
		return {}
	}
}

export function transformSpan(raw: SpanHierarchyRow): Span {
	return {
		traceId: raw.traceId,
		spanId: raw.spanId,
		parentSpanId: raw.parentSpanId,
		spanName: raw.spanName,
		serviceName: raw.serviceName,
		spanKind: raw.spanKind,
		durationMs: Number(raw.durationMs),
		startTime: String(raw.startTime),
		statusCode: raw.statusCode,
		statusMessage: raw.statusMessage,
		spanAttributes: parseAttributes(raw.spanAttributes),
		resourceAttributes: parseAttributes(raw.resourceAttributes),
	}
}

export function buildSpanTree(spans: Span[]): SpanNode[] {
	const spanMap = new Map<string, SpanNode>()
	const rootSpans: SpanNode[] = []

	for (const span of spans) {
		spanMap.set(span.spanId, { ...span, children: [], depth: 0 })
	}

	const missingParentGroups = new Map<string, SpanNode[]>()

	for (const span of spans) {
		const node = spanMap.get(span.spanId)
		if (!node) continue

		if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
			const parent = spanMap.get(span.parentSpanId)
			parent?.children.push(node)
		} else if (span.parentSpanId) {
			const group = missingParentGroups.get(span.parentSpanId) || []
			group.push(node)
			missingParentGroups.set(span.parentSpanId, group)
		} else {
			rootSpans.push(node)
		}
	}

	for (const [missingParentId, children] of missingParentGroups) {
		const placeholder: SpanNode = {
			traceId: children[0].traceId,
			spanId: missingParentId,
			parentSpanId: "",
			spanName: "Missing Span",
			serviceName: "unknown",
			spanKind: "SPAN_KIND_INTERNAL",
			durationMs: 0,
			startTime: children[0].startTime,
			statusCode: "Unset",
			statusMessage: "",
			spanAttributes: {},
			resourceAttributes: {},
			children,
			depth: 0,
			isMissing: true,
		}
		rootSpans.push(placeholder)
	}

	function setDepth(node: SpanNode, depth: number) {
		node.depth = depth
		for (const child of node.children) {
			setDepth(child, depth + 1)
		}
	}

	function sortChildren(node: SpanNode) {
		node.children.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
		for (const child of node.children) {
			sortChildren(child)
		}
	}

	for (const root of rootSpans) {
		setDepth(root, 0)
		sortChildren(root)
	}

	rootSpans.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
	return rootSpans
}

export function flattenSpanTree(roots: SpanNode[], expandedSpans: Set<string>): SpanNode[] {
	const result: SpanNode[] = []
	function walk(nodes: SpanNode[]) {
		for (const node of nodes) {
			result.push(node)
			if (node.children.length > 0 && expandedSpans.has(node.spanId)) {
				walk(node.children)
			}
		}
	}
	walk(roots)
	return result
}

export function collectExpandedIds(nodes: SpanNode[], maxDepth: number): Set<string> {
	const ids = new Set<string>()
	function walk(list: SpanNode[]) {
		for (const node of list) {
			if (node.children.length > 0 && node.depth < maxDepth) {
				ids.add(node.spanId)
				walk(node.children)
			}
		}
	}
	walk(nodes)
	return ids
}

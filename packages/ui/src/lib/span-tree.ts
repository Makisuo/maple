import { Schema } from "effect"
import { TraceId, SpanId } from "@maple/domain"
import type { Span, SpanNode } from "./types"

const toTraceId = Schema.decodeSync(TraceId)
const toSpanId = Schema.decodeSync(SpanId)

/**
 * Raw row shape returned by the span-hierarchy query (`CH.spanHierarchyQuery`).
 * Attribute columns arrive as JSON strings; `durationMs` may be a string.
 */
export interface SpanHierarchyRow {
	traceId: string
	spanId: string
	parentSpanId: string
	spanName: string
	serviceName: string
	spanKind: string
	durationMs: number | string
	startTime: string
	statusCode: string
	statusMessage: string
	spanAttributes: string
	resourceAttributes: string
}

/** JSON-parse an attribute column, tolerating null/empty/garbage. */
export function parseAttributes(value: string | null | undefined): Record<string, string> {
	if (!value) return {}
	try {
		const parsed = JSON.parse(value)
		return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
	} catch {
		return {}
	}
}

/** Map a raw hierarchy row into a branded `Span`. */
export function transformSpan(raw: SpanHierarchyRow): Span {
	return {
		traceId: toTraceId(raw.traceId),
		spanId: toSpanId(raw.spanId),
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

/** Drop duplicate spans (at-least-once ingest delivery), keeping the first occurrence. */
export function dedupeBySpanId(spans: Span[]): Span[] {
	const seen = new Set<string>()
	return spans.filter((span) => {
		if (seen.has(span.spanId)) return false
		seen.add(span.spanId)
		return true
	})
}

/**
 * Build a span tree from a flat span list. Spans whose parent is absent are
 * grouped under a synthetic "Missing Span" placeholder root so orphaned
 * subtrees still render. Children and roots are sorted by start time and each
 * node's `depth` is assigned.
 *
 * Duplicate spanIds (at-least-once ingest delivery) collapse to a single node;
 * linking iterates the deduped map so a node is never attached to its parent
 * twice — duplicates would otherwise repeat whole subtrees and break the
 * spanId-keyed rows in the waterfall virtualizer.
 */
export function buildSpanTree(spans: Span[]): SpanNode[] {
	const spanMap = new Map<string, SpanNode>()
	const rootSpans: SpanNode[] = []

	for (const span of spans) {
		if (!spanMap.has(span.spanId)) {
			spanMap.set(span.spanId, { ...span, children: [], depth: 0 })
		}
	}

	const missingParentGroups = new Map<string, SpanNode[]>()

	for (const node of spanMap.values()) {
		// Self-parenting (corrupt data) would make the node its own child and
		// recurse forever in setDepth — treat it as a root instead.
		if (node.parentSpanId && node.parentSpanId !== node.spanId && spanMap.has(node.parentSpanId)) {
			const parent = spanMap.get(node.parentSpanId)
			parent?.children.push(node)
		} else if (node.parentSpanId && node.parentSpanId !== node.spanId) {
			const group = missingParentGroups.get(node.parentSpanId) || []
			group.push(node)
			missingParentGroups.set(node.parentSpanId, group)
		} else {
			rootSpans.push(node)
		}
	}

	for (const [missingParentId, children] of missingParentGroups) {
		const placeholder: SpanNode = {
			traceId: children[0].traceId,
			spanId: toSpanId(missingParentId),
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

	for (const root of rootSpans) {
		setDepth(root, 0)
	}

	// Parse each node's startTime once — comparator-side `new Date(...)` costs
	// O(n log n) parses on 5k-span traces.
	const epochs = new Map<SpanNode, number>()
	const epochOf = (node: SpanNode): number => {
		let epoch = epochs.get(node)
		if (epoch === undefined) {
			epoch = new Date(node.startTime).getTime()
			epochs.set(node, epoch)
		}
		return epoch
	}

	function sortChildren(node: SpanNode) {
		node.children.sort((a, b) => epochOf(a) - epochOf(b))
		for (const child of node.children) {
			sortChildren(child)
		}
	}

	for (const root of rootSpans) {
		sortChildren(root)
	}

	rootSpans.sort((a, b) => epochOf(a) - epochOf(b))
	return rootSpans
}

export interface TraceDetail {
	spans: Span[]
	rootSpans: SpanNode[]
	totalDurationMs: number
	services: string[]
	traceStartTime: string
}

/**
 * Convenience: turn raw span-hierarchy rows into everything `TraceViewTabs`
 * needs — the flat span list, the root tree, total duration, the unique
 * service list, and the earliest start time.
 */
export function buildTraceDetail(rows: ReadonlyArray<SpanHierarchyRow>): TraceDetail {
	const spans = dedupeBySpanId(rows.map(transformSpan))
	const rootSpans = buildSpanTree(spans)
	const totalDurationMs = spans.length > 0 ? Math.max(...spans.map((span) => span.durationMs)) : 0
	const services = Array.from(new Set(spans.map((span) => span.serviceName).filter(Boolean)))
	let traceStartTime = spans.length > 0 ? spans[0].startTime : new Date().toISOString()
	let earliestEpoch = new Date(traceStartTime).getTime()
	for (const span of spans) {
		const epoch = new Date(span.startTime).getTime()
		if (epoch < earliestEpoch) {
			earliestEpoch = epoch
			traceStartTime = span.startTime
		}
	}

	return { spans, rootSpans, totalDurationMs, services, traceStartTime }
}

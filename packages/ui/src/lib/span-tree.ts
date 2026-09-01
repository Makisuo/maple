import { Option, Schema } from "effect"
import { TraceId, SpanId } from "@maple/domain"
import type { Span, SpanNode } from "./types"
import { trySync } from "./try-sync"

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
	const parsed = Option.filter(
		trySync<unknown>(() => JSON.parse(value)),
		(decoded): decoded is Record<string, string> => decoded !== null && typeof decoded === "object",
	)
	return Option.getOrElse(parsed, (): Record<string, string> => ({}))
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
	// After ordering, not before: the sort reflects what each service reported,
	// and the correction is a rendering concern layered on top of it.
	adjustClockSkew(rootSpans)
	return rootSpans
}

/**
 * A span's position on a chart, in epoch ms, with any clock-skew correction
 * applied. Every timeline, flamegraph, minimap and flow layout must use this
 * rather than parsing `startTime` itself — that is what keeps a corrected span
 * from being drawn back at its raw, impossible position.
 */
export function spanStartMs(span: Pick<SpanNode, "startTime" | "clockSkewMs">): number {
	return new Date(span.startTime).getTime() + (span.clockSkewMs ?? 0)
}

/**
 * Compensate for clock skew between services, the way Jaeger and Zipkin do.
 *
 * Span timestamps come from each process's own clock. Effect anchors its
 * nanosecond clock to the wall clock **once** and then counts on a monotonic
 * source, so two processes that started at different moments disagree by however
 * far their monotonic clocks have drifted — tens of milliseconds is routine, and
 * it is not specific to any one SDK. The visible symptom is a child span that
 * starts before its parent, or ends after it: physically impossible, so it is
 * always the clocks, never the causality.
 *
 * Where a child does not fit inside its parent, we shift the child's whole
 * subtree so it sits centred in the parent's window — the same estimate Jaeger
 * uses, and the best available without a round-trip measurement. Two guards keep
 * this from inventing corrections:
 *
 * - Only across a **service boundary**. Two spans from one process share a
 *   clock, so a child outside its parent there is real data (or a real bug), and
 *   hiding it would be worse than showing it.
 * - Only when the child actually **fits**. A child longer than its parent cannot
 *   be explained by skew, so it is left alone.
 *
 * Runs top-down: a parent is corrected before its children are measured against
 * it, so skew accumulated at one hop carries down the subtree instead of being
 * re-estimated at every level.
 */
export function adjustClockSkew(rootSpans: SpanNode[]): { adjustedCount: number; maxSkewMs: number } {
	let adjustedCount = 0
	let maxSkewMs = 0

	const shiftSubtree = (node: SpanNode, skewMs: number): void => {
		node.clockSkewMs = (node.clockSkewMs ?? 0) + skewMs
		for (const child of node.children) shiftSubtree(child, skewMs)
	}

	const visit = (parent: SpanNode): void => {
		const parentStart = spanStartMs(parent)
		const parentEnd = parentStart + parent.durationMs
		for (const child of parent.children) {
			if (child.serviceName === parent.serviceName) {
				visit(child)
				continue
			}
			const childStart = spanStartMs(child)
			const childEnd = childStart + child.durationMs
			const fits = childStart >= parentStart && childEnd <= parentEnd
			const slackMs = parent.durationMs - child.durationMs
			if (!fits && slackMs >= 0) {
				const skewMs = parentStart + slackMs / 2 - childStart
				// One correction per boundary crossed, not per span moved: the
				// descendants ride along on their parent's clock, they were not
				// each independently misplaced.
				adjustedCount++
				if (Math.abs(skewMs) > Math.abs(maxSkewMs)) maxSkewMs = skewMs
				shiftSubtree(child, skewMs)
			}
			visit(child)
		}
	}

	for (const root of rootSpans) visit(root)
	return { adjustedCount, maxSkewMs }
}

/** What `adjustClockSkew` did to an already-built tree, for the timeline's badge. */
export function summarizeClockSkew(
	rootSpans: ReadonlyArray<SpanNode>,
): { adjustedCount: number; maxSkewMs: number } | null {
	let adjustedCount = 0
	let maxSkewMs = 0
	// Count the spans a correction was *decided* for — a node whose skew differs
	// from its parent's — so a shifted subtree reads as one adjustment, matching
	// what `adjustClockSkew` reported when it made them.
	const visit = (node: SpanNode, parentSkewMs: number): void => {
		const skewMs = node.clockSkewMs ?? 0
		if (skewMs !== parentSkewMs) {
			adjustedCount++
			if (Math.abs(skewMs) > Math.abs(maxSkewMs)) maxSkewMs = skewMs
		}
		for (const child of node.children) visit(child, skewMs)
	}
	for (const root of rootSpans) visit(root, 0)
	return adjustedCount === 0 ? null : { adjustedCount, maxSkewMs }
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

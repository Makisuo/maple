import { describe, expect, it } from "vitest"
import { SpanId } from "@maple/domain"
import type { SpanNode } from "@maple/query-engine/observability"
import { Schema } from "effect"
import { selectOverviewSpans } from "./span-tree"

const decodeSpanId = Schema.decodeSync(SpanId)

function span(
	id: string,
	opts: Partial<Omit<SpanNode, "spanId" | "children">> & { children?: SpanNode[] } = {},
): SpanNode {
	return {
		spanId: decodeSpanId(id),
		parentSpanId: opts.parentSpanId ?? "",
		spanName: opts.spanName ?? id,
		serviceName: opts.serviceName ?? "svc",
		spanKind: opts.spanKind ?? "Internal",
		durationMs: opts.durationMs ?? 1,
		statusCode: opts.statusCode ?? "Unset",
		statusMessage: opts.statusMessage ?? "",
		attributes: opts.attributes ?? {},
		resourceAttributes: opts.resourceAttributes ?? {},
		children: opts.children ?? [],
	}
}

/** Collect every spanId present in a pruned tree. */
function ids(roots: ReadonlyArray<SpanNode>): Set<string> {
	const out = new Set<string>()
	const walk = (n: SpanNode) => {
		out.add(n.spanId)
		n.children.forEach(walk)
	}
	roots.forEach(walk)
	return out
}

// A 16-span trace used by several cases.
//   root (Server, 100ms)
//   ├─ a (50ms)
//   │  ├─ a1 (5ms)
//   │  └─ a2 (5ms, Error)
//   ├─ b (80ms) with 10 tiny children b0..b9
//   └─ c (Server, 30ms)
function bigTree(): SpanNode[] {
	const a = span("a", {
		durationMs: 50,
		children: [span("a1", { durationMs: 5 }), span("a2", { durationMs: 5, statusCode: "Error" })],
	})
	const b = span("b", {
		durationMs: 80,
		children: Array.from({ length: 10 }, (_, i) => span(`b${i}`, { durationMs: 1 })),
	})
	const c = span("c", { durationMs: 30, spanKind: "Server" })
	return [span("root", { durationMs: 100, spanKind: "Server", children: [a, b, c] })]
}

describe("selectOverviewSpans", () => {
	it("returns the tree unchanged when it fits within budget", () => {
		const roots = [span("root", { children: [span("a"), span("b")] })]
		const result = selectOverviewSpans(roots, 10)
		expect(result.truncated).toBe(false)
		expect(result.totalCount).toBe(3)
		expect(result.renderedCount).toBe(3)
		expect(result.roots).toBe(roots) // same reference, no rebuild
		expect(result.omittedByParent.size).toBe(0)
	})

	it("respects the budget and reports totals when truncating", () => {
		const result = selectOverviewSpans(bigTree(), 6)
		expect(result.truncated).toBe(true)
		expect(result.totalCount).toBe(16)
		expect(result.renderedCount).toBe(6)
	})

	it("always keeps error spans and their ancestors", () => {
		const result = selectOverviewSpans(bigTree(), 6)
		const kept = ids(result.roots)
		expect(kept.has("a2")).toBe(true) // the error span
		expect(kept.has("a")).toBe(true) // its parent
		expect(kept.has("root")).toBe(true) // the root
	})

	it("keeps errors even when that exceeds the budget (correctness over size)", () => {
		const result = selectOverviewSpans(bigTree(), 2)
		const kept = ids(result.roots)
		expect(kept.has("a2")).toBe(true)
		// root + a + a2 are all forced, so we exceed the soft budget of 2.
		expect(result.renderedCount).toBe(3)
		expect(result.truncated).toBe(true)
	})

	it("prefers high-score spans (long / service-entry) for the remaining budget", () => {
		const result = selectOverviewSpans(bigTree(), 6)
		const kept = ids(result.roots)
		expect(kept.has("c")).toBe(true) // Server-kind entry span, boosted
		expect(kept.has("b")).toBe(true) // long + many descendants
	})

	it("records omitted children per parent", () => {
		const result = selectOverviewSpans(bigTree(), 6)
		// b's 10 tiny children are dropped.
		const omitted = result.omittedByParent.get("b")
		expect(omitted).toBeDefined()
		expect(omitted!.count).toBe(10)
		expect(omitted!.totalDurationMs).toBe(10)
	})

	it("keeps the pruned tree connected (every node's children are real kept nodes)", () => {
		const result = selectOverviewSpans(bigTree(), 6)
		const kept = ids(result.roots)
		const checkConnected = (n: SpanNode) => {
			for (const child of n.children) {
				expect(kept.has(child.spanId)).toBe(true)
				checkConnected(child)
			}
		}
		result.roots.forEach(checkConnected)
	})
})

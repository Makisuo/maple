import { describe, expect, it } from "vitest"

import { collectDescendantParentIds, computeCollapseOneLevel, computeExpandOneLevel } from "../auto-collapse"
import { collectParentIdsByLevel } from "../use-trace-timeline"
import type { SpanNode } from "../../../lib/types"

/** Minimal SpanNode — these helpers only read spanId, depth and children. */
function node(spanId: string, depth: number, children: SpanNode[] = []): SpanNode {
	return {
		traceId: "t",
		spanId,
		parentSpanId: "",
		spanName: spanId,
		serviceName: "svc",
		spanKind: "Internal",
		durationMs: 1,
		startTime: "2026-01-01T00:00:00.000Z",
		statusCode: "Ok",
		statusMessage: "",
		spanAttributes: {},
		resourceAttributes: {},
		children,
		depth,
	} as SpanNode
}

//  root (0)
//  ├── a (1) ── a1 (2) ── a1x (3)
//  └── b (1) ── b1 (2)          ← b1 is a leaf, so not a "parent"
const TREE = [
	node("root", 0, [node("a", 1, [node("a1", 2, [node("a1x", 3)])]), node("b", 1, [node("b1", 2)])]),
]

describe("collectParentIdsByLevel", () => {
	it("buckets only nodes that have children, by depth", () => {
		const byLevel = collectParentIdsByLevel(TREE)
		expect(byLevel.get(0)).toEqual(new Set(["root"]))
		expect(byLevel.get(1)).toEqual(new Set(["a", "b"]))
		expect(byLevel.get(2)).toEqual(new Set(["a1"])) // b1 is a leaf
		expect(byLevel.has(3)).toBe(false) // a1x is a leaf
	})

	it("walks past collapsed ancestors, so hidden parents are still known", () => {
		// Nothing about the expanded set is consulted — the map covers the whole tree.
		expect(collectParentIdsByLevel(TREE).get(2)).toEqual(new Set(["a1"]))
	})
})

describe("computeExpandOneLevel", () => {
	const byLevel = collectParentIdsByLevel(TREE)

	it("opens the shallowest level that still has a collapsed parent", () => {
		const step1 = computeExpandOneLevel(new Set(), byLevel)
		expect(step1).toEqual(new Set(["root"]))
		const step2 = computeExpandOneLevel(step1, byLevel)
		expect(step2).toEqual(new Set(["root", "a", "b"]))
		const step3 = computeExpandOneLevel(step2, byLevel)
		expect(step3).toEqual(new Set(["root", "a", "b", "a1"]))
	})

	it("expands a partially open level rather than skipping past it", () => {
		const next = computeExpandOneLevel(new Set(["root", "a"]), byLevel)
		expect(next).toEqual(new Set(["root", "a", "b"]))
	})

	it("returns the same set when everything is already open", () => {
		const all = new Set(["root", "a", "b", "a1"])
		expect(computeExpandOneLevel(all, byLevel)).toBe(all)
	})
})

describe("computeCollapseOneLevel", () => {
	const byLevel = collectParentIdsByLevel(TREE)

	it("closes the deepest expanded level first", () => {
		const all = new Set(["root", "a", "b", "a1"])
		const step1 = computeCollapseOneLevel(all, byLevel)
		expect(step1).toEqual(new Set(["root", "a", "b"]))
		const step2 = computeCollapseOneLevel(step1, byLevel)
		expect(step2).toEqual(new Set(["root"]))
		const step3 = computeCollapseOneLevel(step2, byLevel)
		expect(step3).toEqual(new Set())
	})

	it("returns the same set when everything is already closed", () => {
		const none = new Set<string>()
		expect(computeCollapseOneLevel(none, byLevel)).toBe(none)
	})

	it("round-trips with computeExpandOneLevel", () => {
		const all = new Set(["root", "a", "b", "a1"])
		expect(computeExpandOneLevel(computeCollapseOneLevel(all, byLevel), byLevel)).toEqual(all)
	})
})

describe("collectDescendantParentIds", () => {
	it("returns expandable descendants only, excluding the node itself", () => {
		expect(collectDescendantParentIds(TREE[0]).sort()).toEqual(["a", "a1", "b"])
	})

	it("returns nothing for a leaf", () => {
		expect(collectDescendantParentIds(node("leaf", 0))).toEqual([])
	})
})

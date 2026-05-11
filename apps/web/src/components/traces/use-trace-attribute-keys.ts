import * as React from "react"
import type { SpanNode } from "@/api/tinybird/traces"

export interface AttributeKey {
	kind: "spanAttribute" | "resourceAttribute"
	key: string
	count: number
}

const MAX_KEYS_PER_SOURCE = 20

export function useTraceAttributeKeys(rootSpans: SpanNode[]): AttributeKey[] {
	return React.useMemo(() => {
		const spanCounts = new Map<string, number>()
		const resourceCounts = new Map<string, number>()

		function visit(node: SpanNode) {
			for (const k of Object.keys(node.spanAttributes ?? {})) {
				spanCounts.set(k, (spanCounts.get(k) ?? 0) + 1)
			}
			for (const k of Object.keys(node.resourceAttributes ?? {})) {
				resourceCounts.set(k, (resourceCounts.get(k) ?? 0) + 1)
			}
			node.children.forEach(visit)
		}
		rootSpans.forEach(visit)

		const sortByCountThenKey = (a: [string, number], b: [string, number]) =>
			b[1] - a[1] || a[0].localeCompare(b[0])

		const spanEntries = [...spanCounts.entries()]
			.sort(sortByCountThenKey)
			.slice(0, MAX_KEYS_PER_SOURCE)
			.map<AttributeKey>(([key, count]) => ({ kind: "spanAttribute", key, count }))

		const resourceEntries = [...resourceCounts.entries()]
			.sort(sortByCountThenKey)
			.slice(0, MAX_KEYS_PER_SOURCE)
			.map<AttributeKey>(([key, count]) => ({ kind: "resourceAttribute", key, count }))

		return [...spanEntries, ...resourceEntries]
	}, [rootSpans])
}

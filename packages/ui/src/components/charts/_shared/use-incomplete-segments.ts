import { useMemo } from "react"
import type { ChartConfig } from "../../ui/chart"
import { markIncompleteSegments } from "../../../lib/incomplete-buckets"

/**
 * React hook wrapper around `markIncompleteSegments`.
 */
export function useIncompleteSegments<T extends Record<string, unknown>>(
	data: T[],
	valueKeys: string[],
	opts?: { now?: number },
) {
	return useMemo(() => markIncompleteSegments(data, valueKeys, opts), [data, valueKeys, opts])
}

/**
 * Extend a ChartConfig with entries for `_incomplete` keys.
 * Each incomplete key inherits the color of the base key but has no label,
 * so Recharts won't render a duplicate legend entry.
 */
export function extendConfigWithIncomplete(baseConfig: ChartConfig, incompleteKeys: string[]): ChartConfig {
	if (incompleteKeys.length === 0) return baseConfig

	const extended = { ...baseConfig }
	for (const ik of incompleteKeys) {
		const baseKey = ik.replace(/_incomplete$/, "")
		const base = baseConfig[baseKey]
		if (base) {
			extended[ik] = { color: base.color }
		}
	}
	return extended
}

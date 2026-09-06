import type { SessionTokenTotals } from "./session-summary"

/**
 * The five disjoint usage buckets and the fill each one draws in — shared by
 * the detail page's Tokens rail and the list row's bar, so a session's bar
 * reads the same in both places. Chart tokens rather than new hues, like the
 * rest of the session page's vocabulary (`span-visuals.ts`).
 */
export const TOKEN_BUCKETS = [
	{ key: "input", label: "Input", fill: "bg-chart-2" },
	{ key: "cacheRead", label: "Cache read", fill: "bg-chart-4" },
	{ key: "cacheWrite", label: "Cache write", fill: "bg-chart-5" },
	{ key: "output", label: "Output", fill: "bg-chart-1" },
	{ key: "reasoning", label: "Reasoning", fill: "bg-chart-3" },
] as const satisfies ReadonlyArray<{
	key: keyof Omit<SessionTokenTotals, "total">
	label: string
	fill: string
}>

export type TokenBucketKey = (typeof TOKEN_BUCKETS)[number]["key"]

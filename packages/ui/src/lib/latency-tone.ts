// Magnitude → tone scale for latency percentiles. Sibling of the severity
// vocabulary in apps/web's infra/severity-tokens.ts: a `Record<Level, string>`
// per rendering surface, so a percentile cell tones identically wherever it is
// rendered (services table, infra tables, service map, chat renderers).

/** Emphasis steps, low → high. Warm-only: nothing is colored for being fine. */
export type LatencyLevel = "quiet" | "nominal" | "elevated" | "slow" | "critical"

/**
 * Which budget a value is measured against. p99 is *expected* to be higher than
 * p50, so a single absolute threshold would paint every p99 column red; each
 * percentile gets its own budget instead.
 */
export type LatencyScale = "p50" | "avg" | "p95" | "p99" | "cpu"

/**
 * Budgets in ms. p95 is anchored on the absolute health thresholds already in
 * apps/web/src/components/dashboard/service-health.ts (P95_DEGRADED_MS = 1000,
 * P95_UNHEALTHY_MS = 3000), so a cell's tone agrees with the health badge on
 * the same row. `cpu` exists because Cloudflare Worker CPU-time lives on a
 * different scale entirely — under the p99 budget every worker reads "quiet".
 */
const BUDGET_MS: Record<LatencyScale, number> = {
	p50: 300,
	avg: 500,
	p95: 1_000,
	p99: 2_000,
	cpu: 50,
} satisfies Record<LatencyScale, number>

/**
 * Level boundaries as ratios of the budget. At the p95 budget these land on
 * 150ms / 500ms / 1s / 3s — the last two being exactly the degraded/unhealthy
 * thresholds the health rollup already uses.
 */
const BREAKS = [0.15, 0.5, 1, 3] as const

const LEVELS: readonly LatencyLevel[] = ["quiet", "nominal", "elevated", "slow", "critical"]

/**
 * Resolve a latency value to an emphasis level.
 *
 * `budgetMs` overrides the scale preset for one-off units. Missing values
 * (0, negative, NaN, Infinity) resolve to "quiet" so "no data" recedes rather
 * than reading as fast.
 */
export function latencyLevel(ms: number, scale: LatencyScale = "p95", budgetMs?: number): LatencyLevel {
	if (!Number.isFinite(ms) || ms <= 0) return "quiet"
	const budget = budgetMs ?? BUDGET_MS[scale]
	if (!Number.isFinite(budget) || budget <= 0) return "quiet"
	const ratio = ms / budget
	// Indexed loop, not `BREAKS.entries()`: this runs per metric cell per frame
	// (3 calls x 40 nodes on the service map), so it goes hot fast, and the
	// iterator-plus-array-destructuring form crashes JavaScriptCore's DFG tier
	// when it does — EXC_BREAKPOINT in VirtualRegisterAllocationPhase, which
	// takes the whole WebKit content process down. Plain indexing is also less
	// work per call.
	for (let i = 0; i < BREAKS.length; i++) {
		if (ratio < BREAKS[i]) return LEVELS[i]
	}
	return "critical"
}

/**
 * Value text tone — table cells, stat cards, metric lines.
 *
 * The floor is `text-muted-foreground`, not a dimmer opacity variant: eyebrow
 * labels next to these values already sit at `text-muted-foreground/60`, and a
 * value fainter than its own label reads as the label rather than the number.
 */
export const LATENCY_TEXT_TONE: Record<LatencyLevel, string> = {
	quiet: "text-muted-foreground",
	nominal: "text-foreground/70",
	elevated: "text-foreground",
	slow: "text-severity-warn",
	critical: "text-severity-error",
} satisfies Record<LatencyLevel, string>

/** Solid fill for inline meters and distribution bars behind a value. */
export const LATENCY_BAR_TONE: Record<LatencyLevel, string> = {
	quiet: "bg-muted-foreground/15",
	nominal: "bg-muted-foreground/25",
	elevated: "bg-foreground/20",
	slow: "bg-severity-warn/25",
	critical: "bg-severity-error/25",
} satisfies Record<LatencyLevel, string>

/** Raw color strings for SVG fills and inline styles (no Tailwind class). */
export const LATENCY_COLOR: Record<LatencyLevel, string> = {
	quiet: "var(--color-muted-foreground)",
	nominal: "var(--color-muted-foreground)",
	elevated: "var(--color-foreground)",
	slow: "var(--color-severity-warn)",
	critical: "var(--color-severity-error)",
} satisfies Record<LatencyLevel, string>

/** Level → text class in one call. Mirrors the shape of `errorRateClass`. */
export function latencyToneClass(ms: number, scale: LatencyScale = "p95", budgetMs?: number): string {
	return LATENCY_TEXT_TONE[latencyLevel(ms, scale, budgetMs)]
}

const LEVEL_LABEL: Record<LatencyLevel, string> = {
	quiet: "fast",
	nominal: "normal",
	elevated: "elevated",
	slow: "slow",
	critical: "very slow",
} satisfies Record<LatencyLevel, string>

/** Plain-word label for `title`/`aria-label`, so tone is never color-only. */
export function latencyLevelLabel(level: LatencyLevel): string {
	return LEVEL_LABEL[level]
}

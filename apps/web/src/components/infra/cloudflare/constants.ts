// Shared vocabulary for the Cloudflare infra pages: chart bucketing plus the
// fixed color mappings for HTTP status classes and cache statuses. The cache
// palette is shared by the detail breakdown chart and the edge-share band so
// the same status never renders in two hues on one page.

import { VALUE_TONE } from "../severity-tokens"

/**
 * Bucket width for the timeseries charts: aim for ~100 points, floored at the
 * poller's 5-minute granularity and rounded to whole 5-minute steps.
 */
export function chartBucketSeconds(startTime: string, endTime: string): number {
	const startMs = new Date(startTime.replace(" ", "T") + "Z").getTime()
	const endMs = new Date(endTime.replace(" ", "T") + "Z").getTime()
	const windowSeconds = Math.max((endMs - startMs) / 1000, 300)
	return Math.max(300, Math.ceil(windowSeconds / 100 / 300) * 300)
}

/**
 * Shared 5% / 1% thresholds for tinting 5xx and Worker error rates — one
 * source for the tables and the detail stat rail.
 */
export function errorRateTone(rate: number): "crit" | "warn" | "neutral" {
	if (rate >= 0.05) return "crit"
	if (rate >= 0.01) return "warn"
	return "neutral"
}

/** Error-rate cell tint for the tables: canonical severity tokens above the thresholds, quiet otherwise. */
export function errorRateClass(rate: number): string {
	const tone = errorRateTone(rate)
	return tone === "neutral" ? "text-foreground/80" : VALUE_TONE[tone]
}

/**
 * The list charts plot at most `COLOR_PALETTE.length` zones; the remainder
 * pools into one "Other zones" series in this muted color (same ramp as the
 * deliberately-uncached cache statuses below).
 */
export const OTHER_ZONES_SERIES = "Other zones"
export const OTHER_ZONES_COLOR = "color-mix(in oklab, var(--muted-foreground) 45%, transparent)"

// Status classes carry severity; cache statuses shade from "answered at the
// edge" (primary) to "went to origin" (muted). Both are fixed, meaningful
// mappings — not palette-by-index.

export const STATUS_CLASS_COLORS: Record<string, string> = {
	// 1xx is informational chatter, not a real response — a faded take on the 2xx hue.
	"1xx": "color-mix(in oklab, var(--severity-info) 50%, transparent)",
	"2xx": "var(--severity-info)",
	"3xx": "var(--chart-2)",
	"4xx": "var(--severity-warn)",
	"5xx": "var(--severity-error)",
	unknown: "color-mix(in oklab, var(--muted-foreground) 55%, transparent)",
}

export const STATUS_CLASS_ORDER = ["1xx", "2xx", "3xx", "4xx", "5xx", "unknown"]

/** Cache statuses the edge answered without touching origin, strongest first. */
export const EDGE_SERVED_STATUSES: ReadonlyArray<{ status: string; label: string; color: string }> = [
	{ status: "hit", label: "Hit", color: "var(--primary)" },
	{ status: "stale", label: "Stale", color: "color-mix(in oklab, var(--primary) 70%, transparent)" },
	{
		status: "revalidated",
		label: "Revalidated",
		color: "color-mix(in oklab, var(--primary) 50%, transparent)",
	},
	{
		status: "updating",
		label: "Updating",
		color: "color-mix(in oklab, var(--primary) 35%, transparent)",
	},
]

export const CACHE_STATUS_COLORS: Record<string, string> = {
	...Object.fromEntries(EDGE_SERVED_STATUSES.map((s) => [s.status, s.color])),
	miss: "var(--chart-3)",
	expired: "var(--chart-4)",
	// Deliberately-uncached traffic (bypass/dynamic/none) shades down a single
	// muted ramp — it all reads as "went to origin, by design".
	bypass: "color-mix(in oklab, var(--muted-foreground) 60%, transparent)",
	dynamic: "color-mix(in oklab, var(--muted-foreground) 45%, transparent)",
	none: "color-mix(in oklab, var(--muted-foreground) 35%, transparent)",
	unknown: "color-mix(in oklab, var(--muted-foreground) 25%, transparent)",
}

export const CACHE_STATUS_ORDER = [
	...EDGE_SERVED_STATUSES.map((s) => s.status),
	"miss",
	"expired",
	"bypass",
	"dynamic",
	"none",
	"unknown",
]

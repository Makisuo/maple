import { toEpochMs } from "@maple/ui/lib/time-format"

// Shared controls for the infra detail routes. Per-resource metric tabs/strips
// stay in their own routes (genuinely page-specific); only the time-range
// vocabulary is common.

export const TIME_PRESETS = [
	{ value: "15m", label: "Last 15 minutes" },
	{ value: "1h", label: "Last hour" },
	{ value: "6h", label: "Last 6 hours" },
	{ value: "12h", label: "Last 12 hours" },
	{ value: "24h", label: "Last 24 hours" },
	{ value: "7d", label: "Last 7 days" },
] as const

const BUCKET_SECONDS: Record<string, number> = {
	"15m": 15,
	"1h": 60,
	"6h": 300,
	"12h": 600,
	"24h": 900,
	"7d": 3600,
} satisfies Record<string, number>

/** Chart bucket width for a preset; falls back to 60s for anything unrecognized. */
export function bucketSecondsFor(preset: string): number {
	return BUCKET_SECONDS[preset] ?? 60
}

/**
 * Bucket widths a kubelet-sampled series can honestly be drawn at. The floor is
 * the scrape interval — anything finer would draw gaps, not resolution.
 */
const BUCKET_CEILING = 14400
const BUCKET_LADDER: ReadonlyArray<number> = [
	15,
	30,
	60,
	120,
	300,
	600,
	900,
	1800,
	3600,
	7200,
	BUCKET_CEILING,
]

/**
 * Chart bucket for an arbitrary window: about a hundred points, snapped up to
 * the ladder. The preset table above can't serve a page whose window lives in
 * the URL, where a custom range has no preset to look up.
 */
export function bucketSecondsForRange(startTime: string, endTime: string): number {
	const windowSeconds = Math.max((toEpochMs(endTime) - toEpochMs(startTime)) / 1000, 60)
	const target = windowSeconds / 100
	return BUCKET_LADDER.find((width) => width >= target) ?? BUCKET_CEILING
}

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

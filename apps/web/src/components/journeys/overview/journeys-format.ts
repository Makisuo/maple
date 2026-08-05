import { toEpochMs } from "@maple/ui/lib/time-format"

// ---------------------------------------------------------------------------
// Journey list formatters.
//
// Deliberately not `@maple/ui`'s `formatNumber`/`formatDuration`: this column
// block is read as a block, so the figures have to line up in width and read at
// one glance. "21.5K" and "3.20s" are right elsewhere and wrong here.
// ---------------------------------------------------------------------------

/** `12.4k`, `214k`, `1.2M`. Below a thousand the raw count is the clearest form. */
export function formatTokens(total: number): string {
	if (!Number.isFinite(total)) return "—"
	const abs = Math.abs(total)
	if (abs >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`
	if (abs >= 100_000) return `${Math.round(total / 1000)}k`
	if (abs >= 1000) return `${(total / 1000).toFixed(1)}k`
	return String(Math.round(total))
}

/** `8.2s`, `41s`, `3m 12s`, `1h 04m`. Seconds are zero-padded inside a minute so
 *  the column stays rectangular. */
export function formatJourneyDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—"
	const seconds = ms / 1000
	if (seconds < 10) return `${seconds.toFixed(1)}s`
	if (seconds < 60) return `${Math.round(seconds)}s`
	if (seconds < 3600) {
		const minutes = Math.floor(seconds / 60)
		const rest = Math.round(seconds % 60)
		return `${minutes}m ${String(rest).padStart(2, "0")}s`
	}
	const hours = Math.floor(seconds / 3600)
	const restMinutes = Math.round((seconds % 3600) / 60)
	return `${hours}h ${String(restMinutes).padStart(2, "0")}m`
}

/**
 * `$0.031`, `$2.94`. Three decimals below a dollar because sub-cent journeys are
 * the common case and `$0.03` throws away the difference between two of them;
 * two decimals above, where the third digit is noise.
 *
 * `null` is "no span carried a cost attribute" — never `$0.00`.
 */
export function formatCost(cost: number | null): string | null {
	if (cost == null || !Number.isFinite(cost)) return null
	return cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(3)}`
}

/** The row's time slot: a wall clock for today's journeys, date-prefixed beyond
 *  it. Absolute rather than relative — a journey is read against the incident
 *  timeline someone already has open. */
export function formatJourneyClock(startTime: string, nowMs: number = Date.now()): string {
	const epochMs = toEpochMs(startTime)
	if (!Number.isFinite(epochMs)) return startTime
	const date = new Date(epochMs)
	const clock = date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	})
	const now = new Date(nowMs)
	const sameDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate()
	if (sameDay) return clock
	return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clock}`
}

export function absoluteTimestamp(startTime: string): string {
	const epochMs = toEpochMs(startTime)
	return Number.isFinite(epochMs) ? new Date(epochMs).toLocaleString() : startTime
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

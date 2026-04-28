export type TimeRangeKey = "1h" | "24h" | "7d" | "30d"

export function formatForTinybird(date: Date): string {
	return date.toISOString().replace("T", " ").slice(0, 19)
}

export function getTimeRange(shorthand: TimeRangeKey): { startTime: string; endTime: string } {
	const now = new Date()
	const msMap: Record<TimeRangeKey, number> = {
		"1h": 60 * 60 * 1000,
		"24h": 24 * 60 * 60 * 1000,
		"7d": 7 * 24 * 60 * 60 * 1000,
		"30d": 30 * 24 * 60 * 60 * 1000,
	}
	const start = new Date(now.getTime() - msMap[shorthand])
	return {
		startTime: formatForTinybird(start),
		endTime: formatForTinybird(now),
	}
}

export function getPreviousTimeRange(shorthand: TimeRangeKey): { startTime: string; endTime: string } {
	const msMap: Record<TimeRangeKey, number> = {
		"1h": 60 * 60 * 1000,
		"24h": 24 * 60 * 60 * 1000,
		"7d": 7 * 24 * 60 * 60 * 1000,
		"30d": 30 * 24 * 60 * 60 * 1000,
	}
	const rangeMs = msMap[shorthand]
	const now = new Date()
	const currentStart = new Date(now.getTime() - rangeMs)
	const prevStart = new Date(currentStart.getTime() - rangeMs)
	return {
		startTime: formatForTinybird(prevStart),
		endTime: formatForTinybird(currentStart),
	}
}

const TARGET_POINTS = 30
const AUTO_BUCKET_LADDER = [300, 900, 1800, 3600, 14400, 86400] as const

export function computeBucketSeconds(startTime: string, endTime: string): number {
	const startMs = new Date(startTime.replace(" ", "T") + "Z").getTime()
	const endMs = new Date(endTime.replace(" ", "T") + "Z").getTime()
	if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
		return 300
	}

	const rangeSeconds = Math.max((endMs - startMs) / 1000, 1)
	const raw = Math.ceil(rangeSeconds / TARGET_POINTS)
	return AUTO_BUCKET_LADDER.reduce((best, candidate) => {
		return Math.abs(candidate - raw) < Math.abs(best - raw) ? candidate : best
	}, AUTO_BUCKET_LADDER[0])
}

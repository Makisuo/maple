export function formatDuration(ms: number): string {
	if (ms < 1) {
		return `${(ms * 1000).toFixed(0)}μs`
	}
	if (ms < 1000) {
		return `${ms.toFixed(1)}ms`
	}
	return `${(ms / 1000).toFixed(2)}s`
}

const TINYBIRD_UTC_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/

function normalizeTimestamp(value: string): string {
	const match = TINYBIRD_UTC_PATTERN.exec(value.trim())
	if (!match) return value
	const [, date, time, frac] = match
	if (!frac) return `${date}T${time}Z`
	return `${date}T${time}.${frac.slice(0, 3).padEnd(3, "0")}Z`
}

export function formatLogTimestamp(iso: string): string {
	const d = new Date(normalizeTimestamp(iso))
	if (Number.isNaN(d.getTime())) return iso
	return d.toISOString().slice(11, 23) // "HH:MM:SS.mmm"
}

export function formatRelativeTime(iso: string): string {
	const diff = Date.now() - new Date(normalizeTimestamp(iso)).getTime()
	if (diff < 0) return "just now"
	const seconds = Math.floor(diff / 1000)
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}

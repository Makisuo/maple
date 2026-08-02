export function formatUsage(gb: number): string {
	if (gb === 0) return "0 GB"
	if (gb < 1) return `${(gb * 1000).toFixed(2)} MB`
	return `${gb.toFixed(2)} GB`
}

/** Format a raw count for display: "0", "1,234", "1,200,000". */
export function formatCount(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString("en-US")
}

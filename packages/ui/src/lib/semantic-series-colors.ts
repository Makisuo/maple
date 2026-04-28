const SPAN_STATUS_COLORS: Record<string, string> = {
	ok: "var(--severity-info)",
	error: "var(--severity-error)",
	unset: "var(--muted-foreground)",
}

const SEVERITY_COLORS: Record<string, string> = {
	trace: "var(--severity-trace)",
	debug: "var(--severity-debug)",
	info: "var(--severity-info)",
	warn: "var(--severity-warn)",
	warning: "var(--severity-warn)",
	fatal: "var(--severity-fatal)",
}

const HTTP_METHOD_COLORS: Record<string, string> = {
	get: "#4A9EFF",
	post: "#E8872B",
	put: "#4AA865",
	patch: "#8A7F72",
	delete: "#E85D4A",
	head: "#8A7F72",
	options: "#5A5248",
}

// Base OKLCH parameters for each status code class
// Each individual code gets a unique variation within its class
const STATUS_CLASS_BASES: Record<number, { l: number; c: number; h: number }> = {
	2: { l: 0.696, c: 0.17, h: 162 }, // green (matches --severity-info)
	3: { l: 0.62, c: 0.14, h: 250 }, // blue (matches --chart-p50)
	4: { l: 0.769, c: 0.188, h: 70 }, // amber (matches --severity-warn)
	5: { l: 0.637, c: 0.237, h: 25 }, // red (matches --severity-error)
}

function getHttpStatusColor(code: number): string | null {
	const classDigit = Math.floor(code / 100)
	const base = STATUS_CLASS_BASES[classDigit]
	if (!base) return null

	// For class labels (2xx, 3xx) use the base color directly
	if (code % 100 === 0 && code === classDigit * 100) return statusOklch(base, 0)

	// Vary lightness and hue slightly per individual code within the class
	const offset = code % 100
	return statusOklch(base, offset)
}

function statusOklch(base: { l: number; c: number; h: number }, offset: number): string {
	// Shift lightness ±0.06 and hue ±12° based on the last two digits
	const lShift = (((offset * 7) % 13) - 6) * 0.01 // -0.06 to +0.06
	const hShift = ((offset * 11) % 25) - 12 // -12 to +12 degrees
	const l = Math.min(0.85, Math.max(0.45, base.l + lShift))
	const h = base.h + hShift
	return `oklch(${l.toFixed(3)} ${base.c} ${h.toFixed(1)})`
}

const STATUS_CLASS_PATTERN = /^([1-5])xx$/i

function detectColor(key: string): string | null {
	const lower = key.toLowerCase()

	// Span status codes
	if (lower in SPAN_STATUS_COLORS) return SPAN_STATUS_COLORS[lower]

	// Log severities (skip "error" since it's already matched by span status)
	if (lower in SEVERITY_COLORS) return SEVERITY_COLORS[lower]

	// HTTP methods
	if (lower in HTTP_METHOD_COLORS) return HTTP_METHOD_COLORS[lower]

	// HTTP status code classes (e.g., "2xx", "5xx")
	const classMatch = key.match(STATUS_CLASS_PATTERN)
	if (classMatch) {
		const classDigit = Number(classMatch[1])
		const base = STATUS_CLASS_BASES[classDigit]
		if (base) return statusOklch(base, 0)
	}

	// Individual HTTP status codes (e.g., "200", "404", "500")
	if (/^\d{3}$/.test(key)) {
		return getHttpStatusColor(Number(key))
	}

	return null
}

/**
 * Detect a semantic color for a chart series key based on known patterns
 * (span status codes, log severities, HTTP methods, HTTP status codes).
 * Returns a CSS color value or null if no pattern matches.
 */
export function getSemanticSeriesColor(seriesKey: string): string | null {
	const trimmed = seriesKey.trim()
	if (!trimmed) return null

	// Try direct match first
	const direct = detectColor(trimmed)
	if (direct) return direct

	// Try stripping multi-query prefix (e.g., "A: Error" → "Error")
	const colonIndex = trimmed.indexOf(": ")
	if (colonIndex > 0) {
		return detectColor(trimmed.slice(colonIndex + 2).trim())
	}

	return null
}

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
	// offset === 0 means the literal class label (e.g. "200" or "2xx") — use the
	// base color directly so it matches its --severity-* CSS variable exactly.
	// Otherwise shift lightness ±0.06 and hue ±12° based on the last two digits
	// to keep individual codes within a class visually distinct.
	if (offset === 0) {
		return `oklch(${base.l.toFixed(3)} ${base.c} ${base.h.toFixed(1)})`
	}
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

/** The five theme-aware named chart colors (light/dark variants live in CSS). */
const NAMED_CHART_COLORS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
] as const

// Golden angle (≈137.508°) maximizes hue separation between consecutive indices.
const GOLDEN_ANGLE = 137.508

/**
 * Resolve a perceptually-distinct color for the Nth series in a chart, with no
 * upper bound on the number of series. Indices 0–4 use the theme-aware
 * `--chart-1..5` CSS variables; beyond that we synthesize OKLCH colors by
 * rotating the hue by the golden angle and alternating lightness in "rings",
 * so even 50 series stay visually separable. Mid-tone L/C keeps the generated
 * colors legible on both light and dark backgrounds (mirrors
 * {@link getServiceColor} in `colors.ts`).
 */
export function getSeriesColorByIndex(index: number): string {
	const i = Math.max(0, Math.floor(index))
	if (i < NAMED_CHART_COLORS.length) return NAMED_CHART_COLORS[i]

	const offset = i - NAMED_CHART_COLORS.length
	const hue = (offset * GOLDEN_ANGLE) % 360
	// Alternate lightness every full turn so colors that land on a similar hue
	// after wrapping 360° are still distinguishable by brightness.
	const ring = Math.floor((offset * GOLDEN_ANGLE) / 360)
	const lightness = ring % 2 === 0 ? 0.66 : 0.56
	return `oklch(${lightness.toFixed(3)} 0.15 ${hue.toFixed(1)})`
}

/**
 * Resolve the color for a chart series: a semantic color when the series name
 * matches a known pattern (status code, severity, HTTP method/code), otherwise
 * a stable per-index color from {@link getSeriesColorByIndex}.
 */
export function resolveSeriesColor(name: string, index: number): string {
	return getSemanticSeriesColor(name) ?? getSeriesColorByIndex(index)
}

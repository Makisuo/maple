import { getIdentityColorBySlot, getIdentitySlot, IDENTITY_SLOT_COUNT } from "./colors"
import { HTTP_METHOD_HEX } from "./http"
import { SEVERITY_COLORS } from "./severity"

const SPAN_STATUS_COLORS: Record<string, string> = {
	ok: "var(--severity-info)",
	error: "var(--severity-error)",
	unset: "var(--muted-foreground)",
} satisfies Record<string, string>

const AGGREGATE_COLORS: Record<string, string> = {
	p50: "var(--chart-p50)",
	median: "var(--chart-p50)",
	p95: "var(--chart-p95)",
	p99: "var(--chart-p99)",
} satisfies Record<string, string>

// Base OKLCH parameters for each status code class
// Each individual code gets a unique variation within its class
const STATUS_CLASS_BASES: Record<number, { l: number; c: number; h: number }> = {
	1: { l: 0.62, c: 0.04, h: 265 }, // low-chroma slate — informational, reads as background
	2: { l: 0.696, c: 0.17, h: 162 }, // green (matches --severity-info)
	3: { l: 0.62, c: 0.14, h: 250 }, // blue (matches --chart-p50)
	4: { l: 0.769, c: 0.188, h: 70 }, // amber (matches --severity-warn)
	5: { l: 0.637, c: 0.237, h: 25 }, // red (matches --severity-error)
} satisfies Record<number, { l: number; c: number; h: number }>

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

	// Span status codes ("error" is matched here, before the severity map)
	if (lower in SPAN_STATUS_COLORS) return SPAN_STATUS_COLORS[lower]

	// Log severities — the shared uppercase-keyed map from ./severity
	const severity = SEVERITY_COLORS[lower.toUpperCase()]
	if (severity) return severity

	// HTTP methods
	const method = HTTP_METHOD_HEX[lower.toUpperCase()]
	if (method) return method

	// Latency percentiles — these have dedicated chart tokens
	if (lower in AGGREGATE_COLORS) return AGGREGATE_COLORS[lower]

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

	const direct = detectColor(trimmed)
	if (direct) return direct

	const colonIndex = trimmed.indexOf(": ")
	if (colonIndex > 0) {
		return detectColor(trimmed.slice(colonIndex + 2).trim())
	}

	return null
}

/** The default color for a chart that plots a single, unnamed value. */
const SINGLE_SERIES_COLOR = "var(--chart-1)"

/**
 * Placeholder names an ungrouped query uses for its one series — the warehouse
 * emits `groupName = 'all'`, the infra charts use `value`. These are not
 * identities, so they take the default chart color instead of a hashed hue.
 * A series named for a real thing always hashes, even when it is the only one
 * on screen: it must keep its color when a wider time range adds neighbors.
 */
const GENERIC_SERIES_NAMES = new Set(["all", "value", "count", "total", "__total__", "series"])

// Coprime with IDENTITY_SLOT_COUNT (48), so probing walks every slot before
// repeating and each step lands on a distant hue rather than the neighbor.
const COLLISION_PROBE_STRIDE = 7

/**
 * Resolve colors for every series in a chart at once.
 *
 * The result depends only on the *set* of series names — never on their order,
 * their count, or the selected time range. That is the whole point: widening a
 * time range pulls in more services, and a service must keep its color when it
 * does. Colors also match {@link getServiceColor}, so a service's line, its
 * `ServiceDot`, and its service-map node all agree.
 *
 * 1. A semantic name (span status, log severity, HTTP method/code, percentile)
 *    keeps its meaningful color and never consumes an identity slot.
 * 2. A generic placeholder name gets `--chart-1` — hashing a series called
 *    "value" into an arbitrary hue helps no one.
 * 3. Everything else hashes into the identity palette. Names are assigned in
 *    sorted order and a taken slot probes forward, so two services in one chart
 *    never share a color.
 */
export function resolveSeriesColors(names: readonly string[]): Map<string, string> {
	const colors = new Map<string, string>()
	const identityNames: string[] = []

	for (const name of names) {
		if (colors.has(name)) continue
		const semantic = getSemanticSeriesColor(name)
		if (semantic) {
			colors.set(name, semantic)
		} else if (GENERIC_SERIES_NAMES.has(name.trim().toLowerCase())) {
			colors.set(name, SINGLE_SERIES_COLOR)
		} else {
			identityNames.push(name)
		}
	}

	// Sorted, so the assignment depends on the set of names and nothing else.
	const takenSlots = new Set<number>()
	for (const name of [...identityNames].sort((a, b) => a.localeCompare(b))) {
		let slot = getIdentitySlot(name)
		for (let probe = 0; probe < IDENTITY_SLOT_COUNT && takenSlots.has(slot); probe++) {
			slot = (slot + COLLISION_PROBE_STRIDE) % IDENTITY_SLOT_COUNT
		}
		takenSlots.add(slot)
		colors.set(name, getIdentityColorBySlot(slot))
	}

	return colors
}

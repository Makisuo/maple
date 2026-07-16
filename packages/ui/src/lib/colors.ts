/**
 * Chart color Tailwind classes for depth-based coloring in visualizations.
 * Maps to Tailwind classes: bg-chart-1 through bg-chart-5
 */
export const CHART_BG_CLASSES = [
	"bg-chart-1",
	"bg-chart-2",
	"bg-chart-3",
	"bg-chart-4",
	"bg-chart-5",
] as const

/**
 * Get a chart background color class based on depth level.
 * Cycles through chart-1 to chart-5 based on depth % 5.
 */
export function getDepthColorClass(depth: number): string {
	return CHART_BG_CLASSES[depth % CHART_BG_CLASSES.length]
}

/**
 * Simple hash function for strings
 */
function hashString(str: string): number {
	let hash = 0
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash)
	}
	return Math.abs(hash)
}

/**
 * Base hues for services - warm to cool spectrum
 * Using OKLCH for perceptually uniform colors
 */
const SERVICE_HUES = [
	250, // Blue
	185, // Teal
	155, // Green
	130, // Lime
	90, // Yellow
	60, // Amber
	45, // Orange
	25, // Red
	0, // Rose
	340, // Pink
	320, // Magenta
	290, // Purple
	270, // Violet
	260, // Indigo
	210, // Cyan
	230, // Slate
]

/**
 * Extract class name from span name pattern "Class.FunctionName" or "Class::FunctionName"
 */
export function extractClassName(spanName: string): string | null {
	// Match patterns like "Class.Method", "Namespace.Class.Method", "Class::Method"
	const dotMatch = spanName.match(/^(.+?)\.[\w]+$/)
	if (dotMatch) {
		return dotMatch[1]
	}
	const colonMatch = spanName.match(/^(.+?)::[\w]+$/)
	if (colonMatch) {
		return colonMatch[1]
	}
	return null
}

/**
 * Get the hue for a service, derived purely from a hash of its name so a
 * service keeps the same hue everywhere in the product (lists, timelines,
 * service map) regardless of which other services are on screen.
 */
export function getServiceHueFromName(serviceName: string): number {
	return SERVICE_HUES[hashString(serviceName) % SERVICE_HUES.length]
}

/**
 * Lightness/chroma tiers layered on top of the 16 hues. A second hash
 * dimension picks the tier, tripling the palette to 48 slots so services
 * that land on neighboring hues (teal/cyan, blue/violet, …) still separate
 * by depth. All tiers stay mid-lightness so they read on both themes.
 */
const SERVICE_COLOR_TIERS = [
	{ l: 0.47, c: 0.17 },
	{ l: 0.57, c: 0.15 },
	{ l: 0.67, c: 0.12 },
]

function getServiceColorTier(serviceName: string): { l: number; c: number } {
	const hash = hashString(serviceName)
	return SERVICE_COLOR_TIERS[
		Math.floor(hash / SERVICE_HUES.length) % SERVICE_COLOR_TIERS.length
	]
}

/**
 * The canonical color for a service, deterministic from its name alone.
 * Hue and lightness tier both derive from the name hash.
 */
export function getServiceColor(serviceName: string): string {
	const tier = getServiceColorTier(serviceName)
	return `oklch(${tier.l} ${tier.c} ${getServiceHueFromName(serviceName)})`
}

/**
 * Get a color style for a span based on its service and class name.
 * - Each service gets a distinct base hue
 * - Each class within a service gets a lightness/saturation variation
 * - Returns inline style object with background color and appropriate text color
 */
export function getSpanColorStyle(spanName: string, serviceName: string): React.CSSProperties {
	const baseHue = getServiceHueFromName(serviceName)

	// Extract class name for variation within service
	const className = extractClassName(spanName)

	// Calculate lightness and chroma variations based on class
	let lightness = 0.55
	let chroma = 0.15

	if (className) {
		const classHash = hashString(className)
		// Vary lightness between 0.45 and 0.65
		lightness = 0.45 + (classHash % 20) / 100
		// Vary chroma between 0.12 and 0.18
		chroma = 0.12 + (classHash % 6) / 100
	}

	const bgColor = `oklch(${lightness} ${chroma} ${baseHue})`

	// Determine text color based on lightness
	const textColor = lightness > 0.55 ? "oklch(0.2 0 0)" : "oklch(0.98 0 0)"

	return {
		backgroundColor: bgColor,
		color: textColor,
	}
}

/**
 * Get a border accent color for a service (slightly darker/more saturated than background)
 */
export function getServiceBorderColor(serviceName: string): string {
	const tier = getServiceColorTier(serviceName)
	return `oklch(${tier.l - 0.08} ${tier.c + 0.02} ${getServiceHueFromName(serviceName)})`
}

/**
 * Resolve a hue for a string value, used to color trace timeline bars by
 * an arbitrary attribute. Returns null for empty/missing values so callers
 * can render a neutral fallback. Shares hues with getServiceColor.
 */
export function getValueHue(value: string | undefined | null): number | null {
	if (value == null || value === "") return null
	return SERVICE_HUES[hashString(value) % SERVICE_HUES.length]
}

/**
 * Calculate self-time for a span (duration minus overlapping children time)
 */
export function calculateSelfTime(
	span: { startTime: string; durationMs: number },
	children: Array<{ startTime: string; durationMs: number }>,
): number {
	if (children.length === 0) return span.durationMs

	const spanStartMs = new Date(span.startTime).getTime()
	const spanEndMs = spanStartMs + span.durationMs

	// Calculate total time covered by children (accounting for overlaps)
	const childIntervals = children
		.map((child) => {
			const childStartMs = new Date(child.startTime).getTime()
			const childEndMs = childStartMs + child.durationMs
			// Clamp to parent span boundaries
			return {
				start: Math.max(childStartMs, spanStartMs),
				end: Math.min(childEndMs, spanEndMs),
			}
		})
		.filter((i) => i.end > i.start)

	if (childIntervals.length === 0) return span.durationMs

	// Merge overlapping intervals
	childIntervals.sort((a, b) => a.start - b.start)
	const merged: Array<{ start: number; end: number }> = []

	for (const interval of childIntervals) {
		if (merged.length === 0 || merged[merged.length - 1].end < interval.start) {
			merged.push({ ...interval })
		} else {
			merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, interval.end)
		}
	}

	const childrenTime = merged.reduce((sum, i) => sum + (i.end - i.start), 0)
	return Math.max(0, span.durationMs - childrenTime)
}

import { getServiceHueFromName } from "@maple/ui/lib/colors"
import type { ServicePlatform } from "@/api/warehouse/service-map"
import type { Node3D } from "./fixture"

/**
 * Colors for the 3D lab, resolved to plain sRGB hex.
 *
 * The 2D map hands CSS strings (`oklch(...)`, `var(--severity-error)`) to the
 * DOM and lets the browser resolve them. `THREE.Color` parses neither, and a
 * WebGL material needs a number now — so the same semantics (service hue hash,
 * severity thresholds, platform palette) are re-stated here against a local
 * OKLCH→sRGB conversion rather than smuggled through `getComputedStyle`.
 */

const cube = (value: number): number => value * value * value

/** OKLCH → sRGB hex. Out-of-gamut channels clamp, which is fine for accent colors. */
export function oklchToHex(l: number, c: number, hDeg: number): string {
	const h = (hDeg * Math.PI) / 180
	const a = c * Math.cos(h)
	const b = c * Math.sin(h)

	const lp = cube(l + 0.3963377774 * a + 0.2158037573 * b)
	const mp = cube(l - 0.1055613458 * a - 0.0638541728 * b)
	const sp = cube(l - 0.0894841775 * a - 1.291485548 * b)

	const linear = [
		4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp,
		-1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp,
		-0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp,
	]

	const channels = linear.map((v) => {
		const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055
		return Math.round(Math.min(1, Math.max(0, encoded)) * 255)
	})

	return `#${channels.map((v) => v.toString(16).padStart(2, "0")).join("")}`
}

export type ColorMode3D = "service" | "health" | "platform"

/** Mirrors `--severity-{info,warn,error}` in packages/ui/src/styles/tokens.css. */
const SEVERITY = {
	info: oklchToHex(0.696, 0.17, 162.48),
	warn: oklchToHex(0.769, 0.188, 70.08),
	error: oklchToHex(0.637, 0.237, 25.331),
} as const

/** Mirrors `PLATFORM_COLORS` in service-map-utils.ts. */
const PLATFORM = {
	kubernetes: oklchToHex(0.62, 0.16, 250),
	cloudflare: oklchToHex(0.7, 0.16, 50),
	lambda: oklchToHex(0.7, 0.18, 60),
	web: oklchToHex(0.65, 0.15, 145),
	unknown: oklchToHex(0.62, 0.03, 270),
} satisfies Record<ServicePlatform, string>

/**
 * Data-store brand hues, keyed by `db.system` / messaging system.
 *
 * A Map rather than an object: the key space is whatever `db.system` a span
 * carries, so the lookup is genuinely open and `get` returning `undefined` is
 * the honest signature for it.
 */
const SYSTEM_HUES = new Map<string, number>([
	["postgresql", 250],
	["mysql", 220],
	["clickhouse", 95],
	["redis", 25],
	["opensearch", 300],
	["kafka", 320],
	["sqs", 60],
])

export const healthColor = (errorRate: number): string =>
	errorRate > 0.05 ? SEVERITY.error : errorRate > 0.01 ? SEVERITY.warn : SEVERITY.info

const systemColor = (system: string | undefined): string =>
	oklchToHex(0.68, 0.14, SYSTEM_HUES.get(system ?? "") ?? 270)

const EXTERNAL_COLOR = oklchToHex(0.72, 0.05, 280)

/**
 * A node's accent color. Stores and third parties keep their identity color in
 * every mode — the "color by" control slices services, same as the 2D map.
 */
export function nodeColor(node: Node3D, mode: ColorMode3D): string {
	if (node.kind === "database" || node.kind === "queue") return systemColor(node.system)
	if (node.kind === "external") return EXTERNAL_COLOR
	switch (mode) {
		case "health":
			return healthColor(node.errorRate)
		case "platform":
			return PLATFORM[node.platform]
		default:
			return oklchToHex(0.7, 0.15, getServiceHueFromName(node.label))
	}
}

/** Pipe color: healthy pipes take the source's identity, hot ones bleed to red. */
export function edgeColor(errorRate: number, sourceColor: string): string {
	if (errorRate > 0.02) return SEVERITY.error
	if (errorRate > 0.01) return SEVERITY.warn
	return sourceColor
}

export const NAMESPACE_COLORS = (namespace: string): string =>
	oklchToHex(0.66, 0.11, getServiceHueFromName(namespace))

import type { PlotColorToken } from "@maple/ui/components/plot/theme"

/**
 * Sequential colour scales for the TanStack charts spike.
 *
 * ## Why this file exists at all
 *
 * `@tanstack/charts-scales@0.14.0` ships **band / linear / ordinal / point only** —
 * there is no colour scale in the package. The documented escape hatch is a d3
 * colour scale (`ChartColorOptions.scale` is typed as `ConfiguredColorScaleLike`,
 * which is exactly d3's shape).
 *
 * **`d3-scale` and `d3-interpolate` do not resolve from `apps/web`.** They are
 * `devDependencies` of `@tanstack/charts-scales` (it inlines the kernels it needs
 * at build time) and appear in `node_modules/.bun/` only via Recharts' own tree —
 * neither `Bun.resolveSync` nor `require.resolve` finds them from this package, and
 * adding the dependency was explicitly out of scope. So the scale is hand-rolled
 * here against the `ConfiguredColorScaleLike` contract instead.
 *
 * That contract is small and fully documented by the runtime (`dist/scales.js`):
 * a **configured** (non-factory) colour scale is any callable carrying `copy()`,
 * and `createColorScale` then reads `domain()` / `range()` off it and never infers.
 * Exposing `ticks` — and *not* `quantiles` / `thresholds` / `invertExtent` — makes
 * `colorScaleKind()` classify it `"continuous"`, which is the branch
 * `colorGradientLegend` renders.
 *
 * ## Why the interpolation is hand-rolled too
 *
 * Even with d3 present it could not have consumed the palette directly: the stops
 * live in `tokens.css` as `--heatmap-<name>-0..4`, and d3's interpolators parse
 * colours with `d3-color`, which cannot read `var(--token)` — it yields `NaN`
 * channels and renders black. Every stop is resolved to an `oklch(...)` literal
 * with `resolvePlotColor` *before* it reaches the ramp.
 *
 * The production heatmap
 * (`packages/ui/src/components/charts/heatmap/query-builder-heatmap-chart.tsx`)
 * blends flanking stops with CSS `color-mix(in oklch, …)` and lets the browser do
 * the mixing. Canvas takes literal colours, so that trick is unavailable to a
 * shared chart definition — `mixOklch` below reproduces `color-mix(in oklch, …)`
 * numerically: componentwise on L and C, shorter-arc on H, which is what the CSS
 * Color 4 `oklch` interpolation rule specifies.
 */

/** How a value's position along the ramp is computed. */
export type SequentialScaleType = "linear" | "log"

/**
 * The five-stop amber ramp, byte-for-byte the tokens the production heatmap uses.
 * Both light and dark are defined in `tokens.css`, and the ramp inverts between
 * them, so this has to be resolved through `usePlotColors` (which re-resolves on a
 * theme flip) rather than read once.
 */
export const HEATMAP_RAMP_TOKENS = {
	s0: ["--heatmap-amber-0", "oklch(0.32 0.035 70)"],
	s1: ["--heatmap-amber-1", "oklch(0.45 0.075 65)"],
	s2: ["--heatmap-amber-2", "oklch(0.58 0.115 60)"],
	s3: ["--heatmap-amber-3", "oklch(0.71 0.15 57)"],
	s4: ["--heatmap-amber-4", "oklch(0.85 0.13 78)"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/** The blue ramp, for the scatter density so the two spikes are distinguishable. */
export const DENSITY_RAMP_TOKENS = {
	s0: ["--heatmap-blues-0", "oklch(0.3 0.04 250)"],
	s1: ["--heatmap-blues-1", "oklch(0.43 0.09 250)"],
	s2: ["--heatmap-blues-2", "oklch(0.56 0.13 248)"],
	s3: ["--heatmap-blues-3", "oklch(0.69 0.15 240)"],
	s4: ["--heatmap-blues-4", "oklch(0.84 0.12 220)"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

export type RampKey = "s0" | "s1" | "s2" | "s3" | "s4"

const RAMP_KEYS: readonly RampKey[] = ["s0", "s1", "s2", "s3", "s4"]

/** Flatten a `usePlotColors` result back into ordered ramp stops. */
export function rampStops(colors: Readonly<Record<RampKey, string>>): readonly string[] {
	return RAMP_KEYS.map((key) => colors[key])
}

interface Oklch {
	l: number
	c: number
	h: number
}

const OKLCH_RE = /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([-\d.]+)/i

function parsePercentOrUnit(raw: string, full: number): number {
	return raw.endsWith("%") ? (Number.parseFloat(raw) / 100) * full : Number.parseFloat(raw)
}

/**
 * Parse the two literal forms a resolved token can take here: an `oklch()` string
 * (what `tokens.css` actually holds) or a hex fallback. Anything else — a named
 * colour, `rgb()`, an unresolved `var()` — returns `null`, and the ramp falls back
 * to returning the stop verbatim rather than emitting a black `NaN` colour, which
 * is the exact failure mode d3 would have had.
 */
function parseOklch(color: string): Oklch | null {
	const oklch = OKLCH_RE.exec(color.trim())
	if (oklch) {
		const l = parsePercentOrUnit(oklch[1], 1)
		const c = parsePercentOrUnit(oklch[2], 0.4)
		const h = Number.parseFloat(oklch[3])
		if (!Number.isFinite(l) || !Number.isFinite(c) || !Number.isFinite(h)) return null
		return { l, c, h }
	}
	return parseHexToOklch(color.trim())
}

function srgbToLinear(channel: number): number {
	return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function parseHexToOklch(color: string): Oklch | null {
	if (!color.startsWith("#")) return null
	const body = color.slice(1)
	const expanded =
		body.length === 3 ? `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}` : body.slice(0, 6)
	if (expanded.length !== 6) return null
	const int = Number.parseInt(expanded, 16)
	if (!Number.isFinite(int)) return null

	const r = srgbToLinear(((int >> 16) & 0xff) / 255)
	const g = srgbToLinear(((int >> 8) & 0xff) / 255)
	const b = srgbToLinear((int & 0xff) / 255)

	// sRGB-linear → LMS → Oklab, the standard matrices from Björn Ottosson's
	// Oklab derivation. Only used for hex fallbacks; the real tokens are oklch().
	const lms0 = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
	const lms1 = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
	const lms2 = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

	const l = 0.2104542553 * lms0 + 0.793617785 * lms1 - 0.0040720468 * lms2
	const a = 1.9779984951 * lms0 - 2.428592205 * lms1 + 0.4505937099 * lms2
	const bb = 0.0259040371 * lms0 + 0.7827717662 * lms1 - 0.808675766 * lms2

	return {
		l,
		c: Math.hypot(a, bb),
		h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360,
	}
}

function formatOklch({ l, c, h }: Oklch): string {
	return `oklch(${l.toFixed(4)} ${c.toFixed(4)} ${h.toFixed(2)})`
}

/**
 * Numeric equivalent of `color-mix(in oklch, low <1-t>, high <t>)`: L and C mix
 * componentwise, H takes the shorter arc around the hue circle. Emitting the
 * result as an `oklch()` literal (rather than converting down to hex) keeps it
 * identical to what the browser computes for the CSS form — and both renderers
 * accept it, canvas included, the same way `usePlotColors`' `--chart-*` literals
 * already reach `fillStyle` today.
 */
function mixOklch(low: Oklch, high: Oklch, t: number): Oklch {
	let delta = high.h - low.h
	if (delta > 180) delta -= 360
	if (delta < -180) delta += 360
	return {
		l: low.l + (high.l - low.l) * t,
		c: low.c + (high.c - low.c) * t,
		h: (low.h + delta * t + 360) % 360,
	}
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0
	return Math.max(0, Math.min(1, value))
}

/** Parametric position 0..1 → literal colour, along the resolved stops. */
function colorAt(t: number, stops: readonly string[], parsed: readonly (Oklch | null)[]): string {
	const clamped = clamp01(t)
	const segments = stops.length - 1
	if (segments <= 0) return stops[0] ?? "currentColor"
	const scaled = clamped * segments
	const lowIndex = Math.min(segments - 1, Math.floor(scaled))
	const highIndex = lowIndex + 1
	const local = scaled - lowIndex
	if (local <= 0) return stops[lowIndex] ?? "currentColor"
	if (local >= 1) return stops[highIndex] ?? "currentColor"

	const low = parsed[lowIndex]
	const high = parsed[highIndex]
	// Unparseable stop: snap to the nearer endpoint rather than emit NaN channels.
	if (!low || !high) return (local < 0.5 ? stops[lowIndex] : stops[highIndex]) ?? "currentColor"
	return formatOklch(mixOklch(low, high, local))
}

/**
 * `log1p`-based normalize, identical to the production heatmap's. Not d3's
 * `scaleSequentialLog`, deliberately: that one is `log(v/min)/log(max/min)` and
 * throws on a domain touching zero, which every count-valued heatmap does.
 */
function normalize(value: number, min: number, span: number, scaleType: SequentialScaleType): number {
	if (span <= 0) return 0
	if (scaleType === "log") {
		const denominator = Math.log1p(span)
		return denominator > 0 ? Math.log1p(Math.max(0, value - min)) / denominator : 0
	}
	return (value - min) / span
}

/**
 * The shape `ChartColorOptions.scale` accepts as a *configured* scale.
 *
 * `copy()` is what marks it configured rather than a factory (`dist/scales.js`
 * branches on `!("copy" in source)`), so the runtime never tries to infer a domain
 * from the colour channel — the domain here is authoritative. `ticks` is present
 * purely so `colorScaleKind()` reports `"continuous"`; without it the scale is
 * classified categorical and `colorGradientLegend` throws.
 */
export interface SequentialColorScale {
	(value: number): string
	copy: () => SequentialColorScale
	domain: () => readonly number[]
	range: () => readonly string[]
	ticks: (count: number) => readonly number[]
}

export interface SequentialColorScaleOptions {
	/** Resolved literal colours, low → high. `var(--token)` will NOT work. */
	stops: readonly string[]
	/** `[min, max]` of the value channel. */
	domain: readonly [number, number]
	scaleType: SequentialScaleType
}

export function createSequentialColorScale(options: SequentialColorScaleOptions): SequentialColorScale {
	const { stops, scaleType } = options
	const [min, max] = options.domain
	const span = max - min
	const parsed = stops.map(parseOklch)

	const map = (value: number): string => colorAt(normalize(value, min, span, scaleType), stops, parsed)

	return Object.assign(map, {
		copy: () => createSequentialColorScale(options),
		domain: () => options.domain,
		range: () => stops,
		ticks: (count: number): readonly number[] =>
			Array.from({ length: Math.max(2, count) }, (_value, index) => {
				const t = index / (Math.max(2, count) - 1)
				return scaleType === "log" ? min + Math.expm1(t * Math.log1p(span)) : min + t * span
			}),
	})
}

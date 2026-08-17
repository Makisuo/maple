import type { PlotColorToken } from "@maple/ui/components/plot/theme"
import { scaleSequential, scaleSequentialLog, type ScaleSequentialBase } from "d3-scale"

/**
 * Sequential colour scales for the TanStack charts spike.
 *
 * ## The scale is d3's, exactly as the docs prescribe
 *
 * `@tanstack/charts-scales@0.14.0` ships **band / linear / ordinal / point only** —
 * there is no colour scale in the package. The documented escape hatch (the
 * Legends and Color guide) is a d3 sequential scale: `ChartColorOptions.scale` is
 * typed as `ConfiguredColorScaleLike`, which is exactly d3's shape, and `d3-scale`
 * is a direct dependency of `apps/web` (the trace scatter already hands `scaleLog`
 * to its y axis). So `createSequentialColorScale` below is a thin wrapper over
 * `scaleSequential` / `scaleSequentialLog` — the domain / ticks / copy plumbing
 * this file used to hand-roll is d3's problem again.
 *
 * Two runtime facts verified against `@tanstack/charts/dist` keep that safe:
 *
 * - **The legend still classifies it `"continuous"`.** `colorScaleKind()`
 *   (`dist/scales.js:135`) returns `"continuous"` for a scale exposing `ticks`
 *   and none of `quantiles` / `thresholds` / `invertExtent`. d3's `sequential()`
 *   is `linearish(...)` and `sequentialLog()` is `loggish(...)`
 *   (`d3-scale/src/sequential.js`), so both carry `ticks` / `tickFormat` / `nice`
 *   and nothing from the quantile/threshold families — `colorGradientLegend`
 *   renders. (Surprise: `@types/d3-scale`'s `ScaleSequentialBase` omits `ticks`
 *   entirely; classification is a runtime property probe, so the types are
 *   irrelevant to it.)
 * - **`copy()` marks it a configured instance, not a factory.**
 *   `isColorScaleFactory` is `!("copy" in source)` (`dist/scales.js:79`), and
 *   every d3 scale has `copy` — so the runtime takes the configured branch, treats
 *   the pinned domain as authoritative, and never infers one from the colour
 *   channel. That is precisely what both call sites want: the heatmap pins
 *   `[min, max]` it computed itself, and the trace scatter pins a fixed density
 *   estimate the transform makes unknowable (see `DENSITY_DOMAIN` there).
 *
 * ## Why the interpolator is still hand-rolled
 *
 * `scaleSequential` accepts any `(t: number) => string`, and d3's stock
 * interpolators cannot produce Maple's ramps: `d3-scale-chromatic` palettes are
 * fixed, and anything routed through `d3-color` chokes on `var(--token)` — `NaN`
 * channels, rendered black. The stops live in `tokens.css` as
 * `--heatmap-<name>-0..4` and are resolved to `oklch(...)` literals via
 * `usePlotColors` (re-resolved on theme flip) *before* they reach the ramp, so the
 * interpolator handed to d3 is a closure over resolved literals.
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

/**
 * Pushes a colour most of the way toward the page background, for the series a
 * legend is NOT highlighting.
 *
 * This has to be a colour and not an opacity, which is not a stylistic call.
 * `fillOpacity` and `strokeOpacity` are flat `number`s on every mark in the
 * package — `bar.d.ts`, `area.d.ts`, `polar.d.ts`, `hierarchy-treemap.d.ts` all
 * declare them that way, while `fill` and `stroke` are `VisualChannel`s. So a
 * chart that draws every series from ONE mark (a stacked bar's `z`, a treemap's
 * nodes, a pie's arcs) has no way to vary opacity per datum, and the only
 * per-datum dimming it can express is a dimmer colour.
 *
 * The charts drawing one mark per series (line, area) can and do use the flat
 * opacity instead — same picture, less arithmetic.
 *
 * `amount` is how far toward the background: 0 leaves the colour alone, 1 erases
 * it. Required rather than defaulted: every call site passes `MUTED_COLOR_AMOUNT`,
 * and a second number living here could only ever drift away from it.
 *
 * Both arguments must already be resolved literals; canvas cannot read a
 * `var(--…)`, which is the whole reason this file exists.
 */
export function muteColor(color: string, background: string, amount: number): string {
	const from = parseOklch(color)
	const to = parseOklch(background)
	// Unparseable input keeps its colour rather than silently going black, which
	// is the failure d3-color has here and the reason for the hex fallback above.
	if (!from || !to) return color
	return formatOklch(mixOklch(from, to, clamp01(amount)))
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

export interface SequentialColorScaleOptions {
	/** Resolved literal colours, low → high. `var(--token)` will NOT work. */
	stops: readonly string[]
	/** `[min, max]` of the value channel. */
	domain: readonly [number, number]
	scaleType: SequentialScaleType
}

/**
 * A log scale's transform is `Math.log`, so its domain cannot touch 0 — `log(0)`
 * is `-Infinity` and every value would map to the top stop. Both consumers are
 * count-valued (heatmap counts, hexbin counts), so a non-positive minimum is
 * floored at 1: with `clamp(true)` anything below the floor renders as the bottom
 * stop, which is what the old `log1p` normalize gave a zero-count as well.
 */
const LOG_DOMAIN_FLOOR = 1

export function createSequentialColorScale(
	options: SequentialColorScaleOptions,
): ScaleSequentialBase<string> {
	const { stops, scaleType } = options
	const [min, max] = options.domain
	const parsed = stops.map(parseOklch)

	// The theme-aware half: a closure over the resolved token literals, in the
	// `(t: number) => string` shape `scaleSequential` takes as its interpolator.
	// `colorAt` clamps `t` itself, so even an unclamped scale could not walk off
	// the ramp — but `clamp(true)` below is still load-bearing for `scale(x)`'s
	// *inputs*: d3 extrapolates past the domain by default, and the trace
	// scatter's fixed density estimate relies on out-of-domain counts saturating
	// the top stop rather than extrapolating (the hand-rolled scale clamped too).
	const interpolator = (t: number): string => colorAt(t, stops, parsed)

	// Both branches return configured d3 instances. `dist/scales.js:79` treats any
	// callable with `copy` as configured (never a factory), so the pinned domain
	// is authoritative and nothing is inferred from the colour channel.
	if (scaleType === "log") {
		return scaleSequentialLog(interpolator)
			.domain([Math.max(min, LOG_DOMAIN_FLOOR), max])
			.clamp(true)
	}
	return scaleSequential(interpolator).domain([min, max]).clamp(true)
}

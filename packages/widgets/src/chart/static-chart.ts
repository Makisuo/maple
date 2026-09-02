/**
 * Chart rendering with no DOM, no React and no chart library — for images that
 * are rasterised server-side and pasted into Slack, Discord or an email.
 *
 * Two things make this different from the interactive charts in `@maple/ui`:
 *
 *   - **It emits an SVG string, not elements.** The consumers are Workers, not
 *     browsers. `apps/web` rasterises the string with the takumi wasm it
 *     already ships for OG cards.
 *   - **It draws no text.** takumi decodes SVG through usvg, whose font
 *     database is separate from the one `Renderer.registerFont` populates, so
 *     every glyph inside an SVG image node renders as nothing — registering a
 *     font changes the output not at all (verified: byte-identical PNGs).
 *     Type has to be composed as takumi nodes *around* this SVG, so
 *     {@link renderPlotSvg} returns the strings to draw and where, and draws
 *     none of them itself.
 *
 * Fixed to the Maple dark theme: a PNG has no theme, and the product default
 * is dark. Colors are the `.dark` values from `styles/tokens.css`, converted
 * oklch → hex because usvg has no oklch parser.
 *
 * It lives in `@maple/widgets` rather than `@maple/ui` because both consumers
 * are Workers: `apps/api` needs {@link sparkline} for message text and
 * `apps/web` needs {@link renderPlotSvg} for the image. `@maple/ui` peer-depends
 * on react, react-dom and tailwind, and no Worker in this repo imports it.
 *
 * A near-identical renderer lives at `apps/slack-agent/agent/lib/chart.ts`.
 * That app is deliberately outside the workspace (`"!apps/slack-agent"` in the
 * root `workspaces`) and so cannot import this; it also rasterises with
 * `@resvg/resvg-js`, which *does* carry fonts, so it keeps drawing its own
 * text and does not want this module's split. Treat the two as siblings, not
 * as a copy to keep in sync.
 */

export type ChartKind = "line" | "area" | "bar"

export type ChartUnit = "number" | "percent" | "duration_ms" | "bytes" | "requests_per_sec"

/** `[epochMillis, value]`. Rendering sorts, so order is not a precondition. */
export type ChartPoint = readonly [number, number]

/** Which side of the threshold counts as breaching, for the shaded band. */
export type BreachSide = "above" | "below" | "none"

export interface StaticChartSpec {
	readonly title: string
	readonly kind: ChartKind
	readonly unit: ChartUnit
	readonly points: ReadonlyArray<ChartPoint>
	/** Drawn as a dashed rule. Omit for a chart with no threshold to show. */
	readonly threshold?: number | null
	/**
	 * Shades the breaching side of the threshold. `"none"` for comparators
	 * where "beyond" is not a half-plane (`between`, `eq`, …) — the rule still
	 * draws, the band does not.
	 */
	readonly breachSide?: BreachSide
}

/**
 * A string the caller must draw as its own text node, and where to put it.
 *
 * `yFraction` is a fraction of the plot height from the top, so a caller that
 * scales the SVG to a different box still lands the label on the rule.
 */
export interface PlotLabel {
	readonly text: string
	readonly yFraction: number
}

export interface PlotRender {
	/** Self-contained SVG, `PLOT_WIDTH`×`PLOT_HEIGHT` viewBox, no `<text>`. */
	readonly svg: string
	readonly title: string
	/** Latest value, formatted. The number the message is about. */
	readonly latest: string
	/** Threshold rule label, absent when the spec carries no threshold. */
	readonly threshold: PlotLabel | null
	/** Range ends, UTC. */
	readonly start: string
	readonly end: string
}

// Maple dark-theme tokens, oklch → hex (usvg has no oklch parser). Sources are
// the `.dark` values in `packages/ui/src/styles/tokens.css`.
const COLORS = {
	/** --card oklch(0.224 0.009 75) — charts sit on cards in the product. */
	surface: "#1e1b17",
	/** --border oklch(0.268 0.012 67); the grid uses it at 50% like the web. */
	border: "#2a2520",
	/** --destructive, for the threshold rule and its breach band. */
	danger: "#ef2e43",
} as const

/**
 * Series color per unit, mirroring the web dashboards' semantic tokens:
 * latency → --chart-p95 amber, throughput → --chart-throughput purple,
 * error-rate percent → --chart-error red, bytes → --chart-4 teal,
 * plain counts → --chart-p50 blue.
 */
const SERIES_COLORS: Record<ChartUnit, string> = {
	duration_ms: "#e8872a",
	requests_per_sec: "#9281e1",
	percent: "#ef2e43",
	bytes: "#00aa9a",
	number: "#4a9eff",
} satisfies Record<ChartUnit, string>

export const PLOT_WIDTH = 720
export const PLOT_HEIGHT = 280

// No PAD_LEFT for y-tick labels: this chart has none. The threshold rule
// carries the only value worth reading off an axis, and it is labelled
// directly. A small inset keeps the marks off the card's stroke.
const PAD = 12

// ── formatting ──────────────────────────────────────────────────────────────

const round = (n: number, digits = 1): string => {
	const s = n.toFixed(digits)
	return s.endsWith(".0") ? s.slice(0, -2) : s
}

/** Formats a value for labels, unit-aware. */
export function formatValue(value: number, unit: ChartUnit): string {
	switch (unit) {
		case "percent":
			return `${round(value, Math.abs(value) < 1 ? 2 : 1)}%`
		case "duration_ms":
			if (Math.abs(value) >= 60_000) return `${round(value / 60_000)} min`
			if (Math.abs(value) >= 1000) return `${round(value / 1000)} s`
			return `${round(value)} ms`
		case "bytes": {
			const abs = Math.abs(value)
			if (abs >= 1024 ** 3) return `${round(value / 1024 ** 3)} GiB`
			if (abs >= 1024 ** 2) return `${round(value / 1024 ** 2)} MiB`
			if (abs >= 1024) return `${round(value / 1024)} KiB`
			return `${round(value)} B`
		}
		case "requests_per_sec":
			return `${formatValue(value, "number")}/s`
		case "number": {
			const abs = Math.abs(value)
			if (abs >= 1_000_000) return `${round(value / 1_000_000)}M`
			if (abs >= 1000) return `${round(value / 1000)}k`
			return round(value, abs < 10 && !Number.isInteger(value) ? 1 : 0)
		}
	}
}

const pad2 = (n: number): string => String(n).padStart(2, "0")

export function formatTimestamp(ms: number, rangeMs: number): string {
	const d = new Date(ms)
	const hhmm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
	if (rangeMs <= 36 * 3_600_000) return hhmm
	return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hhmm}`
}

// ── scales ──────────────────────────────────────────────────────────────────

/** "Nice" tick values covering [0|min, max] — the grid, and the y domain. */
export function niceTicks(min: number, max: number, count = 4): number[] {
	const lo = Math.min(0, min)
	const hi = max <= lo ? lo + 1 : max
	const rawStep = (hi - lo) / count
	const mag = 10 ** Math.floor(Math.log10(rawStep))
	const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) ?? 10 * mag
	const ticks: number[] = []
	const start = Math.floor(lo / step) * step
	const end = Math.ceil(hi / step) * step
	for (let t = start; t <= end + step * 1e-9; t += step) {
		ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t)
	}
	return ticks
}

/**
 * At most `max` points, keeping the first and last and the most extreme value
 * in each stride.
 *
 * Averaging would be the obvious downsample and is the wrong one here: the
 * whole reason to look at an alert chart is to see the excursion, and a mean
 * is exactly the operation that hides it. Which extreme to keep follows the
 * breaching side, so a spike survives on a `gt` rule and a collapse survives
 * on a `lt` one.
 */
export function downsample(
	points: ReadonlyArray<ChartPoint>,
	max: number,
	breachSide: BreachSide = "above",
): ReadonlyArray<ChartPoint> {
	if (points.length <= max || max < 3) return points
	const sorted = [...points].sort((a, b) => a[0] - b[0])
	const first = sorted[0]
	const last = sorted.at(-1)
	// `points.length <= max` returned above and `max >= 3`, so both ends exist.
	if (first === undefined || last === undefined) return points
	const inner = sorted.slice(1, -1)
	const buckets = max - 2
	const size = Math.ceil(inner.length / buckets)
	const kept: ChartPoint[] = [first]
	for (let i = 0; i < inner.length; i += size) {
		const slice = inner.slice(i, i + size)
		if (slice.length === 0) continue
		const pick = slice.reduce((best, p) =>
			breachSide === "below" ? (p[1] < best[1] ? p : best) : p[1] > best[1] ? p : best,
		)
		kept.push(pick)
	}
	kept.push(last)
	return kept
}

// ── rendering ───────────────────────────────────────────────────────────────

/**
 * Plot geometry as an SVG string, plus the type the caller has to draw.
 *
 * Throws on an empty series: an alert chart with no points is a bug at the
 * call site, and silently returning an empty card would ship it to a customer.
 */
export function renderPlotSvg(spec: StaticChartSpec): PlotRender {
	const points = [...spec.points].sort((a, b) => a[0] - b[0])
	const firstPoint = points[0]
	const lastPoint = points.at(-1)
	if (firstPoint === undefined || lastPoint === undefined) {
		throw new Error("renderPlotSvg needs at least one data point.")
	}

	const threshold = spec.threshold ?? null
	const breachSide = spec.breachSide ?? "none"

	const values = points.map((p) => p[1])
	// The threshold joins the domain so its rule is always on the canvas — a
	// chart whose breach line sits off the top edge is worse than no chart.
	const domain = threshold === null ? values : [...values, threshold]
	const ticks = niceTicks(Math.min(...domain), Math.max(...domain))
	// `niceTicks` always returns at least a `[min, max]` pair.
	const yMin = ticks[0] ?? 0
	const yMax = ticks.at(-1) ?? yMin
	const tMin = firstPoint[0]
	const tMax = lastPoint[0]
	const tRange = Math.max(1, tMax - tMin)

	const plotW = PLOT_WIDTH - PAD * 2
	const plotH = PLOT_HEIGHT - PAD * 2
	const x = (t: number): number => PAD + ((t - tMin) / tRange) * plotW
	const y = (v: number): number => PAD + plotH - ((v - yMin) / Math.max(1e-9, yMax - yMin)) * plotH

	const series = SERIES_COLORS[spec.unit]
	const parts: string[] = []

	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}">`,
		// Card canvas: --radius 8px + hairline --border, like a dashboard widget.
		// Slack composes PNGs on light and dark backdrops alike; the border keeps
		// the card edge legible on both.
		`<rect x="0.5" y="0.5" width="${PLOT_WIDTH - 1}" height="${PLOT_HEIGHT - 1}" rx="8" fill="${COLORS.surface}" stroke="${COLORS.border}"/>`,
	)

	if (spec.kind === "area") {
		// Web charts fill areas with a vertical series gradient (VerticalGradient
		// in packages/ui, 0.8 → 0.1), not a flat tint.
		parts.push(
			`<defs><linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stop-color="${series}" stop-opacity="0.8"/><stop offset="95%" stop-color="${series}" stop-opacity="0.1"/></linearGradient></defs>`,
		)
	}

	// Recessive gridlines (border at 50%, matching the web's stroke-border/50;
	// the baseline gets the full border). No labels — see PAD.
	for (const tick of ticks) {
		const ty = y(tick)
		const isBaseline = tick === yMin
		parts.push(
			`<line x1="${PAD}" y1="${ty}" x2="${PLOT_WIDTH - PAD}" y2="${ty}" stroke="${COLORS.border}"${isBaseline ? "" : ' stroke-opacity="0.5"'} stroke-width="1"/>`,
		)
	}

	// Breach band under the threshold rule, so the eye finds the excursion
	// before it reads a single number.
	if (threshold !== null && breachSide !== "none") {
		const ty = y(threshold)
		const bandTop = breachSide === "above" ? PAD : ty
		const bandHeight = breachSide === "above" ? Math.max(0, ty - PAD) : Math.max(0, PAD + plotH - ty)
		if (bandHeight > 0) {
			parts.push(
				`<rect x="${PAD}" y="${bandTop.toFixed(1)}" width="${plotW}" height="${bandHeight.toFixed(1)}" fill="${COLORS.danger}" fill-opacity="0.06"/>`,
			)
		}
	}

	if (spec.kind === "bar") {
		// Band placement (bars imply regular buckets): each point owns a slot,
		// with a ≥2px surface gap between bars and no overflow past the plot.
		const slot = plotW / points.length
		const barW = Math.max(1, Math.min(slot - 2, 40))
		for (const [i, [, v]] of points.entries()) {
			const bx = PAD + slot * (i + 0.5) - barW / 2
			const by = y(Math.max(v, yMin))
			const bh = Math.max(1, y(yMin) - by)
			const r = Math.min(4, barW / 2, bh)
			parts.push(
				`<path d="M ${bx.toFixed(1)} ${(by + bh).toFixed(1)} V ${(by + r).toFixed(1)} Q ${bx.toFixed(1)} ${by.toFixed(1)} ${(bx + r).toFixed(1)} ${by.toFixed(1)} H ${(bx + barW - r).toFixed(1)} Q ${(bx + barW).toFixed(1)} ${by.toFixed(1)} ${(bx + barW).toFixed(1)} ${(by + r).toFixed(1)} V ${(by + bh).toFixed(1)} Z" fill="${series}"/>`,
			)
		}
	} else {
		const linePath = points
			.map(([t, v], i) => `${i === 0 ? "M" : "L"} ${x(t).toFixed(1)} ${y(v).toFixed(1)}`)
			.join(" ")
		if (spec.kind === "area") {
			parts.push(
				`<path d="${linePath} L ${x(tMax).toFixed(1)} ${y(yMin).toFixed(1)} L ${x(tMin).toFixed(1)} ${y(yMin).toFixed(1)} Z" fill="url(#areaFill)"/>`,
			)
		}
		parts.push(
			`<path d="${linePath}" fill="none" stroke="${series}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
		)
		// The latest value gets a dot with a 2px surface ring; its *number* is a
		// label the caller draws, because this SVG cannot.
		const [lt, lv] = lastPoint
		parts.push(
			`<circle cx="${x(lt).toFixed(1)}" cy="${y(lv).toFixed(1)}" r="4" fill="${series}" stroke="${COLORS.surface}" stroke-width="2"/>`,
		)
	}

	// Threshold rule last, so it reads above the marks.
	if (threshold !== null) {
		const ty = y(threshold)
		parts.push(
			`<line x1="${PAD}" y1="${ty.toFixed(1)}" x2="${PLOT_WIDTH - PAD}" y2="${ty.toFixed(1)}" stroke="${COLORS.danger}" stroke-width="1.5" stroke-dasharray="6 4"/>`,
		)
	}

	parts.push("</svg>")

	return {
		svg: parts.join("\n"),
		title: spec.title,
		latest: formatValue(lastPoint[1], spec.unit),
		threshold:
			threshold === null
				? null
				: { text: formatValue(threshold, spec.unit), yFraction: (y(threshold) - PAD) / plotH },
		start: formatTimestamp(tMin, tRange),
		end: `${formatTimestamp(tMax, tRange)} UTC`,
	}
}

// ── text-only fallback ──────────────────────────────────────────────────────

const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

/**
 * Unicode sparkline, for the places an image cannot go: a phone's lock screen,
 * a push preview, and every degrade path where rendering or the series read
 * failed. Downsamples to at most `maxBuckets` by averaging — unlike
 * {@link downsample}, this one is smoothing 24 glyphs, not a plot.
 */
export function sparkline(values: readonly number[], maxBuckets = 24): string {
	if (values.length === 0) return ""
	const buckets: number[] = []
	const size = Math.ceil(values.length / maxBuckets)
	for (let i = 0; i < values.length; i += size) {
		const slice = values.slice(i, i + size)
		buckets.push(slice.reduce((a, b) => a + b, 0) / slice.length)
	}
	const min = Math.min(...buckets)
	const max = Math.max(...buckets)
	const range = max - min
	return buckets
		.map((v) => {
			const idx =
				range === 0
					? 3
					: Math.min(SPARK_LEVELS.length - 1, Math.floor(((v - min) / range) * SPARK_LEVELS.length))
			return SPARK_LEVELS[idx]
		})
		.join("")
}

/**
 * Warns, in DEV, about a colour the canvas renderer cannot resolve.
 *
 * ## What it looks for
 *
 * Exactly one thing: a BARE custom-property token — `"--chart-p95"` — where a
 * colour belongs. `CanvasPaintResolver` (`@tanstack/charts/dist/canvas.js`)
 * resolves every paint by assigning it to a probe `<span>`'s `style.color` and
 * reading the computed value back; CSSOM rejects a bare token, the assignment
 * leaves `style.color` empty, and the resolver THROWS `Invalid Canvas paint`
 * mid-render. That is not a wrong colour, it is a dead widget: the throw escapes
 * to the nearest error boundary, which is how an unresolved token in a gradient
 * took a dashboard widget out in production. `resolvePlotColor` returns the
 * token unchanged whenever the property is missing from the computed style, so
 * this is a reachable state rather than a theoretical one.
 *
 * ## What it deliberately does NOT look for
 *
 * `var(--chart-p95)` and `currentColor` were both flagged here on the premise
 * that canvas takes literal colour strings only. That premise is obsolete at
 * 0.14.0 and was checked against the resolver: it hands both to the probe and
 * reads back a literal, and it re-runs `refresh()` on every render, so a theme
 * flip re-resolves. The library's own defaults depend on this — `defaultChartTheme`
 * paints `foreground`/`muted`/`grid` with `"currentColor"` and its palette with
 * `var(--ts-chart-N, #fallback)`. The probe is appended to the chart ROOT, so
 * `currentColor` resolves against the same inherited colour an SVG mark inside
 * that root would see. Flagging either produced false positives against valid
 * input, and the throw made those false positives fatal.
 *
 * ## What it cannot see
 *
 * Almost everything. A mark at 0.14.0 is a closure — `lineY()` returns
 * `{ initialize }` with `stroke`, `fill` and `states` captured inside — and the
 * walk skips functions, so NO mark colour is inspectable from here. What is
 * reachable is the plain top-level structure of the definition, which in
 * practice means `gradients` (and the theme block). Treat a silent pass as
 * "nothing obviously broken in the parts that are data", never as "the colours
 * are resolved". The walk is also bounded — depth 6, 24 array entries — so it
 * stays free next to a definition holding rows.
 */
const BARE_TOKEN = /^--[a-zA-Z0-9]/
const MAX_WALK_DEPTH = 6

export function warnUnresolvedColors(definition: unknown, ariaLabel: string): void {
	const seen = new Set<object>()

	const walk = (value: unknown, depth: number, path: string): void => {
		if (depth > MAX_WALK_DEPTH) return
		if (typeof value === "string") {
			if (BARE_TOKEN.test(value)) {
				// Warn, never throw. A colour smell is worth a console line and is
				// never worth unmounting the page it was spotted on — throwing here
				// turned a mis-painted series into a blank widget.
				console.error(
					`PlotFrame(${ariaLabel}): unresolved colour token ${JSON.stringify(value)} at ${path}. ` +
						`A bare custom property is not a colour — the canvas paint resolver throws on it. ` +
						`Resolve it with usePlotColors/resolvePlotColor, or wrap it as var(${value}).`,
				)
			}
			return
		}
		if (typeof value !== "object" || value === null) return
		if (seen.has(value)) return
		seen.add(value)

		if (Array.isArray(value)) {
			// Only the head of a data array can say anything the tail doesn't — a
			// colour literal lives on mark OPTIONS, not on rows.
			for (let index = 0; index < Math.min(value.length, 24); index += 1) {
				walk(value[index], depth + 1, `${path}[${index}]`)
			}
			return
		}
		for (const [key, nested] of Object.entries(value)) {
			if (typeof nested === "function") continue
			walk(nested, depth + 1, `${path}.${key}`)
		}
	}

	walk(definition, 0, "definition")
}

/**
 * Warns, in DEV, when a caller's `className` has DELETED the frame's own layout.
 *
 * `PlotFrame` merges its host classes through `cn`, i.e. tailwind-merge, which
 * resolves conflicts by LAST WINS within a group. A caller passing any display
 * utility — `hidden sm:block` on a sparkline that only shows at `sm` — is in the
 * same group as the frame's `flex`, so the merge silently drops it. The host
 * stops being a flex container, the plot box's `flex-1` goes inert, it takes its
 * height from its content instead of from the box, and the measured height never
 * resolves: the chart stays at `FALLBACK_HEIGHT` and paints a 320px canvas
 * through whatever sits below it. That shipped once, on the service overview's
 * top-operations sparkline.
 *
 * The fix at the call site is always the same — put the display utility on a
 * WRAPPER and hand the chart only its size — so the warning names it.
 */
export function warnDisplayOverride(merged: string, ariaLabel: string): void {
	if (/(^| )flex( |$)/.test(merged)) return
	console.warn(
		`[plot] "${ariaLabel}": a className passed to PlotFrame overrode its "flex" display ` +
			`(merged: "${merged}"). The plot box will not size itself and the chart will paint at ` +
			`its fallback height. Move the display utility to a wrapper element and pass the chart ` +
			`only its width/height.`,
	)
}

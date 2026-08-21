/**
 * The chart image an alert notification links to, as a takumi node tree.
 *
 * Pure: no wasm, no I/O. `alert-chart.ts` rasterises whatever this returns,
 * which keeps the layout decisions testable as a plain object.
 *
 * **Why the plot is an image inside the card.** takumi decodes SVG, so the plot
 * geometry comes straight from `@maple/widgets`' renderer — but the usvg font
 * database behind that decoder is not the one `registerFont` fills, so every
 * glyph inside an SVG renders as nothing. All type is therefore composed here,
 * as takumi nodes, around the plot rather than inside it. This is not a
 * stylistic split; an SVG with `<text>` in it silently loses the text.
 *
 * **It is read small.** Slack renders an image block at roughly half this
 * width, and on a phone less. That rules out an axis: four tick labels become
 * four smudges. What survives is the shape of the line, the threshold rule, and
 * four pieces of type — what it is, what it is now, what the limit is, and when.
 */
import { container, image, text, type Node } from "@takumi-rs/helpers"
import {
	PLOT_HEIGHT,
	PLOT_WIDTH,
	renderPlotSvg,
	type StaticChartSpec,
} from "@maple/widgets/chart/static-chart"

/** Registered by `render.ts`; the alert card is monospace throughout. */
const MONO_FONT = "Geist Mono"

const PADDING = 16
export const ALERT_CARD_WIDTH = PLOT_WIDTH + PADDING * 2
/** Plot, plus one header row and one footer row with their gaps. */
export const ALERT_CARD_HEIGHT = PLOT_HEIGHT + PADDING * 2 + 56

const ROW_WIDTH = ALERT_CARD_WIDTH - PADDING * 2

const COLOR = {
	/** A step below `--card`, so the plot's own surface reads as an object on it. */
	ground: "#17140f",
	ink: "#e8e0d6",
	muted: "#8a7f72",
	/** `--destructive`, matching the threshold rule the plot draws. */
	danger: "#ef2e43",
} as const

/**
 * Bytes to base64, in chunks.
 *
 * `String.fromCharCode(...bytes)` on a 20 KB SVG spreads twenty thousand
 * arguments onto the stack, which is a RangeError waiting for a busy chart.
 */
const toBase64 = (bytes: Uint8Array): string => {
	const CHUNK = 0x8000
	let binary = ""
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
	}
	return btoa(binary)
}

/**
 * A row whose children sit at the two ends.
 *
 * `display: "flex"` is not decoration — takumi ignores `justifyContent`,
 * `gap` and `alignItems` entirely without it, and lays the children out
 * stacked at the origin instead. Explicit `width` for the same reason:
 * `space-between` has nothing to distribute across an auto-width box.
 */
const spread = (children: ReadonlyArray<Node>): Node =>
	container({
		style: {
			display: "flex",
			width: ROW_WIDTH,
			flexDirection: "row",
			justifyContent: "space-between",
			alignItems: "center",
		},
		children: [...children],
	})

const label = (value: string, size: number, color: string, weight?: number): Node =>
	text(value, {
		fontFamily: MONO_FONT,
		fontSize: size,
		color,
		...(weight === undefined ? undefined : { fontWeight: weight }),
		lineClamp: 1,
	})

/**
 * The card for one alert chart.
 *
 * Throws only where {@link renderPlotSvg} does — on an empty series, which the
 * caller has already excluded by the time it gets here.
 */
export const alertChartCardNode = (spec: StaticChartSpec): Node => {
	const plot = renderPlotSvg(spec)
	// Inlined rather than referenced: the renderer resolves external images
	// through a loader, and a chart that needs a network fetch to draw itself
	// would be a second way for this endpoint to fail.
	//
	// `btoa` is Latin-1 only and the title can be any UTF-8, so the SVG is
	// encoded to bytes first. (The old `btoa(unescape(encodeURIComponent(…)))`
	// trick does the same thing via a function deprecated for two decades.)
	const plotSrc = `data:image/svg+xml;base64,${toBase64(new TextEncoder().encode(plot.svg))}`

	return container({
		style: {
			display: "flex",
			width: ALERT_CARD_WIDTH,
			height: ALERT_CARD_HEIGHT,
			backgroundColor: COLOR.ground,
			flexDirection: "column",
			padding: PADDING,
			gap: 10,
		},
		children: [
			// What it is, and what it is now — the two things a reader glancing at a
			// re-notification is actually checking.
			spread([label(plot.title, 17, COLOR.ink, 600), label(plot.latest, 17, COLOR.ink, 600)]),
			image({ src: plotSrc, width: PLOT_WIDTH, height: PLOT_HEIGHT }),
			spread([
				label(plot.start, 12, COLOR.muted),
				// Dashes stand in for the rule's own dash pattern, since a legend
				// swatch would cost a nested flex row for two pixels of ink.
				label(
					plot.threshold === null ? "" : `- - threshold ${plot.threshold.text}`,
					12,
					COLOR.danger,
				),
				label(plot.end, 12, COLOR.muted),
			]),
		],
	})
}

/**
 * The social-preview card for a shared dashboard, as a takumi node tree.
 *
 * Pure: no wasm, no I/O, no fetching. `render.ts` rasterises whatever this
 * returns, which keeps the part with judgement in it — layout, type scale, what
 * a board looks like at 1200×630 — testable as a plain object.
 *
 * Two constraints shape everything here.
 *
 * **It is read small.** A Slack unfurl is about 360px wide, so the card is seen
 * at a third of the size it is drawn. Anything under ~24px in card space is
 * texture, not text. That rules out drawing the board's tile grid: twelve
 * labelled rectangles becomes twelve grey smudges, which is what the first
 * version of this card was.
 *
 * **It has no data.** The card must never run the board's queries — it is
 * fetched by crawlers, and a cached image of live numbers is wrong the moment
 * it is stored. So it draws no charts, real or invented. What it has instead is
 * the board's own words: its name, the description its author wrote, the window
 * it opens on, and the titles of the panels on it. Read those five things and
 * you know whether to click the link, which is the entire job.
 *
 * Colors are the dark theme's own tokens from `packages/ui/src/styles/tokens.css`,
 * as literals: takumi parses `oklch()`, so they can be the same values rather
 * than a hand-converted approximation of them.
 */
import { container, image, text, type Node } from "@takumi-rs/helpers"
import type { ShareOgCardTile } from "@maple/domain/http"
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from "./share-links"

/** The card is exactly the size the `og:image:*` tags advertise. */
export const CARD_WIDTH = OG_IMAGE_WIDTH
export const CARD_HEIGHT = OG_IMAGE_HEIGHT

/** Registered by `render.ts`; the engine's built-in face covers anything Geist does not. */
export const DISPLAY_FONT = "Geist"
export const MONO_FONT = "Geist Mono"

const COLOR = {
	/** A step below the app's own `--background`, so the card reads as an object rather than a screenshot. */
	ground: "oklch(0.178 0.008 67)",
	ink: "oklch(0.94 0.012 74)",
	muted: "oklch(0.64 0.024 72)",
	faint: "oklch(0.46 0.018 70)",
	/** Behind a lettered org tile, when the org has no logo of its own. */
	surface: "oklch(0.28 0.012 70)",
	/** `--primary` in the dark theme. */
	signal: "oklch(0.714 0.154 59)",
	/**
	 * The same amber, as sRGB hex.
	 *
	 * Only for the mark: takumi parses `oklch()` in its own styles but rasterises
	 * SVG through a parser that does not, and an `oklch()` fill there renders
	 * near-black — a dark tree on a dark card, which is how this was first
	 * shipped. Kept next to the token it converts so the two move together.
	 */
	signalHex: "#E8872A",
	signalDim: "oklch(0.44 0.07 62)",
} as const

/**
 * The warm bloom behind the top-right corner.
 *
 * The card is mostly dark and mostly type; without this it is a black rectangle
 * in a chat window. Amber rather than a two-stop gradient in some unrelated hue:
 * it is the product's own accent, lit from where the eye lands last.
 */
const GROUND = `radial-gradient(circle at 92% -18%, oklch(0.38 0.095 62) 0%, oklch(0.235 0.030 64) 26%, ${COLOR.ground} 46%)`

const PADDING = 64
const AVATAR_SIZE = 30
/**
 * Two columns of four. Rows past that are counted by `overflowLabel` instead.
 *
 * Four, not five, because the worst case has to fit: a two-line headline over a
 * two-line description leaves about 170px for the list, and a fifth row spills
 * off the bottom edge of the card. Nothing here can measure text, so the budget
 * is held rather than computed.
 */
const MAX_ROWS = 8
/** Below this a second column is a grid for its own sake. */
const MIN_ROWS_FOR_SPLIT = 4

/**
 * Headline size, by how much headline there is.
 *
 * Board names run from "API" to a sentence, and one size cannot serve both: at
 * 76px a long name wraps past two lines and pushes the list off the card, while
 * a short name set at 52px wastes the only element that survives a thumbnail.
 * The steps are chosen against Geist's average advance at these sizes, since
 * takumi lays out after this function has already decided.
 */
const titleSize = (title: string): number => (title.length <= 28 ? 76 : title.length <= 58 ? 62 : 52)

/** Who published the link, as the card draws them. */
export interface OgCardOrg {
	readonly name: string
	readonly imageUrl?: string
}

export interface OgCardInput {
	readonly title: string
	readonly description?: string
	readonly org?: OgCardOrg
	readonly widgetCount?: number
	readonly tiles: ReadonlyArray<ShareOgCardTile>
}

/**
 * Panels grouped under the heading they sit beneath.
 *
 * The board's own table of contents. Sections are the structure its author
 * chose, so they are the structure the card repeats — and a section title
 * ("Golden signals", "Runbook") often says more about a board than any
 * individual panel does.
 */
interface Group {
	readonly section?: string
	readonly titles: ReadonlyArray<string>
}

const groupTiles = (tiles: ReadonlyArray<ShareOgCardTile>): ReadonlyArray<Group> => {
	const groups: Array<{ section?: string; titles: Array<string> }> = []

	for (const tile of tiles) {
		if (tile.title === undefined) continue
		const last = groups.at(-1)
		if (last !== undefined && last.section === tile.section) last.titles.push(tile.title)
		else groups.push({ section: tile.section, titles: [tile.title] })
	}

	return groups
}

/** A section heading and its panels, as the rows they occupy. */
type Row =
	| { readonly kind: "section"; readonly label: string }
	| { readonly kind: "panel"; readonly label: string }

const groupRows = (group: Group): ReadonlyArray<Row> => [
	...(group.section === undefined ? [] : [{ kind: "section" as const, label: group.section }]),
	...group.titles.map((label) => ({ kind: "panel" as const, label })),
]

/**
 * Split into columns, balanced rather than filled.
 *
 * Filling the first column to its limit strands the remainder — five names on
 * the left and one alone on the right, which reads as a mistake rather than a
 * list. Six names read as two columns of three. Below the threshold there is no
 * second column at all: two entries do not need a grid.
 *
 * A heading is never left as the last row of a column, where a section title
 * with nothing under it reads as one more widget name.
 */
const columns = (rows: ReadonlyArray<Row>): readonly [ReadonlyArray<Row>, ReadonlyArray<Row>] => {
	if (rows.length <= MIN_ROWS_FOR_SPLIT) return [rows, []]

	const balanced = Math.ceil(rows.length / 2)
	const split = rows[balanced - 1]?.kind === "section" ? balanced - 1 : balanced
	return [rows.slice(0, split), rows.slice(split)]
}

/**
 * The Maple mark, as the card's only piece of artwork.
 *
 * Same single evenodd path as `packages/ui/src/components/icons/maple-mark.tsx`,
 * inlined rather than fetched: it is 1 KB, and an asset lookup that can fail is
 * a way for the brand to go missing from the one image the brand appears in.
 * The knockouts (the eyes, the notch by the trunk) need `fill-rule="evenodd"` —
 * without it the glyph fills solid and stops being a tree.
 *
 * Amber rather than `currentColor`: this is the brand lockup, not an icon
 * inheriting from a UI context.
 */
const MARK_PATH =
	"M369.38 0C480.324 2.908e-08 572.686 76.542 592.669 177.775C681.438 222.749 738.763 293.878 738.765 373.942C738.763 482.538 633.316 574.71 486.96 607.449C499.978 645.591 508.455 690.397 510.789 738.765L227.967 738.764C229.399 709.074 233.146 680.725 238.834 654.436C269.538 661.732 306.949 666.785 347.396 664.859L345.194 618.741C208.102 625.268 0.005 528.243 0 373.948C2.099e-08 293.883 57.322 222.751 146.093 177.775C166.076 76.543 258.436 0.001 369.38 0ZM202.322 258.434C174.48 255.016 149.271 273.738 146.015 300.254L133.046 405.874C129.791 432.389 149.721 456.662 177.563 460.08C205.404 463.499 230.614 444.769 233.87 418.254L246.839 312.633C250.095 286.118 230.163 261.853 202.322 258.434ZM367.3 278.691C339.459 275.273 314.117 295.071 310.699 322.913L298.319 423.736C294.902 451.576 314.7 476.918 342.541 480.337C370.382 483.755 395.724 463.955 399.143 436.115L411.523 335.292C414.941 307.451 395.142 282.109 367.3 278.691Z"

const MARK_SRC = `data:image/svg+xml;base64,${btoa(
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 739 739"><path fill-rule="evenodd" clip-rule="evenodd" fill="${COLOR.signalHex}" d="${MARK_PATH}"/></svg>`,
)}`

const mapleMark = (size: number): Node => image({ src: MARK_SRC, width: size, height: size })

const dot = (color: string): Node =>
	container({ style: { width: 7, height: 7, borderRadius: 4, backgroundColor: color } })

const panelRow = (label: string): Node =>
	container({
		style: { display: "flex", alignItems: "center", gap: 12, height: 34 },
		children: [
			dot(COLOR.signal),
			text(label, {
				color: COLOR.ink,
				fontSize: 25,
				fontFamily: DISPLAY_FONT,
				lineClamp: 1,
			}),
		],
	})

const sectionRow = (label: string, first: boolean): Node =>
	container({
		style: { display: "flex", alignItems: "center", height: 34, marginTop: first ? 0 : 14 },
		children: [
			text(label.toUpperCase(), {
				color: COLOR.faint,
				fontSize: 16,
				fontFamily: MONO_FONT,
				letterSpacing: 2.5,
				lineClamp: 1,
			}),
		],
	})

const columnNode = (rows: ReadonlyArray<Row>, overflow: string | undefined): Node =>
	container({
		style: { display: "flex", flexDirection: "column", width: "50%", paddingRight: 24 },
		children: [
			...rows.map((row, index) =>
				row.kind === "section" ? sectionRow(row.label, index === 0) : panelRow(row.label),
			),
			...(overflow === undefined
				? []
				: [
						container({
							style: { display: "flex", alignItems: "center", gap: 12, height: 34 },
							children: [
								container({ style: { width: 7, height: 7 } }),
								text(overflow, {
									color: COLOR.faint,
									fontSize: 20,
									fontFamily: MONO_FONT,
									lineClamp: 1,
								}),
							],
						}),
					]),
		],
	})

/**
 * As many rows as the two columns hold, never ending on a heading.
 *
 * Headings take rows too, so a board with several sections runs past the
 * columns before it runs out of widgets. One row is kept back for the counter,
 * which is how the reader learns the list was cut at all.
 */
const capRows = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> => {
	if (rows.length <= MAX_ROWS) return rows
	const kept = rows.slice(0, MAX_ROWS - 1)
	return kept.at(-1)?.kind === "section" ? kept.slice(0, -1) : kept
}

/** What the two columns could not name. Counted, never implied. */
const overflowLabel = (shown: number, total: number | undefined): string | undefined =>
	total === undefined || total <= shown ? undefined : `+${total - shown} more`

/**
 * The org's own mark, or its initial.
 *
 * Falls back to a lettered tile rather than to a stand-in image: Clerk hands
 * back a generated avatar for orgs with no logo, and shipping that into a Maple
 * surface puts a second product's placeholder art on the card.
 */
const orgAvatar = (org: OgCardOrg): Node =>
	org.imageUrl === undefined
		? container({
				style: {
					width: AVATAR_SIZE,
					height: AVATAR_SIZE,
					borderRadius: 8,
					backgroundColor: COLOR.surface,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				},
				children: [
					text([...org.name][0]?.toUpperCase() ?? "?", {
						color: COLOR.muted,
						fontSize: 17,
						fontFamily: DISPLAY_FONT,
						fontWeight: 600,
					}),
				],
			})
		: image({ src: org.imageUrl, width: AVATAR_SIZE, height: AVATAR_SIZE, style: { borderRadius: 8 } })

/**
 * The rail above the headline: the product on the left, the org that published
 * the link on the right.
 *
 * The byline is the one piece of provenance a reader in a chat window cannot
 * get from anywhere else — a link pasted with no context is answered by "who
 * sent me this". It is the org, never the person: a share link is published by
 * an organization, and putting a colleague's name in every unfurl is not what
 * pressing Share asked for.
 */
const eyebrow = (org: OgCardOrg | undefined): Node =>
	container({
		style: {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
		},
		children: [
			container({
				style: { display: "flex", alignItems: "center", gap: 14 },
				children: [
					mapleMark(30),
					text("MAPLE", {
						color: COLOR.muted,
						fontSize: 18,
						fontFamily: MONO_FONT,
						letterSpacing: 4,
					}),
				],
			}),
			...(org === undefined
				? []
				: [
						container({
							style: { display: "flex", alignItems: "center", gap: 14 },
							children: [
								orgAvatar(org),
								text(org.name, {
									color: COLOR.ink,
									fontSize: 24,
									fontFamily: DISPLAY_FONT,
									lineClamp: 1,
								}),
							],
						}),
					]),
		],
	})

/**
 * The empty state, drawn rather than left blank.
 *
 * A board with no widgets is a real thing to share — a template someone is about
 * to fill in — and a card that just stops reads as a broken image.
 */
const emptyState = (): Node =>
	container({
		style: { display: "flex", alignItems: "center", gap: 12, height: 34 },
		children: [
			dot(COLOR.signalDim),
			text("No widgets yet", { color: COLOR.muted, fontSize: 25, fontFamily: DISPLAY_FONT }),
		],
	})

export const ogCardNode = ({ title, description, org, widgetCount, tiles }: OgCardInput): Node => {
	const rows = capRows(groupTiles(tiles).flatMap(groupRows))
	const [left, right] = columns(rows)
	const named = rows.filter((row) => row.kind === "panel").length
	const overflow = overflowLabel(named, widgetCount)

	return container({
		style: {
			width: CARD_WIDTH,
			height: CARD_HEIGHT,
			display: "flex",
			flexDirection: "column",
			padding: PADDING,
			backgroundColor: COLOR.ground,
			backgroundImage: GROUND,
		},
		children: [
			eyebrow(org),
			container({
				style: { display: "flex", flexDirection: "column", flexGrow: 1, paddingTop: 30 },
				children: [
					text(title, {
						color: COLOR.ink,
						// The one element that has to survive a thumbnail. Tight tracking
						// because Geist opens up at display sizes.
						fontSize: titleSize(title),
						fontWeight: 600,
						fontFamily: DISPLAY_FONT,
						letterSpacing: -2.5,
						lineClamp: 2,
					}),
					...(description === undefined
						? []
						: [
								text(description, {
									color: COLOR.muted,
									fontSize: 27,
									fontFamily: DISPLAY_FONT,
									lineClamp: 2,
									marginTop: 14,
								}),
							]),
					container({
						style: { display: "flex", marginTop: "auto" },
						children:
							rows.length === 0
								? [emptyState()]
								: [
										columnNode(left, right.length === 0 ? overflow : undefined),
										...(right.length === 0 ? [] : [columnNode(right, overflow)]),
									],
					}),
				],
			}),
		],
	})
}

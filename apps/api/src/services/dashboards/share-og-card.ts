/**
 * What a share link's social preview says and draws.
 *
 * Copy and layout facts live here rather than in the worker that rasterises the
 * card, for the same reason `redactForShare` lives in `@maple/widgets`: the
 * decision about what a link's holder — and by extension every chat client that
 * unfurls it — gets to see belongs on the server that owns the document, not in
 * the renderer downstream.
 *
 * Everything here reads a **redacted** dashboard, so there is nothing to leak by
 * accident: the worst this can publish is a board name, a description its
 * author wrote, a widget title and a grid rectangle — all of which the shared
 * page shows the same viewer anyway.
 */
import type { ShareOgCardTile } from "@maple/domain/http"
import type { RedactedDashboard, RedactedWidget } from "@maple/widgets/dashboard"

/**
 * Tiles the card draws, at most.
 *
 * The card is read at thumbnail size in a chat client, so this is a legibility
 * bound rather than a payload one — past this the bars are too thin to tell
 * apart.
 */
const MAX_TILES = 10

/**
 * Grid rows the card draws, at most — roughly the first screen of a board.
 *
 * Sections stack, so a long board's grid grows without bound while the card
 * stays 630px tall. Cutting by rows rather than only by tile count keeps what
 * is drawn at a legible scale, and "the top of the board" is the honest thing
 * for a preview to show.
 */
const MAX_ROWS = 14

const MAX_TITLE_LENGTH = 120
/** Two lines of description at the card's body size. */
const MAX_DESCRIPTION_LENGTH = 150

const truncate = (value: string, max: number): string =>
	value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`

const clean = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	return trimmed.length === 0 ? undefined : trimmed
}

const displayTitle = (widget: RedactedWidget): string | undefined =>
	clean((widget.display as { readonly title?: unknown } | undefined)?.title)

const findWidget = (dashboard: RedactedDashboard, widgetId: string | undefined) =>
	widgetId === undefined ? undefined : dashboard.widgets.find((widget) => widget.id === widgetId)

const pluralize = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`

const sections = (dashboard: RedactedDashboard): ReadonlyArray<{ id: string; title?: string }> =>
	Array.isArray(dashboard.sections)
		? dashboard.sections.flatMap((section) => {
				const record = section as { readonly id?: unknown; readonly title?: unknown }
				return typeof record.id === "string" ? [{ id: record.id, title: clean(record.title) }] : []
			})
		: []

/**
 * The card's headline.
 *
 * A widget share leads with the chart's own title, because that is what the
 * link opens — the board name is context, and appears in the subtitle instead.
 */
export const ogTitle = (dashboard: RedactedDashboard, widgetId: string | undefined): string => {
	const widget = findWidget(dashboard, widgetId)
	const title = widget === undefined ? dashboard.name : (displayTitle(widget) ?? dashboard.name)
	return truncate(clean(title) ?? "Untitled dashboard", MAX_TITLE_LENGTH)
}

/**
 * The line under the headline, and the `og:description` for the same link.
 *
 * The board's own description wins when it has one: it is the only sentence
 * about this board written by someone who knows what it is for. The counts are
 * the fallback, not the default — "13 widgets" describes every dashboard ever
 * made.
 */
export const ogSubtitle = (dashboard: RedactedDashboard, widgetId: string | undefined): string => {
	if (findWidget(dashboard, widgetId) !== undefined) {
		return truncate(`A shared chart from ${dashboard.name}`, MAX_TITLE_LENGTH)
	}

	const description = clean(dashboard.description)
	if (description !== undefined) return truncate(description, MAX_TITLE_LENGTH)

	const sectionCount = sections(dashboard).length
	const parts = ["Shared dashboard", pluralize(dashboard.widgets.length, "widget")]
	if (sectionCount > 0) parts.push(pluralize(sectionCount, "section"))
	return parts.join(" · ")
}

/** The board's description, for the card's own second line. */
export const ogDescription = (
	dashboard: RedactedDashboard,
	widgetId: string | undefined,
): string | undefined => {
	if (findWidget(dashboard, widgetId) !== undefined) return `From ${dashboard.name}`
	const description = clean(dashboard.description)
	return description === undefined ? undefined : truncate(description, MAX_DESCRIPTION_LENGTH)
}

interface Rect {
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
}

/** A layout that can actually be drawn, or `undefined`. */
const rect = (layout: unknown): Rect | undefined => {
	const candidate = layout as Partial<Record<keyof Rect, unknown>> | undefined
	const { x, y, w, h } = candidate ?? {}
	return typeof x === "number" &&
		typeof y === "number" &&
		typeof w === "number" &&
		typeof h === "number" &&
		w > 0 &&
		h > 0
		? { x, y, w, h }
		: undefined
}

/**
 * Which pane a widget belongs to.
 *
 * A board's grid coordinates are **not** board-wide: every section, and every
 * tab within a section, starts again at `y = 0` (see `DashboardSectionSchema`).
 * Drawn on one grid they all land on top of each other, which is what this
 * grouping exists to prevent.
 */
const paneKey = (widget: RedactedWidget): string => `${widget.sectionId ?? ""}::${widget.tabId ?? ""}`

/**
 * Grid rectangles for the card, as one continuous grid.
 *
 * Sections are stacked in document order by offsetting each pane's rows past
 * the ones above it, so the renderer stays a plain grid painter and never has
 * to know that sections exist. Only the **first** tab of each section is drawn,
 * because that is the one a viewer opening the link actually sees; the others
 * are behind a tab bar the card has no way to show.
 *
 * A widget whose layout is not a drawable rectangle is skipped rather than
 * defaulted: a tile at 0,0 with no size is worse than one tile fewer.
 */
export const ogTiles = (dashboard: RedactedDashboard): ReadonlyArray<ShareOgCardTile> => {
	const sectionTitles = new Map(sections(dashboard).map((section) => [section.id, section.title]))
	const panes = new Map<string, Array<RedactedWidget>>()
	// First tab id seen per section — the one the section opens on.
	const openTab = new Map<string, string>()

	for (const widget of dashboard.widgets) {
		if (rect(widget.layout) === undefined) continue

		const sectionId = widget.sectionId ?? ""
		const tabId = widget.tabId ?? ""
		const open = openTab.get(sectionId)
		if (open === undefined) openTab.set(sectionId, tabId)
		else if (open !== tabId) continue

		const key = paneKey(widget)
		const pane = panes.get(key)
		if (pane === undefined) panes.set(key, [widget])
		else pane.push(widget)
	}

	const tiles: Array<ShareOgCardTile> = []
	let rowOffset = 0

	for (const pane of panes.values()) {
		let paneRows = 0

		for (const widget of pane) {
			const layout = rect(widget.layout)
			if (layout === undefined) continue
			paneRows = Math.max(paneRows, layout.y + layout.h)
			// Bounded by where the tile *starts*: a tall widget straddling the cut
			// is drawn (and clipped by the card) rather than punched out, which is
			// what a screenshot of the same board would show.
			if (tiles.length >= MAX_TILES || layout.y + rowOffset >= MAX_ROWS) continue

			const title = displayTitle(widget)
			const section = widget.sectionId === undefined ? undefined : sectionTitles.get(widget.sectionId)
			const rectangle = {
				x: layout.x,
				y: layout.y + rowOffset,
				w: layout.w,
				h: layout.h,
				visualization: typeof widget.visualization === "string" ? widget.visualization : "unknown",
			}
			const titled =
				title === undefined ? rectangle : { ...rectangle, title: truncate(title, MAX_TITLE_LENGTH) }
			tiles.push(
				section === undefined ? titled : { ...titled, section: truncate(section, MAX_TITLE_LENGTH) },
			)
		}

		rowOffset += paneRows
		if (tiles.length >= MAX_TILES || rowOffset >= MAX_ROWS) break
	}

	return tiles
}

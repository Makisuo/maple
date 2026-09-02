// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import { WIDGET_TYPES, WIDGET_VISUALIZATIONS } from "../../widget-types"
import { SORT_DIRECTIONS, STAT_AGGREGATES } from "../shared/transform"
import type { DashboardMigration } from "./types"

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Coerce rather than reject.
 *
 * v2 closes three fields v1 stored as open strings. A stored value outside the
 * closed set has to go *somewhere*: rejecting would make `parseStoredDashboard`
 * return `Rejected`, and the writable path refuses a rejected document — so one
 * bad widget would lock the whole dashboard out of editing. Each fallback below
 * is the value that build already behaves as today, so a coerced document
 * renders exactly as it did before the migration:
 *
 *   - `visualization`: the renderer registry falls back to a line chart (which
 *     persists as `"chart"`) for anything it doesn't recognise.
 *   - `aggregate`: `applyTransform` defaults an absent aggregate to `"first"`.
 *   - `direction`: `applyTransform` tests `=== "desc"` and sorts ascending for
 *     everything else, so an unrecognised direction is already an ascending sort.
 */
const coerce = <T extends string>(value: unknown, allowed: ReadonlyArray<T>, fallback: T): T =>
	allowed.find((candidate) => candidate === value) ?? fallback

const migrateTransform = (transform: unknown): unknown => {
	if (!isPlainObject(transform)) return transform

	const next: Record<string, unknown> = { ...transform } satisfies Record<string, unknown>

	const reduceToValue = transform.reduceToValue
	if (isPlainObject(reduceToValue) && reduceToValue.aggregate !== undefined) {
		next.reduceToValue = {
			...reduceToValue,
			aggregate: coerce(reduceToValue.aggregate, STAT_AGGREGATES, "first"),
		}
	}

	const sortBy = transform.sortBy
	if (isPlainObject(sortBy)) {
		next.sortBy = { ...sortBy, direction: coerce(sortBy.direction, SORT_DIRECTIONS, "asc") }
	}

	return next
}

/**
 * `line`, `bar` and `area` are *panel types*, not persisted visualizations — all
 * three persist as `"chart"` and are told apart by `display.chartId`. v1's open
 * string let the panel type itself be stored, and the code plainly expects that:
 * `toPanelType` returns `visualization` whenever `isPanelType(visualization)`.
 *
 * Folding them to `"chart"` therefore has to carry the panel identity into
 * `chartId`, or a stored `visualization: "bar"` with no `chartId` would come back
 * as a line chart. An existing `chartId` always wins — it is the more specific
 * record, and it is what a non-canonical style (`gradient-area`, …) lives in.
 */
const CHART_PANEL_TYPES = ["line", "bar", "area"] as const

const migrateWidget = (widget: unknown): unknown => {
	if (!isPlainObject(widget)) return widget

	const next: Record<string, unknown> = { ...widget } satisfies Record<string, unknown>

	const storedPanel = CHART_PANEL_TYPES.find((panel) => panel === widget.visualization)
	if (storedPanel !== undefined) {
		next.visualization = "chart"
		const display = isPlainObject(widget.display) ? widget.display : {}
		if (display.chartId === undefined) {
			next.display = { ...display, chartId: WIDGET_TYPES[storedPanel].chartId }
		}
	} else {
		next.visualization = coerce(widget.visualization, WIDGET_VISUALIZATIONS, "chart")
	}

	// `params` is never touched — invariant 1. Only `transform` is rewritten, and
	// only where a field actually needs closing.
	const dataSource = widget.dataSource
	if (isPlainObject(dataSource) && dataSource.transform !== undefined) {
		next.dataSource = { ...dataSource, transform: migrateTransform(dataSource.transform) }
	}

	// `display.sparkline.dataSource` embeds a full v1 data source, so its
	// transform needs the same closing — left open, one legacy sparkline value
	// (`aggregate: "median"`) keeps the whole document undecodable under v2/v3
	// and the writable path then refuses the entire dashboard.
	const display = next.display
	if (isPlainObject(display)) {
		const sparkline = display.sparkline
		if (
			isPlainObject(sparkline) &&
			isPlainObject(sparkline.dataSource) &&
			sparkline.dataSource.transform !== undefined
		) {
			next.display = {
				...display,
				sparkline: {
					...sparkline,
					dataSource: {
						...sparkline.dataSource,
						transform: migrateTransform(sparkline.dataSource.transform),
					},
				},
			}
		}
	}

	return next
}

/**
 * v1 -> v2: close `visualization`, `reduceToValue.aggregate` and
 * `sortBy.direction` against the sets the runtime actually implements.
 *
 * Total: a document whose `widgets` is not an array is returned unchanged and
 * left for decode to report. Idempotent: every coercion is already a member of
 * its own allowed set on a second pass.
 */
export const v1ToV2: DashboardMigration = {
	from: 1,
	to: 2,
	description: "Close visualization, reduceToValue.aggregate and sortBy.direction to their known sets",
	migrate: (document) => {
		if (!Array.isArray(document.widgets)) return document
		return { ...document, widgets: document.widgets.map(migrateWidget) }
	},
}

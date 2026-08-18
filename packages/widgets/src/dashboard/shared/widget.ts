import { Schema } from "effect"
import { makeWidgetDisplayConfigSchema } from "./display"
import { WidgetLayoutSchema } from "./layout"
import { TimeRangeSchema } from "./time-range"

/**
 * Every field except `visualization` and `dataSource` is version-independent, so
 * a widget is built from the two that aren't.
 *
 * Returns the display config alongside the widget rather than taking it as an
 * argument: `display.sparkline.dataSource` must always agree with the widget's
 * own data source, and deriving it here is what makes that unbreakable. Callers
 * that need the display schema on its own (the compatibility facade does) take
 * the one returned here instead of building a second.
 */
export const makeDashboardWidgetSchemas = <
	Visualization extends Schema.Top,
	DataSource extends Schema.Top,
>(options: {
	readonly visualization: Visualization
	readonly dataSource: DataSource
}) => {
	const display = makeWidgetDisplayConfigSchema(options.dataSource)

	const widget = Schema.Struct({
		id: Schema.String,
		visualization: options.visualization,
		dataSource: options.dataSource,
		display,
		layout: WidgetLayoutSchema,
		// Per-widget time range. Absent (the common case) means "follow the
		// dashboard's range" — the tile re-queries whenever the board's picker moves.
		// When set, the tile is pinned to its own window regardless of the board's,
		// which is how a "last 30 minutes" health stat lives on a 7-day board. The
		// override only replaces the time window: dashboard variables still
		// interpolate normally, and the board's auto-refresh still rebases a relative
		// override against "now".
		timeRange: Schema.optionalKey(TimeRangeSchema),
		// Group membership. Absent means the widget lives on the root canvas, which
		// renders above every section. `layout.x/y` are relative to the widget's
		// *container* — the root canvas, or the (section, tab) named here — never to
		// one global canvas, so every container's coordinate space starts at (0, 0).
		sectionId: Schema.optionalKey(Schema.String),
		tabId: Schema.optionalKey(Schema.String),
	})

	return { display, widget } as const
}

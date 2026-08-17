import { Schema } from "effect"
import { WIDGET_VISUALIZATIONS } from "../../widget-types"
import { makeDashboardWidgetSchemas } from "../shared/widget"
import { WidgetDataSourceV2 } from "./data-source"

/**
 * v2 narrows `visualization` from v1's open string to the closed set the widget
 * type table declares, so a typo is a decode error at the edge rather than a
 * line chart rendered via the registry's silent fallback.
 */
const v2 = makeDashboardWidgetSchemas({
	visualization: Schema.Literals(WIDGET_VISUALIZATIONS),
	dataSource: WidgetDataSourceV2,
})

// `v2.display` is deliberately not exported. The unsuffixed
// `WidgetDisplayConfigSchema` now points at v3, and nothing needs the v2 display
// on its own — only the widget, which the backfill's "was this row already
// readable?" check decodes against. An exported-but-unused schema is what knip
// flags, and it would be a lie about what still has consumers.
export const DashboardWidgetV2 = v2.widget

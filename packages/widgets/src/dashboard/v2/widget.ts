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

export const WidgetDisplayConfigV2 = v2.display
export const DashboardWidgetV2 = v2.widget

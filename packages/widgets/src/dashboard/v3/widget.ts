import { Schema } from "effect"
import { WIDGET_VISUALIZATIONS } from "../../widget-types"
import { makeDashboardWidgetSchemas } from "../shared/widget"
import { WidgetDataSourceV3 } from "./data-source"

/**
 * v3 changes only the data source; `visualization` keeps the closed set v2
 * introduced.
 *
 * Because `makeDashboardWidgetSchemas` derives the display config from the data
 * source, `display.sparkline.dataSource` becomes the v3 union here too — which
 * is exactly why the migration and both API encoders have to recurse into it.
 */
const v3 = makeDashboardWidgetSchemas({
	visualization: Schema.Literals(WIDGET_VISUALIZATIONS),
	dataSource: WidgetDataSourceV3,
})

export const WidgetDisplayConfigV3 = v3.display
export const DashboardWidgetV3 = v3.widget

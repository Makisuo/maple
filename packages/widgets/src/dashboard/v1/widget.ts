import { Schema } from "effect"
import { makeDashboardWidgetSchemas } from "../shared/widget"
import { WidgetDataSourceV1 } from "./data-source"

/** v1 leaves `visualization` an open string; v2 narrows it to the known set. */
const v1 = makeDashboardWidgetSchemas({
	visualization: Schema.String,
	dataSource: WidgetDataSourceV1,
})

export const WidgetDisplayConfigV1 = v1.display
export const DashboardWidgetV1 = v1.widget

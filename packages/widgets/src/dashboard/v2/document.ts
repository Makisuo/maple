import { Schema } from "effect"
import { makeDashboardDocumentFields } from "../shared/document"
import { DashboardWidgetV2 } from "./widget"

const fields = makeDashboardDocumentFields({ widget: DashboardWidgetV2 })

export class PortableDashboardDocumentV2 extends Schema.Class<PortableDashboardDocumentV2>(
	"PortableDashboardDocument",
)(fields.portable) {}

export class DashboardDocumentV2 extends Schema.Class<DashboardDocumentV2>("DashboardDocument")(
	fields.document,
) {}

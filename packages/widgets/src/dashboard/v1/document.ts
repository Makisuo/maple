import { Schema } from "effect"
import { makeDashboardDocumentFields } from "../shared/document"
import { DashboardWidgetV1 } from "./widget"

const fields = makeDashboardDocumentFields({ widget: DashboardWidgetV1 })

export class PortableDashboardDocumentV1 extends Schema.Class<PortableDashboardDocumentV1>(
	"PortableDashboardDocument",
)(fields.portable) {}

export class DashboardDocumentV1 extends Schema.Class<DashboardDocumentV1>("DashboardDocument")(
	fields.document,
) {}

import { Schema } from "effect"
import { makeDashboardDocumentFields } from "../shared/document"
import { DashboardWidgetV3 } from "./widget"

const fields = makeDashboardDocumentFields({ widget: DashboardWidgetV3 })

/**
 * Declared as its own class rather than subclassing the v2 one: decoding through
 * a subclass of a `Schema.Class` still constructs the *parent*, so `instanceof`
 * on a decoded value would be false. See the note in `../index.ts`.
 */
export class PortableDashboardDocumentV3 extends Schema.Class<PortableDashboardDocumentV3>(
	"PortableDashboardDocument",
)(fields.portable) {}

export class DashboardDocumentV3 extends Schema.Class<DashboardDocumentV3>("DashboardDocument")(
	fields.document,
) {}

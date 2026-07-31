import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { AlertCreatePageRoot } from "@/components/alerts/alert-create-page-root"

const AlertCreateSearch = Schema.Struct({
	serviceName: Schema.optional(Schema.String),
	ruleId: Schema.optional(Schema.String),
	/** Starter-template id from the overview empty state — pre-applies that preset. */
	template: Schema.optional(Schema.String),
	/** Dashboard/widget lookup fallback when the live chart snapshot is too large. */
	dashboardId: Schema.optional(Schema.String),
	widgetId: Schema.optional(Schema.String),
	/**
	 * Base64url-encoded snapshot of the source widget (see widget-chart-param.ts).
	 * Carries the live builder state so prefill doesn't race dashboard autosave;
	 * dashboardId/widgetId remain as the oversized-payload fallback.
	 */
	chart: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/alerts/create")({
	component: AlertCreatePageRoot,
	validateSearch: Schema.toStandardSchemaV1(AlertCreateSearch),
})

import { createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { AlertCreatePageRoot } from "@/components/alerts/alert-create-page-root"

const AlertCreateSearch = Schema.Struct({
	serviceName: Schema.optional(Schema.String),
	ruleId: Schema.optional(Schema.String),
	/** Starter-template id from the overview empty state — pre-applies that preset. */
	template: Schema.optional(Schema.String),
	/** Set by the "Create alert" action on a dashboard chart widget. */
	dashboardId: Schema.optional(Schema.String),
	widgetId: Schema.optional(Schema.String),
	/**
	 * Base64url-encoded snapshot of the source widget (see widget-chart-param.ts).
	 * Carries the live builder state so prefill doesn't race the dashboard
	 * autosave; dashboardId/widgetId remain as the lookup fallback.
	 */
	chart: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/alerts/create"))({
	component: AlertCreatePageRoot,
	validateSearch: Schema.toStandardSchemaV1(AlertCreateSearch),
})

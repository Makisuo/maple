import { Option, Schema } from "effect"

import { fromBase64Url, toBase64Url } from "@/lib/base64url"

/**
 * The widget snapshot carried in the `chart` search param of /alerts/create.
 *
 * "Create alert" on a dashboard chart encodes the LIVE widget (the builder's
 * optimistic state) instead of relying on the alert page re-fetching
 * dashboards — the autosave upsert may not have landed yet, so an API lookup
 * can miss just-added/edited widgets or prefill a stale query. Only the
 * fields `createWidgetAlertPrefill` consumes are included; the shape
 * structurally matches its `AlertableDashboardWidget` input.
 */
const AlertChartWidgetSchema = Schema.Struct({
	id: Schema.String,
	visualization: Schema.optional(Schema.String),
	dataSource: Schema.optional(
		Schema.Struct({
			endpoint: Schema.optional(Schema.String),
			params: Schema.optional(Schema.Unknown),
			transform: Schema.optional(Schema.Unknown),
		}),
	),
	display: Schema.optional(Schema.Struct({ title: Schema.optional(Schema.String) })),
})

const AlertChartContextSchema = Schema.Struct({
	dashboardId: Schema.String,
	widget: AlertChartWidgetSchema,
})

export type AlertChartContext = Schema.Schema.Type<typeof AlertChartContextSchema>

const decodeAlertChartContext = Schema.decodeUnknownOption(AlertChartContextSchema)

/**
 * Keep the encoded param well under practical URL limits; widgets that blow
 * past this (e.g. a very large raw SQL body) fall back to the id-lookup path.
 */
const MAX_ENCODED_LENGTH = 12_000

export function encodeAlertChartToSearchParam(ctx: AlertChartContext): string | undefined {
	try {
		const encoded = toBase64Url(JSON.stringify(ctx))
		return encoded.length > MAX_ENCODED_LENGTH ? undefined : encoded
	} catch {
		return undefined
	}
}

export function decodeAlertChartFromSearchParam(raw: string): AlertChartContext | undefined {
	try {
		const parsed: unknown = JSON.parse(fromBase64Url(raw))
		return Option.getOrUndefined(decodeAlertChartContext(parsed))
	} catch {
		return undefined
	}
}

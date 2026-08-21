import { Schema } from "effect"

// A product-event funnel definition, as every surface that stores one keeps
// it: the /analytics URL, a dashboard funnel widget, an MCP tool call, and the
// internal query-engine request. Mirrors the option types of
// `productEventsFunnelQuery` in `@maple/query-engine` field for field; the
// semantics (person stitching, the session step, the breakdown grouping) are
// documented there.

/** Which `session_replays` dimension a `session` step (or a breakdown) reads. */
export const FunnelSessionDimension = Schema.Literals([
	"referrerHost",
	"utmSource",
	"utmMedium",
	"utmCampaign",
	"country",
	"host",
])
export type FunnelSessionDimension = typeof FunnelSessionDimension.Type

/**
 * What a funnel counts: a stitched person (user id, else the visitor's linked
 * user, else the visitor), the raw visitor or user column, or the session.
 */
export const FunnelKeyBy = Schema.Literals(["person", "visitor", "user", "session"])
export type FunnelKeyBy = typeof FunnelKeyBy.Type

/** A `track()` (or direct-ingested) event by name, optionally narrowed by `Attributes[k] = v`. */
export const FunnelEventStep = Schema.Struct({
	kind: Schema.Literal("event"),
	eventName: Schema.String,
	attributeEquals: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
/** A page view of `pagePath`, optionally on one `host`. */
export const FunnelPageStep = Schema.Struct({
	kind: Schema.Literal("page"),
	pagePath: Schema.String,
	host: Schema.optionalKey(Schema.String),
})
/** "Started a session with this acquisition dimension" — only valid as step 1. */
export const FunnelSessionStep = Schema.Struct({
	kind: Schema.Literal("session"),
	dimension: FunnelSessionDimension,
	value: Schema.String,
})
export const FunnelStep = Schema.Union([FunnelEventStep, FunnelPageStep, FunnelSessionStep])
export type FunnelStep = typeof FunnelStep.Type

/** An acquisition dimension of the person's sessions, the event `Host`, or `attribute:<key>`. */
export const FunnelBreakdownBy = Schema.Union([
	FunnelSessionDimension,
	Schema.TemplateLiteral(["attribute:", Schema.String]),
])
export type FunnelBreakdownBy = typeof FunnelBreakdownBy.Type

/** The most steps a funnel takes; mirrors `FUNNEL_MAX_STEPS` in the query engine. */
export const FUNNEL_MAX_STEPS = 10

/** Sentence-case labels for the session dimensions, shared by every surface that names a step. */
export const FUNNEL_SESSION_DIMENSION_LABEL = {
	referrerHost: "Referrer",
	utmSource: "UTM source",
	utmMedium: "UTM medium",
	utmCampaign: "UTM campaign",
	country: "Country",
	host: "Site",
} satisfies Record<FunnelSessionDimension, string>

/**
 * The human label for a step — the bar label in a funnel chart, the row label
 * in a step table. One function so the /analytics view, the dashboard widget
 * (browser and share API alike) and the MCP tools print the same thing.
 */
export const funnelStepLabel = (step: FunnelStep): string => {
	switch (step.kind) {
		case "event":
			return step.eventName
		case "page":
			return step.host ? `${step.host}${step.pagePath}` : step.pagePath
		case "session":
			return `${FUNNEL_SESSION_DIMENSION_LABEL[step.dimension]}: ${step.value}`
	}
}

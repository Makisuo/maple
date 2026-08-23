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

/**
 * The population filter a funnel widget stores: narrow the funnel to persons
 * with a session matching these `session_replays` dimensions (the same filter
 * surface the /analytics sidebar applies, minus `eventName`, which the funnel
 * registry never forwards). Every field optional; an empty object is "no filter".
 */
export const FunnelPopulationFilters = Schema.Struct({
	host: Schema.optional(Schema.String),
	pagePath: Schema.optional(Schema.String),
	referrerHost: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	browserName: Schema.optional(Schema.String),
	osName: Schema.optional(Schema.String),
	language: Schema.optional(Schema.String),
	utmSource: Schema.optional(Schema.String),
	utmMedium: Schema.optional(Schema.String),
	utmCampaign: Schema.optional(Schema.String),
	visitorType: Schema.optional(Schema.Literals(["new", "returning"])),
})
export type FunnelPopulationFilters = typeof FunnelPopulationFilters.Type
export type FunnelPopulationFilterField = keyof FunnelPopulationFilters

/** The filter fields in a stable order — what every surface that lists them iterates. */
export const FUNNEL_POPULATION_FILTER_FIELDS = [
	"host",
	"pagePath",
	"referrerHost",
	"country",
	"deviceType",
	"browserName",
	"osName",
	"language",
	"utmSource",
	"utmMedium",
	"utmCampaign",
	"visitorType",
] as const satisfies ReadonlyArray<FunnelPopulationFilterField>

/** Groups a dashboard funnel widget draws when broken down — one bar per group per step. */
export const FUNNEL_WIDGET_BREAKDOWN_LIMIT = 6

/**
 * The params bag of the `product_events_funnel` widget route — the stored
 * definition, flat: steps, key, window, an optional breakdown, and the
 * population filters spread at the top level (they ride as the same keys the
 * funnel request takes, so the route hands them straight through). The browser
 * server function and the share API's route plan decode the same schema.
 */
export const ProductEventsFunnelWidgetParams = Schema.Struct({
	steps: Schema.Array(FunnelStep),
	keyBy: Schema.optional(FunnelKeyBy),
	windowSeconds: Schema.optional(Schema.Number),
	breakdownBy: Schema.optional(FunnelBreakdownBy),
	...FunnelPopulationFilters.fields,
})
export type ProductEventsFunnelWidgetParams = typeof ProductEventsFunnelWidgetParams.Type

/** A funnel widget's row: one bar. `group` is present only on a breakdown. */
export interface FunnelWidgetRow {
	readonly name: string
	readonly value: number
	readonly group?: string
}

/** Label a breakdown group that carried no value — the `''` group the query emits. */
export const FUNNEL_EMPTY_GROUP_LABEL = "(none)"

/**
 * `{ step, count }` query rows → one `{ name, value }` row per step, in step
 * order and labelled by the step, so the funnel chart draws a bar per step. A
 * step the query did not return counts zero.
 */
export const funnelWidgetRows = (
	steps: ReadonlyArray<FunnelStep>,
	rows: ReadonlyArray<{ readonly step: number; readonly count: number }>,
): ReadonlyArray<FunnelWidgetRow> => {
	const countByStep = new Map(rows.map((row) => [row.step, row.count]))
	return steps.map((step, index) => ({
		name: funnelStepLabel(step),
		value: countByStep.get(index + 1) ?? 0,
	}))
}

/**
 * `{ group, step, count }` breakdown rows → one `{ name, value, group }` row per
 * group per step. Groups keep the query's rank (ordered by step-1 count, the
 * order the rows arrive in), every group carries all steps, and the empty group
 * is labelled rather than dropped — the chart's legend needs a name for it.
 */
export const funnelWidgetBreakdownRows = (
	steps: ReadonlyArray<FunnelStep>,
	rows: ReadonlyArray<{ readonly group: string; readonly step: number; readonly count: number }>,
): ReadonlyArray<FunnelWidgetRow> => {
	const groups: string[] = []
	const countByGroupStep = new Map<string, Map<number, number>>()
	for (const row of rows) {
		let counts = countByGroupStep.get(row.group)
		if (!counts) {
			counts = new Map()
			countByGroupStep.set(row.group, counts)
			groups.push(row.group)
		}
		counts.set(row.step, row.count)
	}
	// Rank by step-1 count, descending, so the first group is the biggest.
	// Ties keep arrival order.
	const ranked = groups
		.map((group, index) => ({ group, index, first: countByGroupStep.get(group)?.get(1) ?? 0 }))
		.sort((a, b) => b.first - a.first || a.index - b.index)
	const labels = steps.map(funnelStepLabel)
	return ranked.flatMap(({ group }) =>
		labels.map((name, index) => ({
			name,
			value: countByGroupStep.get(group)?.get(index + 1) ?? 0,
			group: group === "" ? FUNNEL_EMPTY_GROUP_LABEL : group,
		})),
	)
}

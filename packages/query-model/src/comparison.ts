import { Schema } from "effect"

/**
 * Whether a query set also fetches a shifted window to compare against.
 *
 * Dashboards support this; alert rules do not — a rule evaluates the current
 * window only, and `normalizeRule` rejects `previous_period` rather than
 * silently dropping it.
 */
export const QUERY_COMPARISON_MODES = ["none", "previous_period"] as const
export type QueryComparisonMode = (typeof QUERY_COMPARISON_MODES)[number]

export const QueryComparisonSchema = Schema.Struct({
	mode: Schema.optional(Schema.Literals(QUERY_COMPARISON_MODES)),
	includePercentChange: Schema.optional(Schema.Boolean),
})
export type QueryComparisonPayload = Schema.Schema.Type<typeof QueryComparisonSchema>

import { Schema } from "effect"
import { QueryComparisonSchema } from "./comparison"
import { QueryBuilderFormulaSchema } from "./formula"
import { QueryBuilderQueryDraftSchema } from "./query-draft"

/**
 * "A warehouse query", as both dashboard widgets and alert rules store it.
 *
 * The model stays rich — N queries plus formulas plus an optional comparison
 * window — and the surfaces that can't express all of it constrain at
 * validation time rather than by lossy conversion. An alert rule evaluates one
 * series, so `normalizeRule` fails a set with two enabled queries or any
 * formula with a named error; it never silently keeps the first one. That is
 * what makes "create an alert from this chart" field copying rather than
 * translation.
 *
 * No `check`s here. A stored schema that can reject is a stored schema that can
 * lock a document out of editing, and the widget document is read through
 * `parseStoredDashboard` on the writable path. Size and shape limits belong at
 * the execute boundary.
 */
export const QuerySetSchema = Schema.Struct({
	queries: Schema.Array(QueryBuilderQueryDraftSchema),
	formulas: Schema.optional(Schema.Array(QueryBuilderFormulaSchema)),
	comparison: Schema.optional(QueryComparisonSchema),
})
export type QuerySet = Schema.Schema.Type<typeof QuerySetSchema>

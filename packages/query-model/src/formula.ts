import { Schema } from "effect"

/**
 * A formula over the named queries in the same query set (`A / B`).
 *
 * One declaration replacing three: a local `FormulaSchema` in the web
 * timeseries server function, a TS-only `QueryBuilderFormulaDraft` interface in
 * `@maple/query-engine/query-builder`, and a bare `Schema.Array(Schema.Unknown)`
 * in the MCP widget inspector.
 */
export const QueryBuilderFormulaSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	expression: Schema.String,
	legend: Schema.String,
	hidden: Schema.optional(Schema.Boolean),
})
export type QueryBuilderFormulaPayload = Schema.Schema.Type<typeof QueryBuilderFormulaSchema>

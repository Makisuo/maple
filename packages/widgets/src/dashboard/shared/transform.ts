import { Schema } from "effect"

export const StringRecord = Schema.Record(Schema.String, Schema.String)
export const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)

/**
 * Client-side reshaping applied to a widget's result rows before rendering.
 * Version-independent: it describes what to do with the *response*, so it is
 * unaffected by how the request params are typed.
 */
export const WidgetDataSourceTransformSchema = Schema.Struct({
	fieldMap: Schema.optional(StringRecord),
	hideSeries: Schema.optional(
		Schema.Struct({
			baseNames: Schema.Array(Schema.String),
		}),
	),
	flattenSeries: Schema.optional(
		Schema.Struct({
			valueField: Schema.String,
		}),
	),
	reduceToValue: Schema.optional(
		Schema.Struct({
			field: Schema.String,
			aggregate: Schema.optional(Schema.String),
		}),
	),
	computeRatio: Schema.optional(
		Schema.Struct({
			numeratorName: Schema.String,
			denominatorNames: Schema.Array(Schema.String),
		}),
	),
	limit: Schema.optional(Schema.Number),
	sortBy: Schema.optional(
		Schema.Struct({
			field: Schema.String,
			direction: Schema.String,
		}),
	),
})

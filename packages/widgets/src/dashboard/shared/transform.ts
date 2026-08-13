import { Schema } from "effect"

export const StringRecord = Schema.Record(Schema.String, Schema.String)
export const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)

/**
 * How `reduceToValue` collapses rows to the single number a stat or gauge shows.
 *
 * Closed in schema v2 and open (`Schema.String`) in v1. The set is exactly what
 * `applyTransform` implements and what the Aggregate picker offers; `"first"`
 * leads because it is the runtime default for an absent aggregate.
 */
export const STAT_AGGREGATES = ["first", "sum", "count", "avg", "max", "min"] as const
export type StatAggregate = (typeof STAT_AGGREGATES)[number]

/**
 * `applyTransform` compares `direction === "desc"` and sorts ascending for
 * anything else, so `"asc"` is the behavioural default for an unrecognised value
 * — which is what the v1 -> v2 migration coerces to.
 */
export const SORT_DIRECTIONS = ["asc", "desc"] as const
export type SortDirection = (typeof SORT_DIRECTIONS)[number]

/**
 * Client-side reshaping applied to a widget's result rows before rendering.
 *
 * Describes what to do with the *response*, so it is unaffected by how the
 * request params are typed — but `reduceToValue.aggregate` and
 * `sortBy.direction` are stored strings like any other, and v1 left both open.
 * They are parameterised for the same reason `display` and `widget` are: each
 * schema version binds its own, and everything else here is written once.
 */
export const makeWidgetDataSourceTransformSchema = <
	Aggregate extends Schema.Top,
	Direction extends Schema.Top,
>(options: {
	readonly aggregate: Aggregate
	readonly direction: Direction
}) =>
	Schema.Struct({
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
				aggregate: Schema.optional(options.aggregate),
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
				direction: options.direction,
			}),
		),
	})

/** v1 binding: both fields open strings. Frozen — see `v1/data-source.ts`. */
export const WidgetDataSourceTransformSchema = makeWidgetDataSourceTransformSchema({
	aggregate: Schema.String,
	direction: Schema.String,
})

/** v2 binding: both fields closed against the sets the runtime actually implements. */
export const WidgetDataSourceTransformV2 = makeWidgetDataSourceTransformSchema({
	aggregate: Schema.Literals(STAT_AGGREGATES),
	direction: Schema.Literals(SORT_DIRECTIONS),
})

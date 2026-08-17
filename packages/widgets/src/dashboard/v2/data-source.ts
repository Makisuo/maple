import { Schema } from "effect"
import { UnknownRecord, WidgetDataSourceTransformV2 } from "../shared/transform"

/**
 * v2 data source.
 *
 * `transform` closes the two fields v1 left as open strings
 * (`reduceToValue.aggregate`, `sortBy.direction`); `params` is deliberately
 * still an opaque bag. Closing it into a per-endpoint union spans ~25 endpoints
 * and has its own staged rollout behind `degradedWidgetIds` — see
 * `parse.ts`. Doing both at once would make the first migration unreviewable.
 */
export const WidgetDataSourceV2 = Schema.Struct({
	endpoint: Schema.String,
	params: Schema.optional(UnknownRecord),
	transform: Schema.optional(WidgetDataSourceTransformV2),
})

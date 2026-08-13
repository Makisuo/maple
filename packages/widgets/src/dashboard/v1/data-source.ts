import { Schema } from "effect"
import { UnknownRecord, WidgetDataSourceTransformSchema } from "../shared/transform"

/**
 * v1 data source: `endpoint` is any string and `params` is an opaque bag.
 *
 * This is the shape every dashboard written before the versioned schema existed
 * is stored in. It is kept verbatim, and deliberately not "improved" — the whole
 * point of a frozen version is that a document decoded as v1 decodes exactly as
 * it always did.
 */
export const WidgetDataSourceV1 = Schema.Struct({
	endpoint: Schema.String,
	params: Schema.optional(UnknownRecord),
	transform: Schema.optional(WidgetDataSourceTransformSchema),
})

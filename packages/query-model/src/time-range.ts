import { Schema } from "effect"
import { IsoDateTimeString } from "@maple/primitives"

/**
 * A time window, either anchored to now or pinned to two instants.
 *
 * Lived in `@maple/widgets` when dashboards were its only writer, but it is a
 * neutral value type: alert previews, MCP tools and the explore pages all
 * resolve the same shape through `resolveRelativeRange` in
 * `@maple/query-engine`. It sits here so none of them has to depend on the
 * dashboard document schema to name a time range.
 */
export const TimeRangeSchema = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("relative"),
		value: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("absolute"),
		startTime: IsoDateTimeString,
		endTime: IsoDateTimeString,
	}),
])
export type TimeRange = typeof TimeRangeSchema.Type

import { Schema } from "effect"
import { IsoDateTimeString } from "@maple/primitives"

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

import { Schema } from "effect"

export const WidgetLayoutSchema = Schema.Struct({
	x: Schema.Number,
	y: Schema.Number,
	w: Schema.Number,
	h: Schema.Number,
	minW: Schema.optional(Schema.Number),
	minH: Schema.optional(Schema.Number),
	maxW: Schema.optional(Schema.Number),
	maxH: Schema.optional(Schema.Number),
})

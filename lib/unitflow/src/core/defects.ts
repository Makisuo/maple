import * as Schema from "effect/Schema"

/**
 * A misuse of the DSL that no caller can recover from.
 *
 * These are raised as defects rather than failures on purpose: asking a combined
 * event for its pubsub, or a computed store for its ref, is a question about a
 * value that was never built to answer it — the shape is fixed when the model is
 * declared, so a program that asks once asks every time. Carrying a tag and the
 * offending `id` is what turns the resulting crash into a pointer at the
 * declaration to fix, rather than an anonymous `Error` in a stack trace.
 */
export class UnitflowMisuseError extends Schema.TaggedError<UnitflowMisuseError>()(
	"@unitflow/core/UnitflowMisuseError",
	{
		/** The event, store, or model the call was made against. */
		id: Schema.String,
		message: Schema.String,
	},
) {}

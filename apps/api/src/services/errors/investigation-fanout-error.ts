import { Schema } from "effect"

/** Internal workflow-start failure shared by both investigation entry points. */
export class FanoutStartError extends Schema.TaggedError<FanoutStartError>()(
	"@maple/api/errors/FanoutStartError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {
	static fromCause(cause: unknown): FanoutStartError {
		return new FanoutStartError({
			message: "Investigation fanout failed to start",
			cause,
		})
	}
}

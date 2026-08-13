import { Schema } from "effect"

/** Internal workflow-start failure shared by both investigation entry points. */
export class FanoutStartError extends Schema.TaggedError<FanoutStartError>()(
	"@maple/api/errors/FanoutStartError",
	{
		message: Schema.String,
		cause: Schema.String,
	},
) {
	static fromCause(cause: unknown): FanoutStartError {
		const detail = String(cause)
		return new FanoutStartError({
			message: `Investigation fanout failed to start: ${detail}`,
			cause: detail,
		})
	}
}

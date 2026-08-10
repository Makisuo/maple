import { Data } from "effect"

/** Internal workflow-start failure shared by both investigation entry points. */
export class FanoutStartError extends Data.TaggedError("FanoutStartError")<{
	readonly cause: string
}> {
	override get message(): string {
		return `Investigation fanout failed to start: ${this.cause}`
	}
}

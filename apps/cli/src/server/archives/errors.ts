import { Schema } from "effect"

/**
 * An archive operation failure. The message is shown to the user and the
 * process exits non-zero, mirroring {@link ServerError} and
 * {@link CheckpointError}. Archive failures are never silent: an actionable
 * summary is preferable to a generic return code.
 */
export class ArchiveError extends Schema.TaggedErrorClass<ArchiveError>()("@maple/cli/ArchiveError", {
	message: Schema.String,
	operation: Schema.optional(Schema.String),
	cause: Schema.optional(Schema.String),
}) {}

/** Render an expected archive failure without Effect's diagnostic cause stack. */
export const archiveErrorMessage = (error: ArchiveError): string => `${error.message}\n`

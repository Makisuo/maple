import { Schema } from "effect"

/**
 * Failures raised by the `start` / `stop` / `reset` / `checkpoint` / `restore`
 * commands.
 *
 * These used to be one `@maple/cli/ServerError` carrying nothing but a rendered
 * message. Grouping is by exception type first, so a bad `--host`, an unclean
 * store, a port already in use and a background boot that never came up all
 * landed in a single issue — and the CLI's error stream was one bucket nobody
 * could triage. The API has carried one tag per distinct failure for a while
 * (`@maple/http/errors/*`); this is the same taxonomy for the CLI.
 *
 * Each error carries the context that identifies the *situation* rather than
 * only the sentence shown to the user: which store, which policy, which port.
 * `message` stays because it is the remedy the user reads — `runMain` renders
 * it and the process exits non-zero, exactly as before.
 *
 * Errors that already had their own tag are no longer re-wrapped here: a bind
 * failure stays `ServerBindError`, a failed restore stays
 * `CheckpointRestoreError`. Re-wrapping them was what made the distinct tags
 * these modules already defined invisible in telemetry.
 */

/** A flag or environment variable the CLI cannot use as given. */
export class ServerOptionError extends Schema.TaggedError<ServerOptionError>()(
	"@maple/cli/ServerOptionError",
	{
		/** Which input was rejected — `--host`, `MAPLE_LOCAL_UI_URL`, `--checkpoint-id`. */
		source: Schema.String,
		message: Schema.String,
	},
) {}

/** The dirty-store policy in force when the store turned out to be unclean. */
export const DirtyStorePolicy = Schema.Literals(["fail", "restore-checkpoint", "reset"])

/**
 * The store was left open by a server that died without closing chDB. Reopening
 * it can crash chDB natively, so startup refuses.
 *
 * `checkpointAvailable` is the field worth grouping on: without a checkpoint
 * there is nothing to restore and the only way forward is `--reset`, which is a
 * materially different user experience from the recoverable case.
 */
export class LocalStoreDirtyError extends Schema.TaggedError<LocalStoreDirtyError>()(
	"@maple/cli/LocalStoreDirtyError",
	{
		dataDir: Schema.String,
		policy: DirtyStorePolicy,
		checkpointAvailable: Schema.Boolean,
		message: Schema.String,
	},
) {}

/** The store was written by a different chDB build; loading it would SIGTRAP. */
export class LocalStoreIncompatibleError extends Schema.TaggedError<LocalStoreIncompatibleError>()(
	"@maple/cli/LocalStoreIncompatibleError",
	{
		dataDir: Schema.String,
		storeBuild: Schema.String,
		currentBuild: Schema.String,
		message: Schema.String,
	},
) {}

/** The store was bootstrapped from an older bundled schema and needs migrating. */
export class LocalStoreSchemaStaleError extends Schema.TaggedError<LocalStoreSchemaStaleError>()(
	"@maple/cli/LocalStoreSchemaStaleError",
	{ dataDir: Schema.String, message: Schema.String },
) {}

/** Which part of the local-store migration journal the command was doing. */
export const MigrationPhase = Schema.Literals(["read-journal", "resume", "preserve"])

/** An unfinished schema migration blocks startup, or its journal is unreadable. */
export class LocalStoreMigrationError extends Schema.TaggedError<LocalStoreMigrationError>()(
	"@maple/cli/LocalStoreMigrationError",
	{ dataDir: Schema.String, phase: MigrationPhase, message: Schema.String },
) {}

/** Why no checkpoint could be selected: none was ever taken, or the registry is unusable. */
export const CheckpointUnavailableReason = Schema.Literals(["none", "unusable"])

/**
 * `maple restore` with nothing to restore from. Its own tag because it is the
 * dead end `maple start`'s dirty-store advice used to send people into, and
 * telling the two reasons apart is the whole point of looking at it.
 */
export class CheckpointUnavailableError extends Schema.TaggedError<CheckpointUnavailableError>()(
	"@maple/cli/CheckpointUnavailableError",
	{ dataDir: Schema.String, reason: CheckpointUnavailableReason, message: Schema.String },
) {}

/** `maple start --background` could not spawn the detached child at all. */
export class BackgroundServerSpawnError extends Schema.TaggedError<BackgroundServerSpawnError>()(
	"@maple/cli/BackgroundServerSpawnError",
	{ logPath: Schema.String, message: Schema.String },
) {}

/**
 * The detached child was spawned but never answered its health probe. Distinct
 * from the spawn failure: the child's own failure is in its log, so this error
 * points there rather than pretending to know the cause.
 */
export class BackgroundServerTimeoutError extends Schema.TaggedError<BackgroundServerTimeoutError>()(
	"@maple/cli/BackgroundServerTimeoutError",
	{ logPath: Schema.String, timeoutMs: Schema.Number, message: Schema.String },
) {}

/** `maple stop` sent SIGTERM and the server was still alive when the budget ran out. */
export class ServerStopTimeoutError extends Schema.TaggedError<ServerStopTimeoutError>()(
	"@maple/cli/ServerStopTimeoutError",
	{ pid: Schema.Number, timeoutMs: Schema.Number, message: Schema.String },
) {}

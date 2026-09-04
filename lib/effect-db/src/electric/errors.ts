import { Schema } from "effect"

/**
 * Error thrown when an insert operation fails
 */
export class InsertError extends Schema.TaggedError<InsertError>()("@maple/effect-db/InsertError", {
	message: Schema.String,
	data: Schema.optional(Schema.Unknown),
	cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error thrown when an update operation fails
 */
export class UpdateError extends Schema.TaggedError<UpdateError>()("@maple/effect-db/UpdateError", {
	message: Schema.String,
	key: Schema.optional(Schema.Unknown),
	cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error thrown when a delete operation fails
 */
export class DeleteError extends Schema.TaggedError<DeleteError>()("@maple/effect-db/DeleteError", {
	message: Schema.String,
	key: Schema.optional(Schema.Unknown),
	cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error thrown when waiting for a transaction ID times out
 */
export class TxIdTimeoutError extends Schema.TaggedError<TxIdTimeoutError>()(
	"@maple/effect-db/TxIdTimeoutError",
	{
		message: Schema.String,
		txid: Schema.Number,
		timeout: Schema.Number,
	},
) {}

/**
 * Error thrown when a required transaction ID is missing from handler result
 */
export class MissingTxIdError extends Schema.TaggedError<MissingTxIdError>()(
	"@maple/effect-db/MissingTxIdError",
	{
		message: Schema.String,
		operation: Schema.Literals(["insert", "update", "delete"]),
	},
) {}

/**
 * Error thrown when an invalid transaction ID type is provided
 */
export class InvalidTxIdError extends Schema.TaggedError<InvalidTxIdError>()(
	"@maple/effect-db/InvalidTxIdError",
	{
		message: Schema.String,
		receivedType: Schema.String,
	},
) {}

/**
 * Error thrown when the underlying `awaitTxId` rejects for any reason other
 * than a timeout. Carries the original rejection in `cause` so callers can
 * inspect it without parsing error strings.
 */
export class AwaitTxIdError extends Schema.TaggedError<AwaitTxIdError>()("@maple/effect-db/AwaitTxIdError", {
	message: Schema.String,
	txid: Schema.Number,
	collectionId: Schema.optional(Schema.String),
	cause: Schema.optional(Schema.Unknown),
}) {}

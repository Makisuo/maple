import { Schema } from "effect"
import { IsoDateTimeString } from "../primitives"
import { HttpTaggedError } from "./error-policy"

export class IngestKeysResponse extends Schema.Class<IngestKeysResponse>("IngestKeysResponse")({
	publicKey: Schema.String,
	privateKey: Schema.String,
	publicRotatedAt: IsoDateTimeString,
	privateRotatedAt: IsoDateTimeString,
}) {}

export class IngestKeyPersistenceError extends HttpTaggedError<IngestKeyPersistenceError>()(
	"@maple/http/errors/IngestKeyPersistenceError",
	{
		message: Schema.String,
	},
	{
		status: 503,
		code: "ingest_keys_unavailable",
		title: "Ingest keys are temporarily unavailable",
		message: "Ingest keys are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class IngestKeyEncryptionError extends HttpTaggedError<IngestKeyEncryptionError>()(
	"@maple/http/errors/IngestKeyEncryptionError",
	{
		message: Schema.String,
	},
	{
		status: 500,
		code: "ingest_key_encryption_failed",
		title: "Ingest key could not be secured",
		message: "Maple could not securely process the ingest key.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}

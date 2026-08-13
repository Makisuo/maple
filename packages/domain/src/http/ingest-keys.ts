import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { IsoDateTimeString } from "../primitives"
import { Authorization } from "./current-tenant"
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

export class IngestKeyForbiddenError extends HttpTaggedError<IngestKeyForbiddenError>()(
	"@maple/http/errors/IngestKeyForbiddenError",
	{
		message: Schema.String,
	},
	{
		status: 403,
		code: "ingest_key_forbidden",
		title: "Permission required",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

export class IngestKeysApiGroup extends HttpApiGroup.make("ingestKeys")
	.add(
		HttpApiEndpoint.get("get", "/", {
			success: IngestKeysResponse,
			error: [IngestKeyForbiddenError, IngestKeyPersistenceError, IngestKeyEncryptionError],
		}),
	)
	.add(
		HttpApiEndpoint.post("rerollPublic", "/public/reroll", {
			success: IngestKeysResponse,
			error: [IngestKeyForbiddenError, IngestKeyPersistenceError, IngestKeyEncryptionError],
		}),
	)
	.add(
		HttpApiEndpoint.post("rerollPrivate", "/private/reroll", {
			success: IngestKeysResponse,
			error: [IngestKeyForbiddenError, IngestKeyPersistenceError, IngestKeyEncryptionError],
		}),
	)
	.prefix("/api/ingest-keys")
	.middleware(Authorization) {}

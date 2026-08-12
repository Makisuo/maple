import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { HttpTaggedError } from "./error-policy"
import { ApiKeyId, PostgresTransactionId, UserId } from "../primitives"
import { Authorization } from "./current-tenant"

export const ApiKeyKind = Schema.Literals(["standard", "mcp"])
export type ApiKeyKind = Schema.Schema.Type<typeof ApiKeyKind>

export class ApiKeyResponse extends Schema.Class<ApiKeyResponse>("ApiKeyResponse")({
	id: ApiKeyId,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	keyPrefix: Schema.String,
	kind: ApiKeyKind,
	// v2 scope strings; null = legacy full access.
	scopes: Schema.NullOr(Schema.Array(Schema.String)),
	revoked: Schema.Boolean,
	revokedAt: Schema.NullOr(Schema.Number),
	lastUsedAt: Schema.NullOr(Schema.Number),
	expiresAt: Schema.NullOr(Schema.Number),
	createdAt: Schema.Number,
	createdBy: UserId,
	createdByEmail: Schema.NullOr(Schema.String),
	/** Postgres transaction id for Electric/TanStack DB reconciliation on mutation responses. */
	txid: Schema.optionalKey(PostgresTransactionId),
}) {}

export class ApiKeyCreatedResponse extends Schema.Class<ApiKeyCreatedResponse>("ApiKeyCreatedResponse")({
	id: ApiKeyId,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	keyPrefix: Schema.String,
	kind: ApiKeyKind,
	scopes: Schema.NullOr(Schema.Array(Schema.String)),
	revoked: Schema.Boolean,
	revokedAt: Schema.NullOr(Schema.Number),
	lastUsedAt: Schema.NullOr(Schema.Number),
	expiresAt: Schema.NullOr(Schema.Number),
	createdAt: Schema.Number,
	createdBy: UserId,
	createdByEmail: Schema.NullOr(Schema.String),
	secret: Schema.String,
	/** Postgres transaction id for Electric/TanStack DB reconciliation. */
	txid: Schema.optionalKey(PostgresTransactionId),
}) {}

export class ApiKeysListResponse extends Schema.Class<ApiKeysListResponse>("ApiKeysListResponse")({
	keys: Schema.Array(ApiKeyResponse),
}) {}

export class CreateApiKeyRequest extends Schema.Class<CreateApiKeyRequest>("CreateApiKeyRequest")({
	name: Schema.String,
	description: Schema.optional(Schema.String),
	expiresInSeconds: Schema.optional(Schema.Number),
	kind: Schema.optional(ApiKeyKind),
	scopes: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

export class ApiKeyPersistenceError extends HttpTaggedError<ApiKeyPersistenceError>()(
	"@maple/http/errors/ApiKeyPersistenceError",
	{
		message: Schema.String,
	},
	{
		status: 503,
		code: "api_keys_unavailable",
		title: "API keys are temporarily unavailable",
		message: "API keys are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class ApiKeyLookupPersistenceError extends HttpTaggedError<ApiKeyLookupPersistenceError>()(
	"@maple/http/errors/ApiKeyLookupPersistenceError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
	{
		status: 503,
		code: "api_key_lookup_unavailable",
		title: "Service temporarily unavailable",
		message: "A service required for this operation is temporarily unavailable; retry with backoff.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class ApiKeyForbiddenError extends HttpTaggedError<ApiKeyForbiddenError>()(
	"@maple/http/errors/ApiKeyForbiddenError",
	{
		message: Schema.String,
	},
	{
		status: 403,
		code: "api_key_forbidden",
		title: "Permission required",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

export class ApiKeyNotFoundError extends HttpTaggedError<ApiKeyNotFoundError>()(
	"@maple/http/errors/ApiKeyNotFoundError",
	{
		keyId: ApiKeyId,
		message: Schema.String,
	},
	{
		status: 404,
		code: "api_key_not_found",
		title: "API key not found",
		message: "No such API key.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class ApiKeysApiGroup extends HttpApiGroup.make("apiKeys")
	.add(
		HttpApiEndpoint.get("list", "/", {
			success: ApiKeysListResponse,
			error: ApiKeyPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: CreateApiKeyRequest,
			success: ApiKeyCreatedResponse,
			error: [ApiKeyForbiddenError, ApiKeyPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.post("roll", "/:keyId/roll", {
			params: {
				keyId: ApiKeyId,
			},
			success: ApiKeyCreatedResponse,
			error: [ApiKeyForbiddenError, ApiKeyNotFoundError, ApiKeyPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.delete("revoke", "/:keyId/revoke", {
			params: {
				keyId: ApiKeyId,
			},
			success: ApiKeyResponse,
			error: [ApiKeyForbiddenError, ApiKeyNotFoundError, ApiKeyPersistenceError],
		}),
	)
	.prefix("/api/api-keys")
	.middleware(Authorization) {}

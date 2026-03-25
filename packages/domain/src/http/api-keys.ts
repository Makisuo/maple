import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { ApiKeyId, UserId } from "../primitives"
import { Authorization } from "./current-tenant"

export class ApiKeyResponse extends Schema.Class<ApiKeyResponse>("ApiKeyResponse")({
  id: ApiKeyId,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  keyPrefix: Schema.String,
  revoked: Schema.Boolean,
  revokedAt: Schema.NullOr(Schema.Number),
  lastUsedAt: Schema.NullOr(Schema.Number),
  expiresAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  createdBy: UserId,
}) {}

export class ApiKeyCreatedResponse extends Schema.Class<ApiKeyCreatedResponse>("ApiKeyCreatedResponse")({
  id: ApiKeyId,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  keyPrefix: Schema.String,
  revoked: Schema.Boolean,
  revokedAt: Schema.NullOr(Schema.Number),
  lastUsedAt: Schema.NullOr(Schema.Number),
  expiresAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  createdBy: UserId,
  secret: Schema.String,
}) {}

export class ApiKeysListResponse extends Schema.Class<ApiKeysListResponse>("ApiKeysListResponse")({
  keys: Schema.Array(ApiKeyResponse),
}) {}

export class CreateApiKeyRequest extends Schema.Class<CreateApiKeyRequest>("CreateApiKeyRequest")({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  expiresInSeconds: Schema.optionalKey(Schema.Number),
}) {}

export class ApiKeyPersistenceError extends Schema.TaggedErrorClass<ApiKeyPersistenceError>()(
  "ApiKeyPersistenceError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class ApiKeyNotFoundError extends Schema.TaggedErrorClass<ApiKeyNotFoundError>()(
  "ApiKeyNotFoundError",
  {
    keyId: ApiKeyId,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
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
      error: ApiKeyPersistenceError,
    }),
  )
  .add(
    HttpApiEndpoint.delete("revoke", "/:keyId/revoke", {
      params: {
        keyId: ApiKeyId,
      },
      success: ApiKeyResponse,
      error: [ApiKeyNotFoundError, ApiKeyPersistenceError],
    }),
  )
  .prefix("/api/api-keys")
  .middleware(Authorization) {}

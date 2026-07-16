import { ApiKeyId, ApiKeyKind, UserId } from "@maple/domain/http"
import type { V2ApiKey } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { createSyncedCollection, timestamptzParser } from "./shape-fetch"

/**
 * Safe browser projection of `api_keys`. This mirrors the pinned column list in
 * the Electric shape proxy; authentication material (`key_hash`) and internal
 * agent metadata (`metadata_json`) are intentionally absent.
 */
export const ApiKeyRowSchema = Schema.Struct({
	id: Schema.String,
	org_id: Schema.String,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	key_prefix: Schema.String,
	revoked: Schema.Boolean,
	revoked_at: Schema.NullOr(Schema.String),
	last_used_at: Schema.NullOr(Schema.String),
	expires_at: Schema.NullOr(Schema.String),
	scopes: Schema.NullOr(Schema.Array(Schema.String)),
	kind: Schema.String,
	created_at: Schema.String,
	created_by: Schema.String,
	created_by_email: Schema.NullOr(Schema.String),
})

export type ApiKeyRow = typeof ApiKeyRowSchema.Type

const asApiKeyId = Schema.decodeUnknownSync(ApiKeyId)
const asApiKeyKind = Schema.decodeUnknownSync(ApiKeyKind)
const asUserId = Schema.decodeUnknownSync(UserId)

/** Maps the Electric row into the same decoded model returned by the v2 client. */
export const rowToV2ApiKey = (row: ApiKeyRow): V2ApiKey => ({
	id: asApiKeyId(row.id),
	object: "api_key",
	name: row.name,
	description: row.description,
	key_prefix: row.key_prefix,
	kind: asApiKeyKind(row.kind),
	scopes: row.scopes,
	revoked: row.revoked,
	revoked_at: row.revoked_at,
	last_used_at: row.last_used_at,
	expires_at: row.expires_at,
	created_at: row.created_at,
	created_by: asUserId(row.created_by),
	created_by_email: row.created_by_email,
})

export const createApiKeysCollection = (orgId: string) =>
	createSyncedCollection({
		shape: "api_keys",
		orgId,
		schema: ApiKeyRowSchema,
		getKey: (row) => row.id,
		parser: timestamptzParser,
	})

export type ApiKeysCollection = ReturnType<typeof createApiKeysCollection>

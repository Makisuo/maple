import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { ApiKeyId, UserId } from "../../primitives"
import { ApiKeyKind } from "../api-keys"
import { AuthorizationV2, V2SchemaErrors, V2Scope } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import {
	V2InvalidRequestError,
	V2NotFoundError,
	V2PermissionError,
	V2ServiceUnavailableError,
} from "./errors"
import { PublicId, PublicIdPrefixes } from "./public-id"

/** `key_…` public ID ⇄ internal `ApiKeyId` (raw UUID). */
export const ApiKeyPublicId = PublicId(PublicIdPrefixes.apiKey, ApiKeyId)

export class V2ApiKey extends Schema.Class<V2ApiKey>("V2ApiKey")({
	id: ApiKeyPublicId,
	object: Schema.Literal("api_key"),
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	key_prefix: Schema.String,
	kind: ApiKeyKind,
	scopes: Schema.NullOr(Schema.Array(V2Scope)),
	revoked: Schema.Boolean,
	revoked_at: Schema.NullOr(Timestamp),
	last_used_at: Schema.NullOr(Timestamp),
	expires_at: Schema.NullOr(Timestamp),
	created_at: Timestamp,
	created_by: UserId,
	created_by_email: Schema.NullOr(Schema.String),
}) {}

/** Returned only by create/roll — the one time the secret is visible. */
export class V2ApiKeyWithSecret extends Schema.Class<V2ApiKeyWithSecret>("V2ApiKeyWithSecret")({
	...V2ApiKey.fields,
	secret: Schema.String,
}) {}

export class V2ApiKeyCreateParams extends Schema.Class<V2ApiKeyCreateParams>("V2ApiKeyCreateParams")({
	name: Schema.String.check(Schema.isMinLength(1)),
	description: Schema.optionalKey(Schema.String),
	expires_in_seconds: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
	kind: Schema.optionalKey(ApiKeyKind),
	scopes: Schema.optionalKey(Schema.Array(V2Scope)),
}) {}

const commonErrors = [V2InvalidRequestError, V2ServiceUnavailableError] as const

export class V2ApiKeysApiGroup extends HttpApiGroup.make("apiKeys")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: ListOf(V2ApiKey),
			error: [...commonErrors],
		}),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2ApiKeyCreateParams,
			success: V2ApiKeyWithSecret,
			error: [...commonErrors, V2PermissionError],
		}),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: ApiKeyPublicId },
			success: V2ApiKey,
			error: [...commonErrors, V2NotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.post("roll", "/:id/roll", {
			params: { id: ApiKeyPublicId },
			success: V2ApiKeyWithSecret,
			error: [...commonErrors, V2PermissionError, V2NotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.delete("revoke", "/:id", {
			params: { id: ApiKeyPublicId },
			success: V2ApiKey,
			error: [...commonErrors, V2PermissionError, V2NotFoundError],
		}),
	)
	.prefix("/v2/api_keys")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors) {}

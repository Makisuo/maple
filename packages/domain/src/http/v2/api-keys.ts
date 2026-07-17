import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { ApiKeyId, PostgresTransactionId, UserId } from "../../primitives"
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

/**
 * Author OpenAPI `examples` in wire (encoded) shape. Effect types the `examples`
 * annotation against a schema's decoded `Type`, but an HttpApi response renders
 * the *encoded* schema — so a realistic example must use wire values (`id`
 * as `key_…`, not the internal UUID). This adapter bridges the wire object to
 * the annotation's `Type` slot; each example is verified to be a decodable wire
 * payload in `openapi.test.ts`.
 */
const wireExample = <A>(example: object): A => example as A

/** `key_…` public ID ⇄ internal `ApiKeyId` (raw UUID). */
export const ApiKeyPublicId = PublicId(PublicIdPrefixes.apiKey, ApiKeyId)

/** Realistic wire example reused for `ApiKey` and (with `secret`) `ApiKeyWithSecret`. */
const apiKeyExample = {
	id: "key_aXwpxqBkqtYwtBtmsGbR41",
	object: "api_key",
	name: "ci-pipeline",
	description: "Publishes deploys from the CI pipeline",
	key_prefix: "maple_ak_9f2c",
	kind: "standard",
	scopes: ["dashboards:read", "alerts:write"],
	revoked: false,
	revoked_at: null,
	last_used_at: "2026-07-15T09:12:00.000Z",
	expires_at: null,
	created_at: "2026-07-01T12:00:00.000Z",
	created_by: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g",
	created_by_email: "ci@acme.com",
} as const

// v2 wire schemas are annotated `Schema.Struct`s (not `Schema.Class`). Effect's
// OpenAPI generation renders component-level `title`/`description`/`examples`
// from a Struct's annotations, but drops them for a `Schema.Class`; a Struct is
// also the schema consumers want (handlers return plain wire objects — the HTTP
// layer validates on encode). Field-level annotations render either way.
export const V2ApiKey = Schema.Struct({
	id: ApiKeyPublicId,
	object: Schema.Literal("api_key").annotate({
		description: 'The object type — always `"api_key"`.',
		examples: ["api_key"],
	}),
	name: Schema.String.annotate({
		description: "Human-readable label for the key, shown in the dashboard.",
		examples: ["ci-pipeline"],
	}),
	description: Schema.NullOr(Schema.String).annotate({
		description: "Optional longer description of what the key is for, or `null`.",
		examples: ["Publishes deploys from the CI pipeline"],
	}),
	key_prefix: Schema.String.annotate({
		description:
			"The non-secret leading portion of the key, safe to display. The full secret is returned only when the key is created or rolled.",
		examples: ["maple_ak_9f2c"],
	}),
	kind: ApiKeyKind.annotate({
		description: "Key type: `standard` for HTTP API access, `mcp` for the Model Context Protocol server.",
		examples: ["standard"],
	}),
	scopes: Schema.NullOr(Schema.Array(V2Scope)).annotate({
		description: "The scopes granted to the key, or `null` for a legacy key with full access.",
		examples: [["dashboards:read", "alerts:write"]],
	}),
	revoked: Schema.Boolean.annotate({
		description: "Whether the key has been revoked. Revoked keys can no longer authenticate.",
		examples: [false],
	}),
	revoked_at: Schema.NullOr(Timestamp).annotate({
		description: "When the key was revoked, or `null` if it is still active.",
	}),
	last_used_at: Schema.NullOr(Timestamp).annotate({
		description: "When the key was last used to authenticate a request, or `null` if never used.",
	}),
	expires_at: Schema.NullOr(Timestamp).annotate({
		description: "When the key expires, or `null` if it never expires.",
	}),
	created_at: Timestamp.annotate({
		description: "When the key was created.",
	}),
	created_by: UserId.annotate({
		description: "Maple user ID of the key's creator (e.g. `user_…`).",
	}),
	created_by_email: Schema.NullOr(Schema.String).annotate({
		description: "Email of the user who created the key, when known.",
		examples: ["ci@acme.com"],
	}),
}).annotate({
	identifier: "ApiKey",
	title: "API Key",
	description:
		"A credential for programmatic access to the Maple API, scoped to one organization. The secret is shown only once (at creation or roll); afterward only its `key_prefix` is stored and returned.",
	examples: [wireExample(apiKeyExample)],
})
export type V2ApiKey = Schema.Schema.Type<typeof V2ApiKey>

const MutationTxidFields = {
	txid: Schema.optionalKey(PostgresTransactionId),
}

/** Returned only by create/roll — the one time the secret is visible. */
export const V2ApiKeyWithSecret = Schema.Struct({
	...V2ApiKey.fields,
	...MutationTxidFields,
	secret: Schema.String.annotate({
		description:
			"The full API key secret. **Returned only once**, in the create and roll responses — it cannot be retrieved later. Store it securely.",
		examples: ["maple_ak_9f2cB1x8Kt7pQ2wR5vN0sL3dJ6hM4gY9"],
	}),
}).annotate({
	identifier: "ApiKeyWithSecret",
	title: "API Key (with secret)",
	description:
		"An API key including its one-time `secret`. Returned only by the create and roll endpoints; every other endpoint returns the `ApiKey` object without the secret.",
	examples: [
		wireExample({
			...apiKeyExample,
			txid: "81234",
			secret: "maple_ak_9f2cB1x8Kt7pQ2wR5vN0sL3dJ6hM4gY9",
		}),
	],
})
export type V2ApiKeyWithSecret = Schema.Schema.Type<typeof V2ApiKeyWithSecret>

/** Returned by revoke: the final resource plus the Electric reconciliation token. */
export const V2ApiKeyMutationResponse = Schema.Struct({
	...V2ApiKey.fields,
	...MutationTxidFields,
}).annotate({
	identifier: "ApiKeyMutationResponse",
	title: "API Key mutation response",
	description:
		"The final API key state after a mutation. The optional `txid` is an internal dashboard reconciliation token; API consumers should ignore it.",
	examples: [
		wireExample({
			...apiKeyExample,
			revoked: true,
			revoked_at: "2026-07-16T12:00:00.000Z",
			txid: "81234",
		}),
	],
})
export type V2ApiKeyMutationResponse = Schema.Schema.Type<typeof V2ApiKeyMutationResponse>

export const V2ApiKeyCreateParams = Schema.Struct({
	name: Schema.String.check(Schema.isMinLength(1)).annotate({
		description: "Human-readable label for the key. Required, non-empty.",
		examples: ["ci-pipeline"],
	}),
	description: Schema.optionalKey(
		Schema.String.annotate({
			description: "Optional longer description of what the key is for.",
			examples: ["Publishes deploys from the CI pipeline"],
		}),
	),
	expires_in_seconds: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)).annotate({
			description: "Optional lifetime in seconds. Omit for a key that never expires.",
			examples: [7_776_000],
		}),
	),
	kind: Schema.optionalKey(
		ApiKeyKind.annotate({
			description: "Key type. Defaults to `standard`.",
			examples: ["standard"],
		}),
	),
	scopes: Schema.optionalKey(
		Schema.Array(V2Scope).annotate({
			description:
				"Scopes to restrict the key to. Omit for a key with full access to the organization.",
			examples: [["dashboards:read", "alerts:write"]],
		}),
	),
}).annotate({
	identifier: "ApiKeyCreateParams",
	title: "API Key create parameters",
	description: "Request body for creating an API key.",
	examples: [
		wireExample({
			name: "ci-pipeline",
			description: "Publishes deploys from the CI pipeline",
			expires_in_seconds: 7_776_000,
			kind: "standard",
			scopes: ["dashboards:read", "alerts:write"],
		}),
	],
})
export type V2ApiKeyCreateParams = Schema.Schema.Type<typeof V2ApiKeyCreateParams>

const commonErrors = [V2InvalidRequestError, V2ServiceUnavailableError] as const

/** List response: a named, cursor-paginated page of API keys. */
const ApiKeyList = ListOf(V2ApiKey).annotate({
	identifier: "ApiKeyList",
	title: "API key list",
	description: "A cursor-paginated page of API keys.",
})

export class V2ApiKeysApiGroup extends HttpApiGroup.make("apiKeys")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: ApiKeyList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listApiKeys",
				summary: "List API keys",
				description:
					"Returns your organization's API keys, most recently created first. Cursor-paginated. Requires the `api_keys:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2ApiKeyCreateParams,
			success: V2ApiKeyWithSecret,
			error: [...commonErrors, V2PermissionError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createApiKey",
				summary: "Create an API key",
				description:
					"Creates an API key and returns it **with its one-time `secret`** — store the secret securely, it cannot be retrieved later. Requires an org-admin role and the `api_keys:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: ApiKeyPublicId },
			success: V2ApiKey,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getApiKey",
				summary: "Retrieve an API key",
				description:
					"Returns a single API key by its `key_…` ID (without the secret). Requires the `api_keys:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("roll", "/:id/roll", {
			params: { id: ApiKeyPublicId },
			success: V2ApiKeyWithSecret,
			error: [...commonErrors, V2PermissionError, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "rollApiKey",
				summary: "Roll an API key",
				description:
					"Invalidates the key's current secret and issues a new one for the same key, returning it **with the new one-time `secret`**. Requires an org-admin role and the `api_keys:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("revoke", "/:id", {
			params: { id: ApiKeyPublicId },
			success: V2ApiKeyMutationResponse,
			error: [...commonErrors, V2PermissionError, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "revokeApiKey",
				summary: "Revoke an API key",
				description:
					"Permanently revokes an API key and returns the final object. A revoked key can no longer authenticate. Requires an org-admin role and the `api_keys:write` scope.",
			}),
		),
	)
	.prefix("/v2/api_keys")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "API Keys",
			description:
				"Programmatic credentials for the Maple API. Create scoped keys, list and retrieve them, roll their secrets, and revoke them. Creating, rolling, and revoking keys is admin-only; a key's `secret` is returned only when it is created or rolled.",
		}),
	) {}

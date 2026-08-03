import { Schema } from "effect"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { deepEqual, isResolved } from "alchemy/Diff"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import { listAll, MapleApi } from "./MapleApi"
import type { Providers } from "./Providers"

/**
 * API key props — mirrors `POST /v2/api_keys`. The v2 API has no update
 * endpoint for keys, so changing `name`/`description`/`scopes`/`kind`/
 * `expires_in_seconds` **replaces** the key (new ID + secret); bumping
 * `rotate` rolls it in place via `POST /v2/api_keys/:id/roll` (preserves
 * name/scopes, mints a new secret).
 */
export interface ApiKeyProps {
	name: string
	description?: string
	/** e.g. `["dashboards:write", "alerts:read"]`; omit for full access. */
	scopes?: string[]
	/** Defaults to `standard`. `mcp` keys are only valid for the MCP server. */
	kind?: "standard" | "mcp"
	expires_in_seconds?: number
	/** Bump (e.g. `1` → `2`) to roll the key: same name/scopes, new secret. */
	rotate?: number | string
}

export type ApiKey = Resource<
	"Maple.ApiKey",
	ApiKeyProps,
	{
		/** The `key_…` public ID. */
		keyId: string
		name: string
		keyPrefix: string
		/**
		 * The full `maple_ak_…` secret, captured at create/roll — the API never
		 * returns it again, so it is preserved in Alchemy state across deploys.
		 */
		secret: Redacted.Redacted<string>
	},
	never,
	Providers
>

/**
 * A Maple API key managed through the public v2 API. Requires the deploy
 * credential to be backed by an org admin.
 *
 * @example
 * ```typescript
 * const key = yield* Maple.ApiKey("ci", {
 *   name: "ci-pipeline",
 *   scopes: ["dashboards:write"],
 * })
 * // key.secret is a Redacted<string> — pass it into another resource's env.
 * ```
 */
export const ApiKey = Resource<ApiKey>("Maple.ApiKey")

const WireApiKey = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	key_prefix: Schema.String,
	revoked: Schema.Boolean,
})
const decodeWireApiKey = Schema.decodeUnknownEffect(WireApiKey)

const WireApiKeyWithSecret = Schema.Struct({
	...WireApiKey.fields,
	secret: Schema.String,
})
const decodeWireApiKeyWithSecret = Schema.decodeUnknownEffect(WireApiKeyWithSecret)

const createBody = (props: ApiKeyProps): Record<string, unknown> => {
	const body: Record<string, unknown> = { name: props.name }
	if (props.description !== undefined) body.description = props.description
	if (props.scopes !== undefined) body.scopes = props.scopes
	if (props.kind !== undefined) body.kind = props.kind
	if (props.expires_in_seconds !== undefined) body.expires_in_seconds = props.expires_in_seconds
	return body
}

const fromSecretResponse = (wire: Schema.Schema.Type<typeof WireApiKeyWithSecret>) => ({
	keyId: wire.id,
	name: wire.name,
	keyPrefix: wire.key_prefix,
	secret: Redacted.make(wire.secret),
})

export const ApiKeyProvider = () =>
	Provider.effect(
		ApiKey,
		Effect.gen(function* () {
			const api = yield* MapleApi
			return {
				diff: Effect.fn(function* ({ news, olds }) {
					if (!isResolved(news)) return undefined
					if (olds === undefined) return undefined
					const { rotate: oldRotate, ...oldRest } = olds
					const { rotate: newRotate, ...newRest } = news
					// No PATCH endpoint: any non-rotate change replaces the key.
					if (!deepEqual(oldRest, newRest, { stripNullish: true })) {
						return { action: "replace" } as const
					}
					if (oldRotate !== newRotate) {
						return { action: "update", stables: [] } as const
					}
					return undefined
				}),
				reconcile: Effect.fn(function* ({ news, olds, output }) {
					// Observe — confirm the key still exists and is not revoked.
					let observed: Schema.Schema.Type<typeof WireApiKey> | undefined
					if (output?.keyId) {
						const fetched = yield* api
							.get(`/v2/api_keys/${output.keyId}`)
							.pipe(Effect.catchTag("Maple::NotFoundError", () => Effect.succeed(undefined)))
						if (fetched !== undefined) {
							const wire = yield* decodeWireApiKey(fetched)
							if (!wire.revoked) observed = wire
						}
					}

					// Ensure — create if missing/revoked. The secret is returned exactly
					// once; it lives in Alchemy state from here on.
					if (observed === undefined || output === undefined) {
						const created = yield* api.post("/v2/api_keys", createBody(news))
						return fromSecretResponse(yield* decodeWireApiKeyWithSecret(created))
					}

					// Roll — `rotate` bumped: replace the secret in place.
					if (olds !== undefined && olds.rotate !== news.rotate) {
						const rolled = yield* api.post(`/v2/api_keys/${observed.id}/roll`)
						return fromSecretResponse(yield* decodeWireApiKeyWithSecret(rolled))
					}

					// Steady state — preserve the stored secret (GET never returns it).
					return {
						keyId: observed.id,
						name: observed.name,
						keyPrefix: observed.key_prefix,
						secret: output.secret,
					}
				}),
				delete: Effect.fn(function* ({ output }) {
					yield* api
						.delete(`/v2/api_keys/${output.keyId}`)
						.pipe(Effect.catchTag("Maple::NotFoundError", () => Effect.void))
				}),
				read: Effect.fn(function* ({ output }) {
					if (!output?.keyId) return undefined
					const fetched = yield* api
						.get(`/v2/api_keys/${output.keyId}`)
						.pipe(Effect.catchTag("Maple::NotFoundError", () => Effect.succeed(undefined)))
					if (fetched === undefined) return undefined
					const wire = yield* decodeWireApiKey(fetched)
					if (wire.revoked) return undefined
					return {
						keyId: wire.id,
						name: wire.name,
						keyPrefix: wire.key_prefix,
						// The API never returns the secret; keep the state's copy.
						secret: output.secret,
					}
				}),
				list: Effect.fn(function* () {
					const items = yield* listAll(api, "/v2/api_keys")
					const wires = yield* Effect.forEach(items, (item) => decodeWireApiKey(item))
					// Secrets are unrecoverable via list — empty placeholder (list only
					// powers enumeration/nuke, which needs IDs, not secrets).
					return wires
						.filter((wire) => !wire.revoked)
						.map((wire) => ({
							keyId: wire.id,
							name: wire.name,
							keyPrefix: wire.key_prefix,
							secret: Redacted.make(""),
						}))
				}),
			}
		}),
	)

/** @internal Exposed for the in-repo contract test against `@maple/domain`. */
export const _apiKeyCreateBody = createBody

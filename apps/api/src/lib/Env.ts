import { optionalRedacted, optionalString, stringWithDefault } from "@maple/effect-cloudflare/config-helpers"
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"

/** Fatal misconfiguration discovered at startup — surfaces as a tagged defect in the Cause. */
class EnvValidationError extends Schema.TaggedErrorClass<EnvValidationError>()(
	"@maple/api/lib/EnvValidationError",
	{ message: Schema.String },
) {}

export interface EnvShape {
	readonly PORT: number
	readonly TINYBIRD_HOST: string
	readonly TINYBIRD_TOKEN: Redacted.Redacted<string>
	readonly CLICKHOUSE_URL: Option.Option<string>
	readonly CLICKHOUSE_USER: string
	readonly CLICKHOUSE_PASSWORD: Option.Option<Redacted.Redacted<string>>
	readonly CLICKHOUSE_DATABASE: string
	readonly MAPLE_DB_URL: string
	readonly MAPLE_AUTH_MODE: string
	readonly MAPLE_ROOT_PASSWORD: Option.Option<Redacted.Redacted<string>>
	readonly MAPLE_DEFAULT_ORG_ID: string
	readonly MAPLE_INGEST_KEY_ENCRYPTION_KEY: Redacted.Redacted<string>
	readonly MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: Redacted.Redacted<string>
	readonly MAPLE_INGEST_PUBLIC_URL: string
	readonly MAPLE_APP_BASE_URL: string
	readonly CLERK_SECRET_KEY: Option.Option<Redacted.Redacted<string>>
	readonly CLERK_PUBLISHABLE_KEY: Option.Option<string>
	readonly CLERK_JWT_KEY: Option.Option<Redacted.Redacted<string>>
	readonly MAPLE_ORG_ID_OVERRIDE: Option.Option<string>
	readonly AUTUMN_SECRET_KEY: Option.Option<Redacted.Redacted<string>>
	readonly AUTUMN_API_URL: string
	readonly SD_INTERNAL_TOKEN: Option.Option<Redacted.Redacted<string>>
	readonly INTERNAL_SERVICE_TOKEN: Option.Option<Redacted.Redacted<string>>
	readonly EMAIL_FROM: string
	readonly HAZEL_API_BASE_URL: string
	readonly HAZEL_OAUTH_DISCOVERY_URL: string
	readonly HAZEL_OAUTH_CLIENT_ID: Option.Option<string>
	readonly HAZEL_OAUTH_CLIENT_SECRET: Option.Option<Redacted.Redacted<string>>
	readonly HAZEL_OAUTH_SCOPES: string
	readonly GITHUB_APP_ID: Option.Option<string>
	readonly GITHUB_APP_SLUG: Option.Option<string>
	readonly GITHUB_APP_PRIVATE_KEY: Option.Option<Redacted.Redacted<string>>
	readonly GITHUB_APP_CLIENT_ID: Option.Option<string>
	readonly GITHUB_APP_CLIENT_SECRET: Option.Option<Redacted.Redacted<string>>
	readonly GITHUB_APP_WEBHOOK_SECRET: Option.Option<Redacted.Redacted<string>>
	readonly GITHUB_API_BASE_URL: string
	readonly CLOUDFLARE_OAUTH_CLIENT_ID: Option.Option<string>
	readonly CLOUDFLARE_OAUTH_CLIENT_SECRET: Option.Option<Redacted.Redacted<string>>
	readonly CLOUDFLARE_OAUTH_SCOPES: string
	readonly CLOUDFLARE_OAUTH_AUTHORIZE_URL: string
	readonly CLOUDFLARE_OAUTH_TOKEN_URL: string
	readonly CLOUDFLARE_OAUTH_REVOKE_URL: string
	/**
	 * Base URL for Cloudflare's REST API. Deliberately NOT named CLOUDFLARE_API_BASE_URL —
	 * wrangler treats that env var as an override for its own API endpoint, so under
	 * `wrangler dev --env-file` it would hijack wrangler's control-plane calls too.
	 */
	readonly MAPLE_CLOUDFLARE_API_BASE_URL: string
	/** Base URL for PlanetScale's management API (overridable for tests). */
	readonly MAPLE_PLANETSCALE_API_BASE_URL: string
	readonly PLANETSCALE_OAUTH_CLIENT_ID: Option.Option<string>
	/** Required alongside the client id — PlanetScale OAuth apps are confidential clients. */
	readonly PLANETSCALE_OAUTH_CLIENT_SECRET: Option.Option<Redacted.Redacted<string>>
	readonly PLANETSCALE_OAUTH_AUTHORIZE_URL: string
	readonly PLANETSCALE_OAUTH_TOKEN_URL: string
	/** OAuth token introspection (`/oauth/token/info`) — consulted when the v1 API rejects a fresh token. */
	readonly PLANETSCALE_OAUTH_TOKEN_INFO_URL: string
	/**
	 * Space-delimited, resource-prefixed OAuth scopes requested at authorize time
	 * (e.g. `organization:read_databases`). PlanetScale REQUIRES an explicit scope
	 * param — the scopes configured on the OAuth app are the allowed maximum, not
	 * an implicit default — so omitting it fails the authorize with `invalid_scope`.
	 * The default matches the scopes the Maple OAuth app is provisioned with; each
	 * request may only name a subset of them.
	 */
	readonly PLANETSCALE_OAUTH_SCOPES: string
}

const portConfig = Config.number("PORT").pipe(Config.withDefault(3472))

const envConfig = Config.all({
	PORT: portConfig,
	TINYBIRD_HOST: Config.string("TINYBIRD_HOST"),
	TINYBIRD_TOKEN: Config.redacted("TINYBIRD_TOKEN"),
	CLICKHOUSE_URL: optionalString("CLICKHOUSE_URL"),
	CLICKHOUSE_USER: stringWithDefault("CLICKHOUSE_USER", "default"),
	CLICKHOUSE_PASSWORD: optionalRedacted("CLICKHOUSE_PASSWORD"),
	CLICKHOUSE_DATABASE: stringWithDefault("CLICKHOUSE_DATABASE", "default"),
	MAPLE_DB_URL: stringWithDefault("MAPLE_DB_URL", ""),
	MAPLE_AUTH_MODE: stringWithDefault("MAPLE_AUTH_MODE", "self_hosted"),
	MAPLE_ROOT_PASSWORD: optionalRedacted("MAPLE_ROOT_PASSWORD"),
	MAPLE_DEFAULT_ORG_ID: stringWithDefault("MAPLE_DEFAULT_ORG_ID", "default"),
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Config.redacted("MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: Config.redacted("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
	MAPLE_INGEST_PUBLIC_URL: stringWithDefault("MAPLE_INGEST_PUBLIC_URL", "http://127.0.0.1:3474"),
	MAPLE_APP_BASE_URL: stringWithDefault("MAPLE_APP_BASE_URL", "http://127.0.0.1:3471"),
	CLERK_SECRET_KEY: optionalRedacted("CLERK_SECRET_KEY"),
	CLERK_PUBLISHABLE_KEY: optionalString("CLERK_PUBLISHABLE_KEY"),
	CLERK_JWT_KEY: optionalRedacted("CLERK_JWT_KEY"),
	MAPLE_ORG_ID_OVERRIDE: optionalString("MAPLE_ORG_ID_OVERRIDE"),
	AUTUMN_SECRET_KEY: optionalRedacted("AUTUMN_SECRET_KEY"),
	AUTUMN_API_URL: stringWithDefault("AUTUMN_API_URL", "https://api.useautumn.com"),
	SD_INTERNAL_TOKEN: optionalRedacted("SD_INTERNAL_TOKEN"),
	INTERNAL_SERVICE_TOKEN: optionalRedacted("INTERNAL_SERVICE_TOKEN"),
	EMAIL_FROM: stringWithDefault("EMAIL_FROM", "Maple <notifications@noreply.maple.dev>"),
	HAZEL_API_BASE_URL: stringWithDefault("HAZEL_API_BASE_URL", "https://api.hazel.sh"),
	HAZEL_OAUTH_DISCOVERY_URL: stringWithDefault(
		"HAZEL_OAUTH_DISCOVERY_URL",
		"https://clerk.hazel.sh/.well-known/openid-configuration",
	),
	HAZEL_OAUTH_CLIENT_ID: optionalString("HAZEL_OAUTH_CLIENT_ID"),
	HAZEL_OAUTH_CLIENT_SECRET: optionalRedacted("HAZEL_OAUTH_CLIENT_SECRET"),
	HAZEL_OAUTH_SCOPES: stringWithDefault(
		"HAZEL_OAUTH_SCOPES",
		"openid email profile organizations:read channels:read channel-webhooks:write",
	),
	GITHUB_APP_ID: optionalString("GITHUB_APP_ID"),
	GITHUB_APP_SLUG: optionalString("GITHUB_APP_SLUG"),
	GITHUB_APP_PRIVATE_KEY: optionalRedacted("GITHUB_APP_PRIVATE_KEY"),
	GITHUB_APP_CLIENT_ID: optionalString("GITHUB_APP_CLIENT_ID"),
	GITHUB_APP_CLIENT_SECRET: optionalRedacted("GITHUB_APP_CLIENT_SECRET"),
	GITHUB_APP_WEBHOOK_SECRET: optionalRedacted("GITHUB_APP_WEBHOOK_SECRET"),
	GITHUB_API_BASE_URL: stringWithDefault("GITHUB_API_BASE_URL", "https://api.github.com"),
	CLOUDFLARE_OAUTH_CLIENT_ID: optionalString("CLOUDFLARE_OAUTH_CLIENT_ID"),
	CLOUDFLARE_OAUTH_CLIENT_SECRET: optionalRedacted("CLOUDFLARE_OAUTH_CLIENT_SECRET"),
	// Cloudflare OAuth scope ids are DOT-delimited (mirroring API-token permission names;
	// registry: GET /client/v4/oauth/scopes). The client may only request scopes it was
	// created with — keep the OAuth client's granted set in sync with this list.
	// `offline_access` is deliberately NOT in this list: it is not a data scope (nothing gates or
	// stores on it), it is the request flag that makes Cloudflare issue a refresh token. The
	// client's Refresh Token grant only makes it *available*; it must still be *requested*, so
	// `startConnect` appends it to the authorize request instead of carrying it here. (Enabling the
	// grant without requesting the scope was the 31h-outage root cause: access-token-only
	// connections that die at the ~16h expiry.)
	// The analytics scopes power the edge-metrics poller. There are THREE distinct ones and they
	// are NOT interchangeable (Cloudflare authorizes account- vs zone-scoped GraphQL datasets
	// separately):
	//   - account-analytics.read → account-scoped datasets (workersInvocationsAdaptive = Workers)
	//   - analytics.read          → zone-scoped datasets (httpRequestsAdaptiveGroups = HTTP/zone traffic)
	//   - zone.read               → zone discovery only (REST /zones listing); does NOT grant analytics
	// zone.read is enough to LIST zones but NOT to read their analytics — the zone GraphQL query
	// returns "not authorized" without analytics.read (that was the original bug: workers ingested
	// fine while every zone query was rejected). Every id below is verified verbatim against the
	// live scope registry (GET /client/v4/oauth/scopes). The registered OAuth client must have all
	// of these granted, or connects fail with invalid_scope — and existing users must reconnect to
	// pick up a newly-added scope.
	// query-cache.read is the registry id for "Hyperdrive Read" (Hyperdrive's original product
	// name was "query cache" — the id never migrated). It powers the Hyperdrive config inventory
	// behind the service map; pre-existing grants without it degrade open (discovery logs a
	// warning, analytics keep flowing) until the user reconnects.
	CLOUDFLARE_OAUTH_SCOPES: stringWithDefault(
		"CLOUDFLARE_OAUTH_SCOPES",
		"account-settings.read account-analytics.read analytics.read zone.read workers-observability.write workers-observability-telemetry.write workers-scripts.read workers-scripts.write query-cache.read",
	),
	CLOUDFLARE_OAUTH_AUTHORIZE_URL: stringWithDefault(
		"CLOUDFLARE_OAUTH_AUTHORIZE_URL",
		"https://dash.cloudflare.com/oauth2/auth",
	),
	CLOUDFLARE_OAUTH_TOKEN_URL: stringWithDefault(
		"CLOUDFLARE_OAUTH_TOKEN_URL",
		"https://dash.cloudflare.com/oauth2/token",
	),
	CLOUDFLARE_OAUTH_REVOKE_URL: stringWithDefault(
		"CLOUDFLARE_OAUTH_REVOKE_URL",
		"https://dash.cloudflare.com/oauth2/revoke",
	),
	MAPLE_CLOUDFLARE_API_BASE_URL: stringWithDefault(
		"MAPLE_CLOUDFLARE_API_BASE_URL",
		"https://api.cloudflare.com/client/v4",
	),
	MAPLE_PLANETSCALE_API_BASE_URL: stringWithDefault(
		"MAPLE_PLANETSCALE_API_BASE_URL",
		"https://api.planetscale.com",
	),
	PLANETSCALE_OAUTH_CLIENT_ID: optionalString("PLANETSCALE_OAUTH_CLIENT_ID"),
	PLANETSCALE_OAUTH_CLIENT_SECRET: optionalRedacted("PLANETSCALE_OAUTH_CLIENT_SECRET"),
	// CANONICAL authorize host per PlanetScale's own OAuth discovery doc
	// (https://auth.planetscale.com/.well-known/oauth-authorization-server →
	// authorization_endpoint). Their public docs cite auth.planetscale.com/oauth/authorize
	// instead — that alias renders a working consent screen but emits codes whose
	// resulting tokens the v1 API rejects with 401 `invalid_token` even though
	// /oauth/token/info introspects them as valid (verified live 2026-07-13).
	PLANETSCALE_OAUTH_AUTHORIZE_URL: stringWithDefault(
		"PLANETSCALE_OAUTH_AUTHORIZE_URL",
		"https://app.planetscale.com/oauth/authorize",
	),
	PLANETSCALE_OAUTH_TOKEN_URL: stringWithDefault(
		"PLANETSCALE_OAUTH_TOKEN_URL",
		"https://auth.planetscale.com/oauth/token",
	),
	PLANETSCALE_OAUTH_TOKEN_INFO_URL: stringWithDefault(
		"PLANETSCALE_OAUTH_TOKEN_INFO_URL",
		"https://auth.planetscale.com/oauth/token/info",
	),
	// PlanetScale scopes are resource-prefixed (`<resource>:<action>`) and MUST be
	// sent in the authorize request — the app's configured scopes are the allowed
	// maximum, not an implicit default, so an absent scope param 302s to
	// `invalid_scope` ("The requested scope is invalid, unknown, or malformed").
	// The resource prefix is load-bearing: the same action name (e.g. `read_backups`,
	// `read_branches`) exists at multiple resource levels, so an unprefixed scope is
	// ambiguous. Default = the scopes the Maple OAuth app is provisioned with.
	PLANETSCALE_OAUTH_SCOPES: stringWithDefault(
		"PLANETSCALE_OAUTH_SCOPES",
		"user:read_organizations organization:read_organization organization:read_databases organization:read_branches organization:read_backups organization:read_comments organization:read_deploy_requests branch:read_branch",
	),
})

const makeEnv = Effect.gen(function* () {
	const env: EnvShape = yield* envConfig

	if (env.MAPLE_DEFAULT_ORG_ID.trim().length === 0) {
		return yield* Effect.die(new EnvValidationError({ message: "MAPLE_DEFAULT_ORG_ID cannot be empty" }))
	}

	const authMode = env.MAPLE_AUTH_MODE.toLowerCase()

	if (authMode !== "clerk" && Option.isNone(env.MAPLE_ROOT_PASSWORD)) {
		return yield* Effect.die(
			new EnvValidationError({
				message: "MAPLE_ROOT_PASSWORD is required when MAPLE_AUTH_MODE=self_hosted",
			}),
		)
	}

	if (authMode === "clerk" && Option.isNone(env.CLERK_SECRET_KEY)) {
		return yield* Effect.die(
			new EnvValidationError({ message: "CLERK_SECRET_KEY is required when MAPLE_AUTH_MODE=clerk" }),
		)
	}

	if (
		Option.isSome(env.MAPLE_ROOT_PASSWORD) &&
		Redacted.value(env.MAPLE_ROOT_PASSWORD.value).trim().length === 0
	) {
		return yield* Effect.die(new EnvValidationError({ message: "MAPLE_ROOT_PASSWORD cannot be empty" }))
	}

	return Env.of(env)
})

export class Env extends Context.Service<Env, EnvShape>()("@maple/api/lib/Env") {
	static readonly layer = Layer.effect(this, makeEnv)
}

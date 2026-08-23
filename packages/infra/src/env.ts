import * as Redacted from "effect/Redacted"
import type { MapleStage } from "./cloudflare/stage.ts"
import { resolveDeploymentEnvironment } from "./cloudflare/stage.ts"

/**
 * Deploy-time environment for the Cloudflare workers.
 *
 * Every worker used to carry its own copy of `requireEnv` / `optionalPlain` /
 * `optionalSecret` and then re-list the same keys, so `api` and `alerting`
 * shared 32 hand-copied entries that drifted whenever one was edited alone.
 * The helpers live here once, and the shared keys are grouped by the concern
 * that owns them: a worker spreads the groups it needs and lists only what is
 * genuinely its own.
 *
 * Deliberately plain TypeScript with no Effect `Config` layer. The values are
 * read once at plan time and fed straight into a Worker's `env`, so a
 * ConfigProvider would buy aggregated error messages at the cost of wrapping
 * every group in an Effect and matching on `Option` to decide whether a key is
 * present at all — more machinery than the problem has.
 *
 * The three rules the helpers encode:
 *
 *   - values are trimmed, and a whitespace-only value counts as absent;
 *   - an absent optional key is OMITTED from the record, never set to `""` —
 *     an empty binding is a value the worker has to defend against, an absent
 *     one reaches the `??` default in the code that reads it;
 *   - secrets are wrapped in `Redacted` so they never surface in plan output.
 */

export type PlainEnv = Record<string, string>
export type SecretEnv = Record<string, Redacted.Redacted<string>>
/**
 * A group that mixes both. Deliberately a union-valued record and NOT
 * `PlainEnv & SecretEnv` — intersecting two index signatures narrows the value
 * type to `string & Redacted<string>`, which nothing inhabits.
 */
export type WorkerEnv = Record<string, string | Redacted.Redacted<string>>

const read = (key: string): string | undefined => process.env[key]?.trim() || undefined

/** Required plain value. Throws at plan time so a deploy fails before it mutates anything. */
export const requireEnv = (key: string): string => {
	const value = read(key)
	if (!value) {
		throw new Error(`Missing required deployment env: ${key}`)
	}
	return value
}

/** Required secret, wrapped in `Redacted`. */
export const requireSecret = (key: string): Redacted.Redacted<string> => Redacted.make(requireEnv(key))

/** Optional plain value, omitted when unset. `fallback` applies only if the env var is absent. */
export const optionalPlain = (key: string, fallback?: string): PlainEnv => {
	const value = read(key) ?? fallback?.trim()
	return value ? { [key]: value } : {}
}

/** Optional secret, omitted when unset. */
export const optionalSecret = (key: string): SecretEnv => {
	const value = read(key)
	return value ? { [key]: Redacted.make(value) } : {}
}

/**
 * A value the stack CHOOSES rather than reads — `process.env` cannot override it.
 *
 * Distinct from `optionalPlain(key, fallback)`, where the environment wins. The
 * difference is load-bearing for `MAPLE_ENVIRONMENT`: a stray
 * `MAPLE_ENVIRONMENT=production` in a pr-N deploy environment would open
 * `EmailService.emailAllowed` and the alerting worker's `scheduled()`
 * early-return at once, on a stage that shares live org data.
 */
export const derived = (key: string, value: string): PlainEnv => ({ [key]: value })

const optionalPlainGroup = (...keys: ReadonlyArray<string>): PlainEnv =>
	Object.assign({}, ...keys.map((key) => optionalPlain(key)))

// ── Shared groups ───────────────────────────────────────────────────────────

/**
 * Session auth. The same `AuthEnv` subset `api`, `alerting` and `electric-sync`
 * all resolve callers with.
 */
export const authEnv = (): WorkerEnv => ({
	MAPLE_AUTH_MODE: process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted",
	MAPLE_DEFAULT_ORG_ID: process.env.MAPLE_DEFAULT_ORG_ID?.trim() || "default",
	...optionalSecret("MAPLE_ROOT_PASSWORD"),
	...optionalSecret("CLERK_SECRET_KEY"),
	...optionalPlain("CLERK_PUBLISHABLE_KEY"),
	...optionalSecret("CLERK_JWT_KEY"),
})

/**
 * Warehouse access. `SIGNING_KEY` + `WORKSPACE_ID` are what
 * `TinybirdOrgTokenService` needs for Tinybird-scoped raw SQL — without them
 * every alert tick fails with "TINYBIRD_SIGNING_KEY is required for
 * Tinybird-scoped raw SQL", which is why `alerting` binds the same set as `api`.
 */
export const tinybirdEnv = (): WorkerEnv => ({
	TINYBIRD_HOST: requireEnv("TINYBIRD_HOST"),
	TINYBIRD_TOKEN: requireSecret("TINYBIRD_TOKEN"),
	...optionalSecret("TINYBIRD_SIGNING_KEY"),
	...optionalPlainGroup("TINYBIRD_WORKSPACE_ID", "TINYBIRD_RAW_SQL_JWT_RPS_LIMIT"),
})

/** Ingest-key envelope encryption + lookup HMAC. Required wherever ingest keys are read. */
export const ingestKeyCryptoEnv = (): SecretEnv => ({
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: requireSecret("MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: requireSecret("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
})

/** Public URLs the workers build links with (emails, share links, quick-start snippets). */
export const appUrlsEnv = (): PlainEnv => ({
	MAPLE_INGEST_PUBLIC_URL: process.env.MAPLE_INGEST_PUBLIC_URL?.trim() || "https://ingest.maple.dev",
	MAPLE_APP_BASE_URL: process.env.MAPLE_APP_BASE_URL?.trim() || "https://app.maple.dev",
	EMAIL_FROM: process.env.EMAIL_FROM?.trim() || "Maple <notifications@noreply.maple.dev>",
})

/**
 * The worker's own OTLP export, through the ingest gateway.
 *
 * `MAPLE_ENVIRONMENT` is `derived`, not `optionalPlain` — see `derived` above.
 * `COMMIT_SHA` falls back to `GITHUB_SHA` so a deploy that did not export it
 * still stamps a build: an unstamped Worker reports no `service.version`, and
 * the error evaluator treats a build it cannot identify as a regression, so a
 * missing binding quietly restores the behaviour where any occurrence reopens a
 * fixed issue.
 */
export const selfObservabilityEnv = (stage: MapleStage): WorkerEnv => ({
	MAPLE_INGEST_KEY: requireSecret("MAPLE_OTEL_INGEST_KEY"),
	...optionalPlain("MAPLE_ENDPOINT"),
	...derived("MAPLE_ENVIRONMENT", resolveDeploymentEnvironment(stage)),
	...optionalPlain("COMMIT_SHA", process.env.GITHUB_SHA?.trim()),
})

/** Cloudflare account integration (account OAuth — Authorization Code + PKCE). */
export const cloudflareOAuthEnv = (): WorkerEnv => ({
	...optionalSecret("CLOUDFLARE_OAUTH_CLIENT_SECRET"),
	...optionalPlainGroup(
		"CLOUDFLARE_OAUTH_CLIENT_ID",
		"CLOUDFLARE_OAUTH_SCOPES",
		"CLOUDFLARE_OAUTH_AUTHORIZE_URL",
		"CLOUDFLARE_OAUTH_TOKEN_URL",
		"CLOUDFLARE_OAUTH_REVOKE_URL",
		"MAPLE_CLOUDFLARE_API_BASE_URL",
	),
})

/** PlanetScale integration (OAuth application — confidential client, no PKCE). */
export const planetScaleOAuthEnv = (): WorkerEnv => ({
	...optionalSecret("PLANETSCALE_OAUTH_CLIENT_SECRET"),
	...optionalPlainGroup(
		"PLANETSCALE_OAUTH_CLIENT_ID",
		"PLANETSCALE_OAUTH_AUTHORIZE_URL",
		"PLANETSCALE_OAUTH_TOKEN_URL",
		"PLANETSCALE_OAUTH_TOKEN_INFO_URL",
		"MAPLE_PLANETSCALE_API_BASE_URL",
	),
})

/** Apple push (iOS app) — token auth; see `apps/api/src/platform/Apns.ts`. */
export const apnsEnv = (): WorkerEnv => ({
	...optionalSecret("APNS_PRIVATE_KEY"),
	...optionalPlainGroup("APNS_TEAM_ID", "APNS_KEY_ID"),
})

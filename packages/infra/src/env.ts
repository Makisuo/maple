import * as Config from "effect/Config"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { optionalString } from "./config-helpers.ts"
import type { MapleStage } from "./cloudflare/stage.ts"
import { resolveDeploymentEnvironment } from "./cloudflare/stage.ts"

/**
 * Deploy-time environment for the Cloudflare workers.
 *
 * Every worker used to carry its own copy of `requireEnv` / `optionalPlain` /
 * `optionalSecret` and then re-list the same keys, so `api` and `alerting`
 * shared 32 hand-copied entries that drifted whenever one was edited alone.
 * The primitives live here once, and the shared keys are grouped by the concern
 * that owns them: a worker spreads the groups it needs and lists only what is
 * genuinely its own.
 *
 * These are effect `Config`s, not `process.env` reads, and that is load-bearing
 * rather than stylistic. Alchemy resolves config through a ConfigProvider built
 * as `fromDotEnv(--env-file ?? ".env")` **orElse** `fromEnv()`
 * (`alchemy/Util/ConfigProvider.ts`) and never copies those file-sourced values
 * into `process.env`. A `process.env` read therefore silently ignores `.env` and
 * `--env-file` — and would do so *selectively*, since alchemy's own provider
 * settings (CLOUDFLARE_ACCOUNT_ID, CI, …) would still pick them up. `Config`
 * also reports every missing key at once instead of throwing on the first, and
 * keeps failures in the typed error channel (`ConfigError`) rather than as a
 * thrown `Error`, which is what the rest of the repo does — see
 * `packages/alchemy-maple/src/MapleEnvironment.ts` for the same pattern inside
 * an alchemy provider.
 *
 * The three rules the primitives encode:
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

/**
 * Present-and-non-blank, trimmed.
 *
 * Built on `./config-helpers.ts`' `optionalString`, which
 * already encodes "blank or whitespace-only counts as absent" for the runtime
 * worker env schemas. The trim on top is the one thing it does not do — it
 * returns the raw value — and the deploy path has always trimmed.
 */
const trimmedOption = (key: string): Config.Config<Option.Option<string>> =>
	optionalString(key).pipe(
		Config.map((value: Option.Option<string>) => Option.map(value, (raw) => raw.trim())),
	)

const entry = <A>(key: string, value: Option.Option<A>): Record<string, A> =>
	Option.match(value, { onNone: () => ({}), onSome: (v) => ({ [key]: v }) })

/** Merge several partial-record configs into one. */
export const merge = (...parts: ReadonlyArray<Config.Config<Partial<WorkerEnv>>>): Config.Config<WorkerEnv> =>
	Config.all(parts).pipe(
		Config.map(
			(records: ReadonlyArray<Partial<WorkerEnv>>) => Object.assign({}, ...records) as WorkerEnv,
		),
	)

/**
 * Required plain value. Fails with a `ConfigError` — not a thrown `Error` — so a
 * deploy missing several vars reports all of them in one pass.
 *
 * `Schema.Trim` before the non-empty check, so `"   "` is rejected rather than
 * binding an empty string.
 */
export const requiredPlain = (key: string): Config.Config<string> =>
	Config.schema(Schema.Trim.check(Schema.isNonEmpty()), key)

/** Required secret, wrapped in `Redacted`. */
export const requiredSecret = (key: string): Config.Config<Redacted.Redacted<string>> =>
	requiredPlain(key).pipe(Config.map(Redacted.make))

/** Required plain value as a single-entry record, for spreading into a group. */
export const requirePlainEntry = (key: string): Config.Config<PlainEnv> =>
	requiredPlain(key).pipe(Config.map((value) => ({ [key]: value })))

/** Required secret as a single-entry record. */
export const requireSecretEntry = (key: string): Config.Config<SecretEnv> =>
	requiredSecret(key).pipe(Config.map((value) => ({ [key]: value })))

/** Optional plain value, omitted when unset. `fallback` applies only if the key is absent. */
export const optionalPlain = (key: string, fallback?: string): Config.Config<PlainEnv> =>
	trimmedOption(key).pipe(
		Config.map((value) => {
			const resolved = Option.getOrUndefined(value) ?? fallback?.trim()
			return resolved ? { [key]: resolved } : {}
		}),
	)

/** Optional secret, omitted when unset. */
export const optionalSecret = (key: string): Config.Config<SecretEnv> =>
	trimmedOption(key).pipe(Config.map((value) => entry(key, Option.map(value, Redacted.make))))

/**
 * Optional value with a default that a BLANK env var also falls back to.
 *
 * Distinct from `Config.withDefault`, which only fires when the key is missing:
 * `MAPLE_AUTH_MODE=""` must still yield `"self_hosted"`, matching the
 * `process.env.X?.trim() || "…"` these replaced.
 */
export const plainWithDefault = (key: string, fallback: string): Config.Config<PlainEnv> =>
	trimmedOption(key).pipe(Config.map((value) => ({ [key]: Option.getOrElse(value, () => fallback) })))

/**
 * A value the stack CHOOSES rather than reads — the environment cannot override it.
 *
 * Distinct from `optionalPlain(key, fallback)`, where the environment wins. The
 * difference is load-bearing for `MAPLE_ENVIRONMENT`: a stray
 * `MAPLE_ENVIRONMENT=production` in a pr-N deploy environment would open
 * `EmailService.emailAllowed` and the alerting worker's `scheduled()`
 * early-return at once, on a stage that shares live org data.
 */
export const derived = (key: string, value: string): Config.Config<PlainEnv> =>
	Config.succeed({ [key]: value })

// ── Shared groups ───────────────────────────────────────────────────────────

/**
 * Session auth. The same `AuthEnv` subset `api`, `alerting` and `electric-sync`
 * all resolve callers with.
 */
export const authEnv: Config.Config<WorkerEnv> = merge(
	plainWithDefault("MAPLE_AUTH_MODE", "self_hosted"),
	// Clerk's SDK phones home unless told not to, and says so at every boot.
	derived("CLERK_TELEMETRY_DISABLED", "1"),
	plainWithDefault("MAPLE_DEFAULT_ORG_ID", "default"),
	optionalSecret("MAPLE_ROOT_PASSWORD"),
	optionalSecret("CLERK_SECRET_KEY"),
	optionalPlain("CLERK_PUBLISHABLE_KEY"),
	optionalSecret("CLERK_JWT_KEY"),
)

/**
 * Warehouse access. `SIGNING_KEY` + `WORKSPACE_ID` are what
 * `TinybirdOrgTokenService` needs for Tinybird-scoped raw SQL — without them
 * every alert tick fails with "TINYBIRD_SIGNING_KEY is required for
 * Tinybird-scoped raw SQL", which is why `alerting` binds the same set as `api`.
 */
export const tinybirdEnv: Config.Config<WorkerEnv> = merge(
	requirePlainEntry("TINYBIRD_HOST"),
	requireSecretEntry("TINYBIRD_TOKEN"),
	optionalSecret("TINYBIRD_SIGNING_KEY"),
	optionalPlain("TINYBIRD_WORKSPACE_ID"),
	optionalPlain("TINYBIRD_RAW_SQL_JWT_RPS_LIMIT"),
)

/** Ingest-key envelope encryption + lookup HMAC. Required wherever ingest keys are read. */
export const ingestKeyCryptoEnv: Config.Config<WorkerEnv> = merge(
	requireSecretEntry("MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
	requireSecretEntry("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
)

/** Public URLs the workers build links with (emails, share links, quick-start snippets). */
export const appUrlsEnv: Config.Config<WorkerEnv> = merge(
	plainWithDefault("MAPLE_INGEST_PUBLIC_URL", "https://ingest.maple.dev"),
	plainWithDefault("MAPLE_APP_BASE_URL", "https://app.maple.dev"),
	plainWithDefault("EMAIL_FROM", "Maple <notifications@noreply.maple.dev>"),
)

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
export const selfObservabilityEnv = (stage: MapleStage): Config.Config<WorkerEnv> =>
	merge(
		// Bound under a different name than it is read from. Optional on dev stages
		// only: no developer has a real ingest key, and absent means self-observability off.
		stage.kind === "dev"
			? optionalSecret("MAPLE_OTEL_INGEST_KEY").pipe(
					Config.map((record) =>
						"MAPLE_OTEL_INGEST_KEY" in record
							? { MAPLE_INGEST_KEY: record.MAPLE_OTEL_INGEST_KEY }
							: {},
					),
				)
			: requiredSecret("MAPLE_OTEL_INGEST_KEY").pipe(
					Config.map((value) => ({ MAPLE_INGEST_KEY: value })),
				),
		optionalPlain("MAPLE_ENDPOINT"),
		derived("MAPLE_ENVIRONMENT", resolveDeploymentEnvironment(stage)),
		// GITHUB_SHA is read as its own key and re-labelled, rather than passed to
		// `optionalPlain`'s `fallback` — a `process.env.GITHUB_SHA` read there would
		// bypass the ConfigProvider and so miss `.env` / `--env-file`.
		merge(optionalPlain("COMMIT_SHA"), optionalPlain("GITHUB_SHA")).pipe(
			Config.map((record): PlainEnv => {
				const sha = record.COMMIT_SHA ?? record.GITHUB_SHA
				return typeof sha === "string" && sha ? { COMMIT_SHA: sha } : {}
			}),
		),
	)

/** Cloudflare account integration (account OAuth — Authorization Code + PKCE). */
export const cloudflareOAuthEnv: Config.Config<WorkerEnv> = merge(
	optionalPlain("CLOUDFLARE_OAUTH_CLIENT_ID"),
	optionalSecret("CLOUDFLARE_OAUTH_CLIENT_SECRET"),
	optionalPlain("CLOUDFLARE_OAUTH_SCOPES"),
	optionalPlain("CLOUDFLARE_OAUTH_AUTHORIZE_URL"),
	optionalPlain("CLOUDFLARE_OAUTH_TOKEN_URL"),
	optionalPlain("CLOUDFLARE_OAUTH_REVOKE_URL"),
	optionalPlain("MAPLE_CLOUDFLARE_API_BASE_URL"),
)

/** PlanetScale integration (OAuth application — confidential client, no PKCE). */
export const planetScaleOAuthEnv: Config.Config<WorkerEnv> = merge(
	optionalPlain("PLANETSCALE_OAUTH_CLIENT_ID"),
	optionalSecret("PLANETSCALE_OAUTH_CLIENT_SECRET"),
	optionalPlain("PLANETSCALE_OAUTH_AUTHORIZE_URL"),
	optionalPlain("PLANETSCALE_OAUTH_TOKEN_URL"),
	optionalPlain("PLANETSCALE_OAUTH_TOKEN_INFO_URL"),
	optionalPlain("MAPLE_PLANETSCALE_API_BASE_URL"),
)

/** Apple push (iOS app) — token auth; see `apps/api/src/platform/Apns.ts`. */
export const apnsEnv: Config.Config<WorkerEnv> = merge(
	optionalPlain("APNS_TEAM_ID"),
	optionalPlain("APNS_KEY_ID"),
	optionalSecret("APNS_PRIVATE_KEY"),
)

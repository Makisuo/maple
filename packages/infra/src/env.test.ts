import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { describe, expect, it } from "vitest"
import {
	apnsEnv,
	appUrlsEnv,
	authEnv,
	cloudflareOAuthEnv,
	derived,
	ingestKeyCryptoEnv,
	optionalPlain,
	optionalSecret,
	planetScaleOAuthEnv,
	plainWithDefault,
	requiredPlain,
	selfObservabilityEnv,
	tinybirdEnv,
	type WorkerEnv,
} from "./env.ts"

/**
 * These groups replaced per-worker copies of the same expressions. The parity
 * blocks below reconstruct the OLD expressions verbatim (from the pre-refactor
 * `apps/api` and `apps/alerting` stack files, with the `process.env` lookup
 * swapped for an explicit record) and assert the group produces an identical
 * result — that equivalence, not the group's internals, is what keeps a
 * deploy's Worker bindings unchanged.
 *
 * Everything runs against an explicit `ConfigProvider` rather than by mutating
 * `process.env`, which is also the point of the refactor: alchemy resolves
 * config through a provider layered over `.env` / `--env-file`, so that is the
 * path worth testing.
 */

type Env = Record<string, string>

const run = <A>(config: Config.Config<A>, env: Env): A =>
	Effect.runSync(config.parse(ConfigProvider.fromUnknown(env)))

const runExit = <A>(config: Config.Config<A>, env: Env) =>
	Effect.runSync(Effect.exit(config.parse(ConfigProvider.fromUnknown(env))))

/** Compare records where secret values are `Redacted` (not deep-equal friendly). */
const unwrap = (env: WorkerEnv): Env =>
	Object.fromEntries(
		Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? v : `redacted:${Redacted.value(v)}`]),
	)

describe("primitives", () => {
	it("resolves a value present only in the provider, not in process.env", () => {
		// The regression this refactor exists to prevent: alchemy layers
		// `fromDotEnv(.env / --env-file)` over `fromEnv()` and never copies those
		// values into process.env, so a process.env read would miss this entirely.
		expect("MAPLE_ENDPOINT" in process.env).toBe(false)
		expect(run(optionalPlain("MAPLE_ENDPOINT"), { MAPLE_ENDPOINT: "https://from-dotenv" })).toEqual({
			MAPLE_ENDPOINT: "https://from-dotenv",
		})
	})

	it("requiredPlain fails on absent, empty and whitespace-only values", () => {
		expect(runExit(requiredPlain("TINYBIRD_HOST"), {})._tag).toBe("Failure")
		expect(runExit(requiredPlain("TINYBIRD_HOST"), { TINYBIRD_HOST: "" })._tag).toBe("Failure")
		expect(runExit(requiredPlain("TINYBIRD_HOST"), { TINYBIRD_HOST: "   " })._tag).toBe("Failure")
	})

	it("requiredPlain trims", () => {
		expect(run(requiredPlain("TINYBIRD_HOST"), { TINYBIRD_HOST: "  https://api.tinybird.co  " })).toBe(
			"https://api.tinybird.co",
		)
	})

	it("omits an unset optional key entirely rather than binding an empty string", () => {
		expect(run(optionalPlain("MAPLE_ENDPOINT"), {})).toEqual({})
		expect(run(optionalSecret("CLERK_JWT_KEY"), {})).toEqual({})
		expect("MAPLE_ENDPOINT" in run(optionalPlain("MAPLE_ENDPOINT"), {})).toBe(false)
	})

	it("treats a whitespace-only optional value as absent", () => {
		expect(run(optionalPlain("MAPLE_ENDPOINT"), { MAPLE_ENDPOINT: "   " })).toEqual({})
		expect(run(optionalSecret("CLERK_JWT_KEY"), { CLERK_JWT_KEY: "  " })).toEqual({})
	})

	it("trims optional values", () => {
		expect(run(optionalPlain("MAPLE_ENDPOINT"), { MAPLE_ENDPOINT: " https://x " })).toEqual({
			MAPLE_ENDPOINT: "https://x",
		})
	})

	it("redacts optional secrets", () => {
		const record = run(optionalSecret("CLERK_JWT_KEY"), { CLERK_JWT_KEY: "jwt-secret" })
		expect(String(record.CLERK_JWT_KEY)).not.toContain("jwt-secret")
		expect(Redacted.value(record.CLERK_JWT_KEY!)).toBe("jwt-secret")
	})

	it("applies an optionalPlain fallback only when the key is absent", () => {
		expect(run(optionalPlain("MAPLE_ENDPOINT", "https://fallback"), {})).toEqual({
			MAPLE_ENDPOINT: "https://fallback",
		})
		expect(
			run(optionalPlain("MAPLE_ENDPOINT", "https://fallback"), { MAPLE_ENDPOINT: "https://env" }),
		).toEqual({ MAPLE_ENDPOINT: "https://env" })
	})

	it("plainWithDefault also falls back for a blank value, unlike Config.withDefault", () => {
		expect(run(plainWithDefault("MAPLE_AUTH_MODE", "self_hosted"), {})).toEqual({
			MAPLE_AUTH_MODE: "self_hosted",
		})
		expect(run(plainWithDefault("MAPLE_AUTH_MODE", "self_hosted"), { MAPLE_AUTH_MODE: "  " })).toEqual({
			MAPLE_AUTH_MODE: "self_hosted",
		})
		expect(run(plainWithDefault("MAPLE_AUTH_MODE", "self_hosted"), { MAPLE_AUTH_MODE: "clerk" })).toEqual(
			{ MAPLE_AUTH_MODE: "clerk" },
		)
	})

	it("derived ignores the provider — that is the whole point of it", () => {
		expect(run(derived("MAPLE_ENVIRONMENT", "pr-42"), { MAPLE_ENVIRONMENT: "production" })).toEqual({
			MAPLE_ENVIRONMENT: "pr-42",
		})
	})
})

describe("selfObservabilityEnv", () => {
	const base = { MAPLE_OTEL_INGEST_KEY: "maple_ak_test" }

	it("derives MAPLE_ENVIRONMENT from the stage and refuses a provider override", () => {
		const env = { ...base, MAPLE_ENVIRONMENT: "production" }
		expect(run(selfObservabilityEnv({ kind: "pr", prNumber: 42 }), env).MAPLE_ENVIRONMENT).toBe("pr-42")
		expect(run(selfObservabilityEnv({ kind: "stg" }), env).MAPLE_ENVIRONMENT).toBe("staging")
		expect(run(selfObservabilityEnv({ kind: "prd" }), env).MAPLE_ENVIRONMENT).toBe("production")
		expect(run(selfObservabilityEnv({ kind: "dev", name: "x" }), env).MAPLE_ENVIRONMENT).toBe(
			"development",
		)
	})

	it("falls back to GITHUB_SHA when COMMIT_SHA is unset", () => {
		expect(run(selfObservabilityEnv({ kind: "prd" }), { ...base, GITHUB_SHA: "abc123" }).COMMIT_SHA).toBe(
			"abc123",
		)
	})

	it("prefers COMMIT_SHA over GITHUB_SHA", () => {
		const env = { ...base, GITHUB_SHA: "abc123", COMMIT_SHA: "def456" }
		expect(run(selfObservabilityEnv({ kind: "prd" }), env).COMMIT_SHA).toBe("def456")
	})

	it("omits COMMIT_SHA when neither is set", () => {
		expect("COMMIT_SHA" in run(selfObservabilityEnv({ kind: "prd" }), base)).toBe(false)
	})

	it("binds the ingest key redacted, under the MAPLE_INGEST_KEY name", () => {
		const env = run(selfObservabilityEnv({ kind: "prd" }), base)
		expect(Redacted.value(env.MAPLE_INGEST_KEY as Redacted.Redacted<string>)).toBe("maple_ak_test")
		expect("MAPLE_OTEL_INGEST_KEY" in env).toBe(false)
	})

	it("fails when the ingest key is missing", () => {
		expect(runExit(selfObservabilityEnv({ kind: "prd" }), {})._tag).toBe("Failure")
		expect(runExit(selfObservabilityEnv({ kind: "stg" }), {})._tag).toBe("Failure")
		expect(runExit(selfObservabilityEnv({ kind: "pr", prNumber: 7 }), {})._tag).toBe("Failure")
	})

	it("omits the ingest key on a dev stage rather than failing", () => {
		// `alchemy dev` resolves this contract on the developer's machine, where
		// there is no ingest key — a required one refuses to start the stack.
		const env = run(selfObservabilityEnv({ kind: "dev", name: "x" }), {})
		expect("MAPLE_INGEST_KEY" in env).toBe(false)
		expect(env.MAPLE_ENVIRONMENT).toBe("development")
	})

	it("still binds the ingest key on a dev stage when one is set", () => {
		const env = run(selfObservabilityEnv({ kind: "dev", name: "x" }), base)
		expect(Redacted.value(env.MAPLE_INGEST_KEY as Redacted.Redacted<string>)).toBe("maple_ak_test")
		expect("MAPLE_OTEL_INGEST_KEY" in env).toBe(false)
	})
})

describe("parity with the pre-refactor per-worker expressions", () => {
	// Verbatim reconstructions of what api/alerting inlined before the groups
	// existed, with `process.env` swapped for the record under test.
	const oldOptionalPlain = (env: Env, key: string, fallback?: string): Env => {
		const value = env[key]?.trim() || fallback
		return value ? { [key]: value } : {}
	}
	const oldOptionalSecret = (env: Env, key: string): Record<string, Redacted.Redacted<string>> => {
		const value = env[key]?.trim()
		return value ? { [key]: Redacted.make(value) } : {}
	}
	const oldRequireEnv = (env: Env, key: string): string => {
		const value = env[key]?.trim()
		if (!value) throw new Error(`Missing required deployment env: ${key}`)
		return value
	}

	const populated = (keys: ReadonlyArray<string>): Env =>
		Object.fromEntries(keys.map((key) => [key, `value-for-${key}`]))

	const AUTH = ["MAPLE_AUTH_MODE", "MAPLE_DEFAULT_ORG_ID", "CLERK_PUBLISHABLE_KEY"]
	const AUTH_SECRETS = ["MAPLE_ROOT_PASSWORD", "CLERK_SECRET_KEY", "CLERK_JWT_KEY"]
	const TINYBIRD_REQUIRED = ["TINYBIRD_HOST", "TINYBIRD_TOKEN"]
	const TINYBIRD_OPTIONAL = [
		"TINYBIRD_SIGNING_KEY",
		"TINYBIRD_WORKSPACE_ID",
		"TINYBIRD_RAW_SQL_JWT_RPS_LIMIT",
	]
	const CRYPTO = ["MAPLE_INGEST_KEY_ENCRYPTION_KEY", "MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"]
	const APP_URLS = ["MAPLE_INGEST_PUBLIC_URL", "MAPLE_APP_BASE_URL", "EMAIL_FROM"]
	const APNS = ["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY"]
	const CF_OAUTH = [
		"CLOUDFLARE_OAUTH_CLIENT_ID",
		"CLOUDFLARE_OAUTH_CLIENT_SECRET",
		"CLOUDFLARE_OAUTH_SCOPES",
		"CLOUDFLARE_OAUTH_AUTHORIZE_URL",
		"CLOUDFLARE_OAUTH_TOKEN_URL",
		"CLOUDFLARE_OAUTH_REVOKE_URL",
		"MAPLE_CLOUDFLARE_API_BASE_URL",
	]
	const PS_OAUTH = [
		"PLANETSCALE_OAUTH_CLIENT_ID",
		"PLANETSCALE_OAUTH_CLIENT_SECRET",
		"PLANETSCALE_OAUTH_AUTHORIZE_URL",
		"PLANETSCALE_OAUTH_TOKEN_URL",
		"PLANETSCALE_OAUTH_TOKEN_INFO_URL",
		"MAPLE_PLANETSCALE_API_BASE_URL",
	]

	// A plain loop, not `describe.each` — the typed-tuple inference in `.each`
	// blows tsc's memory on this repo's config.
	const cases: ReadonlyArray<readonly [string, boolean]> = [
		["all shared keys set", true],
		["every optional key unset", false],
	]

	for (const [label, full] of cases) {
		describe(label, () => {
			it("authEnv", () => {
				const env = full ? populated([...AUTH, ...AUTH_SECRETS]) : {}
				const old = {
					MAPLE_AUTH_MODE: env.MAPLE_AUTH_MODE?.trim() || "self_hosted",
					MAPLE_DEFAULT_ORG_ID: env.MAPLE_DEFAULT_ORG_ID?.trim() || "default",
					...oldOptionalSecret(env, "MAPLE_ROOT_PASSWORD"),
					...oldOptionalSecret(env, "CLERK_SECRET_KEY"),
					...oldOptionalPlain(env, "CLERK_PUBLISHABLE_KEY"),
					...oldOptionalSecret(env, "CLERK_JWT_KEY"),
				}
				expect(unwrap(run(authEnv, env))).toEqual(unwrap(old))
			})

			it("tinybirdEnv", () => {
				const env = populated(full ? [...TINYBIRD_REQUIRED, ...TINYBIRD_OPTIONAL] : TINYBIRD_REQUIRED)
				const old = {
					TINYBIRD_HOST: oldRequireEnv(env, "TINYBIRD_HOST"),
					TINYBIRD_TOKEN: Redacted.make(oldRequireEnv(env, "TINYBIRD_TOKEN")),
					...oldOptionalSecret(env, "TINYBIRD_SIGNING_KEY"),
					...oldOptionalPlain(env, "TINYBIRD_WORKSPACE_ID"),
					...oldOptionalPlain(env, "TINYBIRD_RAW_SQL_JWT_RPS_LIMIT"),
				}
				expect(unwrap(run(tinybirdEnv, env))).toEqual(unwrap(old))
			})

			it("ingestKeyCryptoEnv", () => {
				const env = populated(CRYPTO)
				const old = {
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Redacted.make(
						oldRequireEnv(env, "MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
					),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: Redacted.make(
						oldRequireEnv(env, "MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
					),
				}
				expect(unwrap(run(ingestKeyCryptoEnv, env))).toEqual(unwrap(old))
			})

			it("appUrlsEnv", () => {
				const env = full ? populated(APP_URLS) : {}
				const old = {
					MAPLE_INGEST_PUBLIC_URL:
						env.MAPLE_INGEST_PUBLIC_URL?.trim() || "https://ingest.maple.dev",
					MAPLE_APP_BASE_URL: env.MAPLE_APP_BASE_URL?.trim() || "https://app.maple.dev",
					EMAIL_FROM: env.EMAIL_FROM?.trim() || "Maple <notifications@noreply.maple.dev>",
				}
				expect(unwrap(run(appUrlsEnv, env))).toEqual(unwrap(old))
			})

			it("selfObservabilityEnv", () => {
				const keys = full
					? ["MAPLE_OTEL_INGEST_KEY", "MAPLE_ENDPOINT", "COMMIT_SHA"]
					: ["MAPLE_OTEL_INGEST_KEY"]
				const env = populated(keys)
				const old = {
					MAPLE_INGEST_KEY: Redacted.make(oldRequireEnv(env, "MAPLE_OTEL_INGEST_KEY")),
					...oldOptionalPlain(env, "MAPLE_ENDPOINT"),
					MAPLE_ENVIRONMENT: "staging",
					...oldOptionalPlain(env, "COMMIT_SHA", env.GITHUB_SHA?.trim()),
				}
				expect(unwrap(run(selfObservabilityEnv({ kind: "stg" }), env))).toEqual(unwrap(old))
			})

			it("apnsEnv", () => {
				const env = full ? populated(APNS) : {}
				const old = {
					...oldOptionalPlain(env, "APNS_TEAM_ID"),
					...oldOptionalPlain(env, "APNS_KEY_ID"),
					...oldOptionalSecret(env, "APNS_PRIVATE_KEY"),
				}
				expect(unwrap(run(apnsEnv, env))).toEqual(unwrap(old))
			})

			it("cloudflareOAuthEnv", () => {
				const env = full ? populated(CF_OAUTH) : {}
				const old = {
					...oldOptionalPlain(env, "CLOUDFLARE_OAUTH_CLIENT_ID"),
					...oldOptionalSecret(env, "CLOUDFLARE_OAUTH_CLIENT_SECRET"),
					...oldOptionalPlain(env, "CLOUDFLARE_OAUTH_SCOPES"),
					...oldOptionalPlain(env, "CLOUDFLARE_OAUTH_AUTHORIZE_URL"),
					...oldOptionalPlain(env, "CLOUDFLARE_OAUTH_TOKEN_URL"),
					...oldOptionalPlain(env, "CLOUDFLARE_OAUTH_REVOKE_URL"),
					...oldOptionalPlain(env, "MAPLE_CLOUDFLARE_API_BASE_URL"),
				}
				expect(unwrap(run(cloudflareOAuthEnv, env))).toEqual(unwrap(old))
			})

			it("planetScaleOAuthEnv matches the api worker's set", () => {
				const env = full ? populated(PS_OAUTH) : {}
				const old = {
					...oldOptionalPlain(env, "PLANETSCALE_OAUTH_CLIENT_ID"),
					...oldOptionalSecret(env, "PLANETSCALE_OAUTH_CLIENT_SECRET"),
					...oldOptionalPlain(env, "PLANETSCALE_OAUTH_AUTHORIZE_URL"),
					...oldOptionalPlain(env, "PLANETSCALE_OAUTH_TOKEN_URL"),
					...oldOptionalPlain(env, "PLANETSCALE_OAUTH_TOKEN_INFO_URL"),
					...oldOptionalPlain(env, "MAPLE_PLANETSCALE_API_BASE_URL"),
				}
				expect(unwrap(run(planetScaleOAuthEnv, env))).toEqual(unwrap(old))
			})
		})
	}

	/**
	 * The one deliberate binding change. `alerting` previously omitted
	 * PLANETSCALE_OAUTH_TOKEN_INFO_URL while `api` bound it, even though both run
	 * token refresh through PlanetScaleOAuthService. The shared group binds it for
	 * both; it is optional, so a stage that does not set it is unaffected.
	 */
	it("adds TOKEN_INFO_URL to the alerting worker, which api already had", () => {
		const env = { PLANETSCALE_OAUTH_TOKEN_INFO_URL: "https://auth.planetscale.com/tokeninfo" }
		expect(run(planetScaleOAuthEnv, env).PLANETSCALE_OAUTH_TOKEN_INFO_URL).toBe(
			"https://auth.planetscale.com/tokeninfo",
		)
	})
})

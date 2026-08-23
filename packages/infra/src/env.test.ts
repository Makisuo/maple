import * as Redacted from "effect/Redacted"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
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
	requireEnv,
	requireSecret,
	selfObservabilityEnv,
	tinybirdEnv,
} from "./env.ts"

/**
 * These groups replaced per-worker copies of the same expressions. The parity
 * blocks below reconstruct the OLD expressions verbatim (from the pre-refactor
 * `apps/api` and `apps/alerting` stack files) and assert the group produces an
 * identical record — that equivalence, not the group's internals, is what keeps
 * a deploy's Worker bindings unchanged.
 */

const TOUCHED = [
	"MAPLE_AUTH_MODE",
	"MAPLE_DEFAULT_ORG_ID",
	"MAPLE_ROOT_PASSWORD",
	"CLERK_SECRET_KEY",
	"CLERK_PUBLISHABLE_KEY",
	"CLERK_JWT_KEY",
	"TINYBIRD_HOST",
	"TINYBIRD_TOKEN",
	"TINYBIRD_SIGNING_KEY",
	"TINYBIRD_WORKSPACE_ID",
	"TINYBIRD_RAW_SQL_JWT_RPS_LIMIT",
	"MAPLE_INGEST_KEY_ENCRYPTION_KEY",
	"MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY",
	"MAPLE_INGEST_PUBLIC_URL",
	"MAPLE_APP_BASE_URL",
	"EMAIL_FROM",
	"MAPLE_OTEL_INGEST_KEY",
	"MAPLE_ENDPOINT",
	"MAPLE_ENVIRONMENT",
	"COMMIT_SHA",
	"GITHUB_SHA",
	"APNS_TEAM_ID",
	"APNS_KEY_ID",
	"APNS_PRIVATE_KEY",
	"CLOUDFLARE_OAUTH_CLIENT_ID",
	"CLOUDFLARE_OAUTH_CLIENT_SECRET",
	"CLOUDFLARE_OAUTH_SCOPES",
	"CLOUDFLARE_OAUTH_AUTHORIZE_URL",
	"CLOUDFLARE_OAUTH_TOKEN_URL",
	"CLOUDFLARE_OAUTH_REVOKE_URL",
	"MAPLE_CLOUDFLARE_API_BASE_URL",
	"PLANETSCALE_OAUTH_CLIENT_ID",
	"PLANETSCALE_OAUTH_CLIENT_SECRET",
	"PLANETSCALE_OAUTH_AUTHORIZE_URL",
	"PLANETSCALE_OAUTH_TOKEN_URL",
	"PLANETSCALE_OAUTH_TOKEN_INFO_URL",
	"MAPLE_PLANETSCALE_API_BASE_URL",
] as const

const saved = new Map<string, string | undefined>()

beforeEach(() => {
	for (const key of TOUCHED) {
		saved.set(key, process.env[key])
		delete process.env[key]
	}
})

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key]
		else process.env[key] = value
	}
	saved.clear()
})

/** Compare records where secret values are `Redacted` (which is not deep-equal friendly). */
const unwrap = (env: Record<string, string | Redacted.Redacted<string>>): Record<string, string> =>
	Object.fromEntries(
		Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? v : `redacted:${Redacted.value(v)}`]),
	)

describe("helpers", () => {
	it("requireEnv throws on absent, empty and whitespace-only values", () => {
		expect(() => requireEnv("TINYBIRD_HOST")).toThrow(/Missing required deployment env: TINYBIRD_HOST/)
		process.env.TINYBIRD_HOST = ""
		expect(() => requireEnv("TINYBIRD_HOST")).toThrow()
		process.env.TINYBIRD_HOST = "   "
		expect(() => requireEnv("TINYBIRD_HOST")).toThrow()
	})

	it("requireEnv trims", () => {
		process.env.TINYBIRD_HOST = "  https://api.tinybird.co  "
		expect(requireEnv("TINYBIRD_HOST")).toBe("https://api.tinybird.co")
	})

	it("requireSecret redacts rather than exposing the value", () => {
		process.env.TINYBIRD_TOKEN = "p.secret"
		const secret = requireSecret("TINYBIRD_TOKEN")
		expect(String(secret)).not.toContain("p.secret")
		expect(Redacted.value(secret)).toBe("p.secret")
	})

	it("omits an unset optional key entirely rather than binding an empty string", () => {
		expect(optionalPlain("MAPLE_ENDPOINT")).toEqual({})
		expect(optionalSecret("CLERK_JWT_KEY")).toEqual({})
		expect("MAPLE_ENDPOINT" in optionalPlain("MAPLE_ENDPOINT")).toBe(false)
	})

	it("treats a whitespace-only optional value as absent", () => {
		process.env.MAPLE_ENDPOINT = "   "
		expect(optionalPlain("MAPLE_ENDPOINT")).toEqual({})
	})

	it("applies an optionalPlain fallback only when the env var is absent", () => {
		expect(optionalPlain("MAPLE_ENDPOINT", "https://fallback")).toEqual({
			MAPLE_ENDPOINT: "https://fallback",
		})
		process.env.MAPLE_ENDPOINT = "https://from-env"
		expect(optionalPlain("MAPLE_ENDPOINT", "https://fallback")).toEqual({
			MAPLE_ENDPOINT: "https://from-env",
		})
	})

	it("omits the key when both the env var and the fallback are absent", () => {
		expect(optionalPlain("COMMIT_SHA", undefined)).toEqual({})
	})

	it("derived ignores the environment — that is the whole point of it", () => {
		process.env.MAPLE_ENVIRONMENT = "production"
		expect(derived("MAPLE_ENVIRONMENT", "pr-42")).toEqual({ MAPLE_ENVIRONMENT: "pr-42" })
	})
})

describe("selfObservabilityEnv", () => {
	beforeEach(() => {
		process.env.MAPLE_OTEL_INGEST_KEY = "maple_ak_test"
	})

	it("derives MAPLE_ENVIRONMENT from the stage and refuses an env override", () => {
		process.env.MAPLE_ENVIRONMENT = "production"
		expect(selfObservabilityEnv({ kind: "pr", prNumber: 42 }).MAPLE_ENVIRONMENT).toBe("pr-42")
		expect(selfObservabilityEnv({ kind: "stg" }).MAPLE_ENVIRONMENT).toBe("staging")
		expect(selfObservabilityEnv({ kind: "prd" }).MAPLE_ENVIRONMENT).toBe("production")
	})

	it("falls back to GITHUB_SHA when COMMIT_SHA is unset", () => {
		process.env.GITHUB_SHA = "abc123"
		expect(selfObservabilityEnv({ kind: "prd" }).COMMIT_SHA).toBe("abc123")
	})

	it("prefers COMMIT_SHA over GITHUB_SHA", () => {
		process.env.GITHUB_SHA = "abc123"
		process.env.COMMIT_SHA = "def456"
		expect(selfObservabilityEnv({ kind: "prd" }).COMMIT_SHA).toBe("def456")
	})

	it("omits COMMIT_SHA when neither is set", () => {
		expect("COMMIT_SHA" in selfObservabilityEnv({ kind: "prd" })).toBe(false)
	})

	it("binds the ingest key redacted, under the MAPLE_INGEST_KEY name", () => {
		const env = selfObservabilityEnv({ kind: "prd" })
		expect(Redacted.value(env.MAPLE_INGEST_KEY as Redacted.Redacted<string>)).toBe("maple_ak_test")
		expect("MAPLE_OTEL_INGEST_KEY" in env).toBe(false)
	})
})

describe("parity with the pre-refactor per-worker expressions", () => {
	// Verbatim reconstructions of what api/alerting inlined before the groups existed.
	const oldOptionalPlain = (key: string, fallback?: string): Record<string, string> => {
		const value = process.env[key]?.trim() || fallback
		return value ? { [key]: value } : {}
	}
	const oldOptionalSecret = (key: string): Record<string, Redacted.Redacted<string>> => {
		const value = process.env[key]?.trim()
		return value ? { [key]: Redacted.make(value) } : {}
	}
	const oldRequireEnv = (key: string): string => {
		const value = process.env[key]?.trim()
		if (!value) throw new Error(`Missing required deployment env: ${key}`)
		return value
	}

	const populate = (keys: ReadonlyArray<string>) => {
		for (const key of keys) process.env[key] = `value-for-${key}`
	}

	// A plain loop, not `describe.each` — the typed-tuple inference in `.each`
	// blows tsc's memory on this repo's config.
	const cases: ReadonlyArray<readonly [string, boolean]> = [
		["all shared keys set", true],
		["every optional key unset", false],
	]
	for (const [label, populated] of cases) {
		describe(label, () => {
			it("authEnv", () => {
				if (populated) {
					populate(["MAPLE_AUTH_MODE", "MAPLE_DEFAULT_ORG_ID", "CLERK_PUBLISHABLE_KEY"])
					populate(["MAPLE_ROOT_PASSWORD", "CLERK_SECRET_KEY", "CLERK_JWT_KEY"])
				}
				const old = {
					MAPLE_AUTH_MODE: process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted",
					MAPLE_DEFAULT_ORG_ID: process.env.MAPLE_DEFAULT_ORG_ID?.trim() || "default",
					...oldOptionalSecret("MAPLE_ROOT_PASSWORD"),
					...oldOptionalSecret("CLERK_SECRET_KEY"),
					...oldOptionalPlain("CLERK_PUBLISHABLE_KEY"),
					...oldOptionalSecret("CLERK_JWT_KEY"),
				}
				expect(unwrap(authEnv())).toEqual(unwrap(old))
			})

			it("tinybirdEnv", () => {
				populate(["TINYBIRD_HOST", "TINYBIRD_TOKEN"]) // required in both shapes
				if (populated) {
					populate([
						"TINYBIRD_SIGNING_KEY",
						"TINYBIRD_WORKSPACE_ID",
						"TINYBIRD_RAW_SQL_JWT_RPS_LIMIT",
					])
				}
				const old = {
					TINYBIRD_HOST: oldRequireEnv("TINYBIRD_HOST"),
					TINYBIRD_TOKEN: Redacted.make(oldRequireEnv("TINYBIRD_TOKEN")),
					...oldOptionalSecret("TINYBIRD_SIGNING_KEY"),
					...oldOptionalPlain("TINYBIRD_WORKSPACE_ID"),
					...oldOptionalPlain("TINYBIRD_RAW_SQL_JWT_RPS_LIMIT"),
				}
				expect(unwrap(tinybirdEnv())).toEqual(unwrap(old))
			})

			it("ingestKeyCryptoEnv", () => {
				populate(["MAPLE_INGEST_KEY_ENCRYPTION_KEY", "MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"])
				const old = {
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Redacted.make(
						oldRequireEnv("MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
					),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: Redacted.make(
						oldRequireEnv("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
					),
				}
				expect(unwrap(ingestKeyCryptoEnv())).toEqual(unwrap(old))
			})

			it("appUrlsEnv", () => {
				if (populated) populate(["MAPLE_INGEST_PUBLIC_URL", "MAPLE_APP_BASE_URL", "EMAIL_FROM"])
				const old = {
					MAPLE_INGEST_PUBLIC_URL:
						process.env.MAPLE_INGEST_PUBLIC_URL?.trim() || "https://ingest.maple.dev",
					MAPLE_APP_BASE_URL: process.env.MAPLE_APP_BASE_URL?.trim() || "https://app.maple.dev",
					EMAIL_FROM: process.env.EMAIL_FROM?.trim() || "Maple <notifications@noreply.maple.dev>",
				}
				expect(unwrap(appUrlsEnv())).toEqual(unwrap(old))
			})

			it("selfObservabilityEnv", () => {
				populate(["MAPLE_OTEL_INGEST_KEY"])
				if (populated) populate(["MAPLE_ENDPOINT", "COMMIT_SHA"])
				const old = {
					MAPLE_INGEST_KEY: Redacted.make(oldRequireEnv("MAPLE_OTEL_INGEST_KEY")),
					...oldOptionalPlain("MAPLE_ENDPOINT"),
					MAPLE_ENVIRONMENT: "staging",
					...oldOptionalPlain("COMMIT_SHA", process.env.GITHUB_SHA?.trim()),
				}
				expect(unwrap(selfObservabilityEnv({ kind: "stg" }))).toEqual(unwrap(old))
			})

			it("apnsEnv", () => {
				if (populated) populate(["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY"])
				const old = {
					...oldOptionalPlain("APNS_TEAM_ID"),
					...oldOptionalPlain("APNS_KEY_ID"),
					...oldOptionalSecret("APNS_PRIVATE_KEY"),
				}
				expect(unwrap(apnsEnv())).toEqual(unwrap(old))
			})

			it("cloudflareOAuthEnv", () => {
				if (populated) {
					populate([
						"CLOUDFLARE_OAUTH_CLIENT_ID",
						"CLOUDFLARE_OAUTH_CLIENT_SECRET",
						"CLOUDFLARE_OAUTH_SCOPES",
						"CLOUDFLARE_OAUTH_AUTHORIZE_URL",
						"CLOUDFLARE_OAUTH_TOKEN_URL",
						"CLOUDFLARE_OAUTH_REVOKE_URL",
						"MAPLE_CLOUDFLARE_API_BASE_URL",
					])
				}
				const old = {
					...oldOptionalPlain("CLOUDFLARE_OAUTH_CLIENT_ID"),
					...oldOptionalSecret("CLOUDFLARE_OAUTH_CLIENT_SECRET"),
					...oldOptionalPlain("CLOUDFLARE_OAUTH_SCOPES"),
					...oldOptionalPlain("CLOUDFLARE_OAUTH_AUTHORIZE_URL"),
					...oldOptionalPlain("CLOUDFLARE_OAUTH_TOKEN_URL"),
					...oldOptionalPlain("CLOUDFLARE_OAUTH_REVOKE_URL"),
					...oldOptionalPlain("MAPLE_CLOUDFLARE_API_BASE_URL"),
				}
				expect(unwrap(cloudflareOAuthEnv())).toEqual(unwrap(old))
			})

			it("planetScaleOAuthEnv matches the api worker's set", () => {
				if (populated) {
					populate([
						"PLANETSCALE_OAUTH_CLIENT_ID",
						"PLANETSCALE_OAUTH_CLIENT_SECRET",
						"PLANETSCALE_OAUTH_AUTHORIZE_URL",
						"PLANETSCALE_OAUTH_TOKEN_URL",
						"PLANETSCALE_OAUTH_TOKEN_INFO_URL",
						"MAPLE_PLANETSCALE_API_BASE_URL",
					])
				}
				const old = {
					...oldOptionalPlain("PLANETSCALE_OAUTH_CLIENT_ID"),
					...oldOptionalSecret("PLANETSCALE_OAUTH_CLIENT_SECRET"),
					...oldOptionalPlain("PLANETSCALE_OAUTH_AUTHORIZE_URL"),
					...oldOptionalPlain("PLANETSCALE_OAUTH_TOKEN_URL"),
					...oldOptionalPlain("PLANETSCALE_OAUTH_TOKEN_INFO_URL"),
					...oldOptionalPlain("MAPLE_PLANETSCALE_API_BASE_URL"),
				}
				expect(unwrap(planetScaleOAuthEnv())).toEqual(unwrap(old))
			})
		})
	}

	/**
	 * The one deliberate behaviour change. `alerting` previously omitted
	 * PLANETSCALE_OAUTH_TOKEN_INFO_URL while `api` bound it, even though both run
	 * token refresh through PlanetScaleOAuthService. The shared group binds it for
	 * both; it is optional, so a stage that does not set it is unaffected.
	 */
	it("adds TOKEN_INFO_URL to the alerting worker, which api already had", () => {
		process.env.PLANETSCALE_OAUTH_TOKEN_INFO_URL = "https://auth.planetscale.com/tokeninfo"
		expect(planetScaleOAuthEnv().PLANETSCALE_OAUTH_TOKEN_INFO_URL).toBe(
			"https://auth.planetscale.com/tokeninfo",
		)
	})
})

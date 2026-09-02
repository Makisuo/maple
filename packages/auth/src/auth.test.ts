import { assert, describe, it } from "@effect/vitest"
import { createHmac } from "node:crypto"
import { Effect, Exit, Option, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { AuthorizationUnavailableError, OrgId, RoleName, UserId } from "@maple/domain/http"
import {
	makeGetCustomerData,
	makeLoginSelfHosted,
	makeRefreshSelfHostedSession,
	makeResolveMcpTenant,
	makeResolveTenant,
	ORG_SELECTION_HEADER,
	SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS,
	SELF_HOSTED_SESSION_TTL_SECONDS,
} from "./index"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)

const baseEnv = {
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: Option.some(Redacted.make("root-password")),
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_ORG_ID_OVERRIDE: Option.none(),
	CLERK_SECRET_KEY: Option.none(),
	CLERK_PUBLISHABLE_KEY: Option.none(),
	CLERK_JWT_KEY: Option.none(),
} as const

const getFailure = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
	Option.getOrUndefined(Exit.findErrorOption(exit))

// A signing oracle for the self-hosted HS256 scheme: these tokens carry a VALID
// signature made with the real root password, so they get past signature
// verification. Everything they exercise is claim validation.
const rootPassword = "root-password"
const base64UrlJson = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

// Takes the payload as raw JSON text so a test can express shapes `JSON.stringify`
// cannot round-trip — notably an overflowing number literal, which `JSON.parse`
// turns into `Infinity` while `JSON.stringify(Infinity)` would emit `null`.
const signClaimsJson = (claimsJson: string, header: unknown = { alg: "HS256", typ: "JWT" }): string => {
	const data = `${base64UrlJson(header)}.${Buffer.from(claimsJson).toString("base64url")}`
	return `${data}.${createHmac("sha256", rootPassword).update(data).digest("base64url")}`
}

const signClaims = (claims: unknown, header?: unknown): string =>
	signClaimsJson(JSON.stringify(claims), header)

// TestClock starts at epoch 0; park it at a round wall-clock so `exp`/`nbf`
// boundaries are exact rather than racing the real clock.
const clockSeconds = 1_700_000_000

// `iat` is required, so the baseline carries one. It is parked at "now" so that
// claim-shape tests below exercise the shape they name and not the max-age rule.
const validClaims = {
	sub: "root",
	org_id: "default",
	roles: ["root"],
	authMode: "self_hosted",
	iat: clockSeconds,
}
const atFixedTime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		yield* TestClock.adjust(`${clockSeconds} seconds`)
		return yield* effect
	})

const resolveSignedToken = (token: string) =>
	atFixedTime(Effect.exit(makeResolveTenant(baseEnv)({ authorization: `Bearer ${token}` })))

const resolveSignedClaims = (claims: unknown, header?: unknown) =>
	resolveSignedToken(signClaims(claims, header))

const resolveSignedClaimsJson = (claimsJson: string) => resolveSignedToken(signClaimsJson(claimsJson))

const assertRejected = <A>(exit: Exit.Exit<A, unknown>, message: string) => {
	const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined
	assert.isTrue(Exit.isFailure(exit))
	assert.strictEqual(failure?._tag, "@maple/http/errors/UnauthorizedError")
	assert.strictEqual(failure?.message, message)
}

describe("makeResolveTenant", () => {
	it.effect("resolves a Clerk tenant from verified session claims", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
				},
				async () => ({
					isAuthenticated: true,
					message: null,
					toAuth: () => ({
						isAuthenticated: true,
						tokenType: "session_token",
						userId: "user_123",
						orgId: "org_123",
						orgRole: "org:admin",
					}),
				}),
			)

			const tenant = yield* resolveTenant({
				authorization: "Bearer test-token",
			})

			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("org_123"),
				userId: asUserId("user_123"),
				roles: [asRoleName("org:admin")],
				authMode: "clerk",
			})
		}),
	)

	it.effect("rejects Clerk auth when no bearer token is present", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
				},
				async () => ({
					isAuthenticated: false,
					message: "Session token missing",
					toAuth: () => ({
						isAuthenticated: false,
						tokenType: "session_token",
						userId: null,
						orgId: null,
						orgRole: null,
					}),
				}),
			)

			const exit = yield* Effect.exit(resolveTenant({}))
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/UnauthorizedError")
			assert.strictEqual(failure?.message, "Session token missing")
		}),
	)

	it.effect("rejects invalid or expired Clerk tokens", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
				},
				async () => {
					throw new Error("token verification failed")
				},
			)

			const exit = yield* Effect.exit(
				resolveTenant({
					authorization: "Bearer bad-token",
				}),
			)
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/UnauthorizedError")
			assert.strictEqual(failure?.message, "Clerk authentication failed: token verification failed")
		}),
	)

	it.effect("rejects Clerk users without an active organization", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
				},
				async () => ({
					isAuthenticated: true,
					message: null,
					toAuth: () => ({
						isAuthenticated: true,
						tokenType: "session_token",
						userId: "user_123",
						orgId: null,
						orgRole: null,
					}),
				}),
			)

			const exit = yield* Effect.exit(
				resolveTenant({
					authorization: "Bearer test-token",
				}),
			)
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/UnauthorizedError")
			assert.strictEqual(failure?.message, "Active organization is required")
		}),
	)

	it.effect("rejects self-hosted requests without a bearer token", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(baseEnv)

			const exit = yield* Effect.exit(resolveTenant({}))
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/UnauthorizedError")
			assert.strictEqual(failure?.message, "Self-hosted mode requires a valid bearer token")
		}),
	)

	it.effect("rejects self-hosted requests with invalid token signature", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(baseEnv)

			const exit = yield* Effect.exit(
				resolveTenant({
					authorization: "Bearer invalid.token.signature",
				}),
			)
			const failure = getFailure(exit) as { _tag?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/UnauthorizedError")
		}),
	)

	it.effect("accepts valid self-hosted bearer tokens", () =>
		Effect.gen(function* () {
			const loginSelfHosted = makeLoginSelfHosted(baseEnv)
			const resolveTenant = makeResolveTenant(baseEnv)
			const login = yield* loginSelfHosted("root-password")

			const tenant = yield* resolveTenant({
				authorization: `Bearer ${login.token}`,
			})

			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("default"),
				userId: asUserId("root"),
				roles: [asRoleName("root")],
				authMode: "self_hosted",
			})
		}),
	)
})

describe("makeResolveMcpTenant", () => {
	it.effect("resolves tenant from an org API key", () =>
		Effect.gen(function* () {
			const resolveMcpTenant = makeResolveMcpTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
				},
				async () => ({
					isAuthenticated: true,
					message: null,
					toAuth: () => ({
						isAuthenticated: true,
						tokenType: "api_key",
						userId: "user_abc",
						orgId: "org_abc",
						orgRole: "org:member",
					}),
				}),
			)

			const tenant = yield* resolveMcpTenant({
				authorization: "Bearer maple_key_xxx",
			})

			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("org_abc"),
				userId: asUserId("user_abc"),
				roles: [asRoleName("org:member")],
				authMode: "clerk",
			})
		}),
	)

	it.effect("resolves tenant from a user API key with MAPLE_ORG_ID_OVERRIDE", () =>
		Effect.gen(function* () {
			const resolveMcpTenant = makeResolveMcpTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
					MAPLE_ORG_ID_OVERRIDE: Option.some("org_override"),
				},
				async () => ({
					isAuthenticated: true,
					message: null,
					toAuth: () => ({
						isAuthenticated: true,
						tokenType: "api_key",
						userId: "user_abc",
						orgId: null,
						orgRole: null,
					}),
				}),
			)

			const tenant = yield* resolveMcpTenant({
				authorization: "Bearer maple_key_xxx",
			})

			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("org_override"),
				userId: asUserId("user_abc"),
				roles: [],
				authMode: "clerk",
			})
		}),
	)

	it.effect("rejects a user API key without org context", () =>
		Effect.gen(function* () {
			const resolveMcpTenant = makeResolveMcpTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
				},
				async () => ({
					isAuthenticated: true,
					message: null,
					toAuth: () => ({
						isAuthenticated: true,
						tokenType: "api_key",
						userId: "user_abc",
						orgId: null,
						orgRole: null,
					}),
				}),
			)

			const exit = yield* Effect.exit(
				resolveMcpTenant({
					authorization: "Bearer maple_key_xxx",
				}),
			)
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/UnauthorizedError")
			assert.strictEqual(failure?.message, "Active organization is required")
		}),
	)

	it.effect("falls through to self-hosted mode when MAPLE_AUTH_MODE is self_hosted", () =>
		Effect.gen(function* () {
			const loginSelfHosted = makeLoginSelfHosted(baseEnv)
			const resolveMcpTenant = makeResolveMcpTenant(baseEnv)
			const login = yield* loginSelfHosted("root-password")

			const tenant = yield* resolveMcpTenant({
				authorization: `Bearer ${login.token}`,
			})

			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("default"),
				userId: asUserId("root"),
				roles: [asRoleName("root")],
				authMode: "self_hosted",
			})
		}),
	)
})

describe("makeGetCustomerData", () => {
	it.effect("returns null identity outside Clerk mode (no enrichment, no regression)", () =>
		Effect.gen(function* () {
			const getCustomerData = makeGetCustomerData(baseEnv)

			const result = yield* getCustomerData({
				orgId: asOrgId("default"),
				userId: asUserId("root"),
				roles: [asRoleName("root")],
				authMode: "self_hosted",
			})

			assert.deepStrictEqual(result, { email: null, orgName: null })
		}),
	)
})

describe("makeLoginSelfHosted", () => {
	it.effect("rejects invalid root passwords", () =>
		Effect.gen(function* () {
			const loginSelfHosted = makeLoginSelfHosted(baseEnv)
			const exit = yield* Effect.exit(loginSelfHosted("wrong-password"))
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/SelfHostedInvalidPasswordError")
			assert.strictEqual(failure?.message, "Invalid root password")
		}),
	)
})

describe("makeResolveMcpTenant", () => {
	// Regression: a logged-in browser applying an approved chat proposal via
	// POST /internal/chat/apply sends a Clerk session_token. The MCP tenant fallback
	// must accept it (not only api_key), or every Clerk-mode apply fails.
	it.effect("accepts a Clerk session_token and resolves the caller's org", () =>
		Effect.gen(function* () {
			let seenAcceptsToken: unknown
			const resolveMcpTenant = makeResolveMcpTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
				},
				async (_request, options) => {
					seenAcceptsToken = (options as { acceptsToken?: unknown } | undefined)?.acceptsToken
					return {
						isAuthenticated: true,
						message: null,
						toAuth: () => ({
							isAuthenticated: true,
							tokenType: "session_token",
							userId: "user_123",
							orgId: "org_123",
							orgRole: "org:admin",
						}),
					}
				},
			)

			const tenant = yield* resolveMcpTenant({ authorization: "Bearer session-token" })

			assert.deepStrictEqual(seenAcceptsToken, ["api_key", "session_token"])
			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("org_123"),
				userId: asUserId("user_123"),
				roles: [asRoleName("org:admin")],
				authMode: "clerk",
			})
		}),
	)
})

// A correctly signed token is NOT a valid session. Anyone holding the root
// password can mint arbitrary claims, and a self-hosted deployment may still be
// carrying tokens minted by an older build, so every claim shape below has to be
// judged on its own merits by `SelfHostedSessionClaims`.
describe("self-hosted session claims (correctly signed, malformed)", () => {
	it.effect("rejects a token whose authMode is not the self_hosted literal", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ ...validClaims, authMode: "clerk" }),
				"Invalid self-hosted session token",
			)
		}),
	)

	it.effect("rejects a token with no authMode claim", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ sub: "root", org_id: "default", roles: ["root"] }),
				"Invalid self-hosted session token",
			)
		}),
	)

	it.effect("rejects a token with no sub claim", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ org_id: "default", roles: ["root"], authMode: "self_hosted" }),
				"Invalid self-hosted session token",
			)
		}),
	)

	it.effect("rejects a token with no org_id claim", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ sub: "root", roles: ["root"], authMode: "self_hosted" }),
				"Invalid self-hosted session token",
			)
		}),
	)

	it.effect("rejects an untrimmed sub (UserId is a trimmed brand)", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ ...validClaims, sub: "root " }),
				"Invalid self-hosted session token",
			)
		}),
	)

	it.effect("rejects an empty org_id", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ ...validClaims, org_id: "" }),
				"Invalid self-hosted session token",
			)
		}),
	)

	it.effect("rejects a non-string role entry", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ ...validClaims, roles: [1, 2] }),
				"Invalid self-hosted session token",
			)
		}),
	)

	it.effect("rejects a blank role entry inside a roles array", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ ...validClaims, roles: ["root", "  "] }),
				"Invalid self-hosted session token",
			)
		}),
	)

	// `iat` is required, not optional: `signHs256Jwt` has always emitted one, so
	// requiring it invalidates nothing already issued — and it is the claim the
	// max-age rule needs in order to bound a token that predates `exp`.
	it.effect("rejects a token with no iat claim", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({
					sub: "root",
					org_id: "default",
					roles: ["root"],
					authMode: "self_hosted",
				}),
				"Invalid self-hosted session token",
			)
		}),
	)

	it.effect("rejects a non-numeric iat", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ ...validClaims, iat: `${clockSeconds}` }),
				"Invalid self-hosted session token",
			)
		}),
	)

	it.effect("rejects a non-numeric session_exp", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ ...validClaims, session_exp: "4102444800" }),
				"Invalid self-hosted session token",
			)
		}),
	)

	it.effect("rejects a non-numeric exp", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ ...validClaims, exp: "4102444800" }),
				"Invalid self-hosted session token",
			)
		}),
	)

	it.effect("rejects a non-finite exp (an overflowing literal parses to Infinity)", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaimsJson(
					`{"sub":"root","org_id":"default","roles":["root"],"authMode":"self_hosted","iat":${clockSeconds},"exp":1e999}`,
				),
				"Invalid self-hosted session token",
			)
		}),
	)

	it.effect("normalizes a comma-separated roles claim", () =>
		Effect.gen(function* () {
			const exit = yield* resolveSignedClaims({ ...validClaims, roles: " root , viewer " })

			assert.isTrue(Exit.isSuccess(exit))
			assert.deepStrictEqual(Exit.isSuccess(exit) ? exit.value.roles : undefined, [
				asRoleName("root"),
				asRoleName("viewer"),
			])
		}),
	)

	it.effect("defaults an absent roles claim to root", () =>
		Effect.gen(function* () {
			const exit = yield* resolveSignedClaims({
				sub: "root",
				org_id: "default",
				authMode: "self_hosted",
				iat: clockSeconds,
			})

			assert.isTrue(Exit.isSuccess(exit))
			assert.deepStrictEqual(Exit.isSuccess(exit) ? exit.value.roles : undefined, [asRoleName("root")])
		}),
	)

	it.effect("defaults an empty roles claim to root", () =>
		Effect.gen(function* () {
			const exit = yield* resolveSignedClaims({ ...validClaims, roles: [] })

			assert.isTrue(Exit.isSuccess(exit))
			assert.deepStrictEqual(Exit.isSuccess(exit) ? exit.value.roles : undefined, [asRoleName("root")])
		}),
	)

	it.effect("ignores unknown claims rather than trusting them", () =>
		Effect.gen(function* () {
			const exit = yield* resolveSignedClaims({ ...validClaims, admin: true, org_id_override: "other" })

			assert.isTrue(Exit.isSuccess(exit))
			assert.deepStrictEqual(Exit.isSuccess(exit) ? exit.value : undefined, {
				orgId: asOrgId("default"),
				userId: asUserId("root"),
				roles: [asRoleName("root")],
				authMode: "self_hosted",
			})
		}),
	)
})

describe("self-hosted session temporal boundaries", () => {
	it.effect("rejects an expired token", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ ...validClaims, exp: clockSeconds - 1 }),
				"JWT has expired",
			)
		}),
	)

	// RFC 7519 §4.1.4: the current time must be BEFORE `exp`, so `now === exp` is expired.
	it.effect("rejects a token exactly at its exp boundary", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ ...validClaims, exp: clockSeconds }),
				"JWT has expired",
			)
		}),
	)

	it.effect("accepts a token one second before its exp boundary", () =>
		Effect.gen(function* () {
			const exit = yield* resolveSignedClaims({ ...validClaims, exp: clockSeconds + 1 })

			assert.isTrue(Exit.isSuccess(exit))
		}),
	)

	// Regression: `exp: 0` is a token that expired at the epoch. A truthiness guard
	// (`if (payload.exp && ...)`) skipped the check entirely and accepted it forever.
	it.effect("rejects exp = 0 instead of reading it as no expiry", () =>
		Effect.gen(function* () {
			assertRejected(yield* resolveSignedClaims({ ...validClaims, exp: 0 }), "JWT has expired")
		}),
	)

	it.effect("rejects a not-yet-valid token", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ ...validClaims, nbf: clockSeconds + 60 }),
				"JWT is not active yet",
			)
		}),
	)

	// RFC 7519 §4.1.5: the current time must be AT or after `nbf`, so `now === nbf` is active.
	it.effect("accepts a token exactly at its nbf boundary", () =>
		Effect.gen(function* () {
			const exit = yield* resolveSignedClaims({ ...validClaims, nbf: clockSeconds })

			assert.isTrue(Exit.isSuccess(exit))
		}),
	)

	it.effect("rejects a token one second before its nbf boundary", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ ...validClaims, nbf: clockSeconds + 1 }),
				"JWT is not active yet",
			)
		}),
	)

	it.effect("accepts nbf = 0 (already active) and a token with no exp", () =>
		Effect.gen(function* () {
			const exit = yield* resolveSignedClaims({ ...validClaims, nbf: 0 })

			assert.isTrue(Exit.isSuccess(exit))
		}),
	)

	// `iat` in the future is either a skewed minter or a forgery buying itself
	// extra room under the max-age rule. Only the first is tolerated, by seconds.
	it.effect("rejects a token issued in the future beyond the clock-skew leeway", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({ ...validClaims, iat: clockSeconds + 61 }),
				"JWT was issued in the future",
			)
		}),
	)

	it.effect("accepts a token issued slightly ahead, within the clock-skew leeway", () =>
		Effect.gen(function* () {
			const exit = yield* resolveSignedClaims({ ...validClaims, iat: clockSeconds + 60 })

			assert.isTrue(Exit.isSuccess(exit))
		}),
	)

	// The rollout rule: a token minted before `exp` existed carries only `iat`, and
	// this is what eventually retires it. Until then it keeps working, which is why
	// `exp` cannot be required on the verify side yet.
	it.effect("accepts a legacy token with no exp while it is inside the max lifetime", () =>
		Effect.gen(function* () {
			const exit = yield* resolveSignedClaims({
				...validClaims,
				iat: clockSeconds - SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS + 1,
			})

			assert.isTrue(Exit.isSuccess(exit))
		}),
	)

	it.effect("rejects a legacy token with no exp once it passes the max lifetime", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({
					...validClaims,
					iat: clockSeconds - SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS,
				}),
				"JWT has expired",
			)
		}),
	)

	// A live `exp` does not rescue a session past its absolute deadline — that is
	// the whole point of tracking the two separately.
	it.effect("rejects a token whose session_exp has passed even though exp has not", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims({
					...validClaims,
					exp: clockSeconds + 3600,
					session_exp: clockSeconds,
				}),
				"Self-hosted session has expired",
			)
		}),
	)

	it.effect("accepts a token one second before its session_exp", () =>
		Effect.gen(function* () {
			const exit = yield* resolveSignedClaims({
				...validClaims,
				exp: clockSeconds + 3600,
				session_exp: clockSeconds + 1,
			})

			assert.isTrue(Exit.isSuccess(exit))
		}),
	)
})

describe("self-hosted session lifetime", () => {
	const decodeTokenClaims = (token: string): Record<string, unknown> => {
		const payload = token.split(".")[1] ?? ""
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
	}

	// TestClock adjustments accumulate within a test, so these advance by a DELTA
	// and never re-park. `atFixedTime` parks the clock and must stay single-use.
	const advanceBy = (seconds: number) => TestClock.adjust(`${seconds} seconds`)

	const resolveToken = (token: string) =>
		Effect.exit(makeResolveTenant(baseEnv)({ authorization: `Bearer ${token}` }))

	it.effect("mints a token bounded by both the token TTL and the absolute session deadline", () =>
		Effect.gen(function* () {
			yield* advanceBy(clockSeconds)
			const login = yield* makeLoginSelfHosted(baseEnv)("root-password")
			const claims = decodeTokenClaims(login.token)

			assert.strictEqual(claims.iat, clockSeconds)
			assert.strictEqual(claims.exp, clockSeconds + SELF_HOSTED_SESSION_TTL_SECONDS)
			assert.strictEqual(claims.session_exp, clockSeconds + SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS)
			// The response mirrors the claims in epoch millis so a non-browser client
			// knows when to renew without decoding the JWT itself.
			assert.strictEqual(login.expiresAt, (clockSeconds + SELF_HOSTED_SESSION_TTL_SECONDS) * 1000)
			assert.strictEqual(
				login.sessionExpiresAt,
				(clockSeconds + SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS) * 1000,
			)
		}),
	)

	// The finding this change closes: a minted token used to verify forever.
	it.effect("stops accepting a minted token once its TTL elapses", () =>
		Effect.gen(function* () {
			yield* advanceBy(clockSeconds)
			const login = yield* makeLoginSelfHosted(baseEnv)("root-password")

			yield* advanceBy(SELF_HOSTED_SESSION_TTL_SECONDS - 1)
			assert.isTrue(Exit.isSuccess(yield* resolveToken(login.token)))

			yield* advanceBy(1)
			assertRejected(yield* resolveToken(login.token), "JWT has expired")
		}),
	)

	it.effect("renews into a token that outlives the one it replaced", () =>
		Effect.gen(function* () {
			yield* advanceBy(clockSeconds)
			const login = yield* makeLoginSelfHosted(baseEnv)("root-password")

			yield* advanceBy(SELF_HOSTED_SESSION_TTL_SECONDS - 60)
			const renewed = yield* makeRefreshSelfHostedSession(baseEnv)(login.token)

			assert.strictEqual(renewed.orgId, asOrgId("default"))
			assert.strictEqual(renewed.userId, asUserId("root"))

			// Past the original token's expiry, the old one is dead and the new one lives.
			yield* advanceBy(120)
			assertRejected(yield* resolveToken(login.token), "JWT has expired")
			assert.isTrue(Exit.isSuccess(yield* resolveToken(renewed.token)))
		}),
	)

	// Renewal must not be a way to hold a session open forever: the absolute
	// deadline is set once, at login, and every renewal copies it unchanged.
	it.effect("carries the absolute session deadline forward rather than extending it", () =>
		Effect.gen(function* () {
			yield* advanceBy(clockSeconds)
			const login = yield* makeLoginSelfHosted(baseEnv)("root-password")

			yield* advanceBy(SELF_HOSTED_SESSION_TTL_SECONDS - 60)
			const renewed = yield* makeRefreshSelfHostedSession(baseEnv)(login.token)

			assert.strictEqual(renewed.sessionExpiresAt, login.sessionExpiresAt)
			assert.strictEqual(
				decodeTokenClaims(renewed.token).session_exp,
				clockSeconds + SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS,
			)
		}),
	)

	// The last renewal before the deadline must not hand out a token that outlives
	// the session it belongs to.
	it.effect("clamps a renewed token's exp to the session deadline", () =>
		Effect.gen(function* () {
			const sessionExp = clockSeconds + 120
			const token = signClaims({
				...validClaims,
				exp: clockSeconds + 60,
				session_exp: sessionExp,
			})

			const renewed = yield* atFixedTime(makeRefreshSelfHostedSession(baseEnv)(token))

			assert.strictEqual(decodeTokenClaims(renewed.token).exp, sessionExp)
			assert.strictEqual(renewed.expiresAt, sessionExp * 1000)
		}),
	)

	it.effect("refuses to renew a token that has already expired", () =>
		Effect.gen(function* () {
			const token = signClaims({ ...validClaims, exp: clockSeconds - 1 })
			const exit = yield* atFixedTime(Effect.exit(makeRefreshSelfHostedSession(baseEnv)(token)))

			assertRejected(exit, "JWT has expired")
		}),
	)

	it.effect("refuses to renew once the absolute session deadline has passed", () =>
		Effect.gen(function* () {
			const token = signClaims({
				...validClaims,
				exp: clockSeconds + 3600,
				session_exp: clockSeconds,
			})
			const exit = yield* atFixedTime(Effect.exit(makeRefreshSelfHostedSession(baseEnv)(token)))

			assertRejected(exit, "Self-hosted session has expired")
		}),
	)

	// Rollout: a token minted before `session_exp` existed renews into a bounded
	// one, and its deadline is the same one the max-age rule already enforces
	// against it — renewal is not an escape from that clock.
	it.effect("gives a legacy token a bounded deadline derived from its own iat", () =>
		Effect.gen(function* () {
			const legacyIat = clockSeconds - 3600
			const token = signClaims({ ...validClaims, iat: legacyIat })

			const renewed = yield* atFixedTime(makeRefreshSelfHostedSession(baseEnv)(token))

			assert.strictEqual(
				renewed.sessionExpiresAt,
				(legacyIat + SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS) * 1000,
			)
			assert.strictEqual(
				decodeTokenClaims(renewed.token).session_exp,
				legacyIat + SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS,
			)
		}),
	)

	it.effect("refuses renewal in Clerk mode, which renews its own sessions", () =>
		Effect.gen(function* () {
			const exit = yield* atFixedTime(
				Effect.exit(
					makeRefreshSelfHostedSession({
						...baseEnv,
						MAPLE_AUTH_MODE: "clerk",
					})(signClaims(validClaims)),
				),
			)
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/SelfHostedAuthDisabledError")
			assert.strictEqual(failure?.message, "Self-hosted session renewal is disabled")
		}),
	)

	it.effect("refuses to renew a token that is not correctly signed", () =>
		Effect.gen(function* () {
			const exit = yield* atFixedTime(
				Effect.exit(makeRefreshSelfHostedSession(baseEnv)("invalid.token.signature")),
			)

			assertRejected(exit, "Invalid JWT header")
		}),
	)
})

describe("self-hosted JWT algorithm pinning", () => {
	it.effect("rejects alg: none", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims(validClaims, { alg: "none", typ: "JWT" }),
				"Unsupported JWT algorithm",
			)
		}),
	)

	it.effect("rejects an asymmetric alg", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims(validClaims, { alg: "RS256", typ: "JWT" }),
				"Unsupported JWT algorithm",
			)
		}),
	)

	it.effect("rejects a header with no alg", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims(validClaims, { typ: "JWT" }),
				"Unsupported JWT algorithm",
			)
		}),
	)

	it.effect("rejects a case-folded hs256", () =>
		Effect.gen(function* () {
			assertRejected(
				yield* resolveSignedClaims(validClaims, { alg: "hs256", typ: "JWT" }),
				"Unsupported JWT algorithm",
			)
		}),
	)
})

describe(`${ORG_SELECTION_HEADER} (organization selection)`, () => {
	const clerkEnv = {
		...baseEnv,
		MAPLE_AUTH_MODE: "clerk",
		CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
		CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
	} as const

	const clerkAuth =
		(overrides: { orgId?: string | null; tokenType?: string } = {}) =>
		async () => ({
			isAuthenticated: true,
			message: null,
			toAuth: () => ({
				isAuthenticated: true,
				tokenType: overrides.tokenType ?? "session_token",
				userId: "user_123",
				orgId: overrides.orgId === undefined ? "org_123" : overrides.orgId,
				orgRole: "org:admin",
			}),
		})

	/** Counts calls, because "never asked" is the assertion for the no-op path. */
	const verifier = (memberships: ReadonlyArray<{ orgId: string; role: string }>) => {
		let calls = 0
		const verify = (_userId: UserId, orgId: OrgId) => {
			calls += 1
			const found = memberships.find((membership) => membership.orgId === orgId)
			return Effect.succeed(
				found
					? Option.some({ orgId: asOrgId(found.orgId), role: asRoleName(found.role) })
					: Option.none<{ orgId: OrgId; role: RoleName }>(),
			)
		}
		return { verify, calls: () => calls }
	}

	const assertDenied = <A>(exit: Exit.Exit<A, unknown>) => {
		const failure = getFailure(exit) as { _tag?: string } | undefined
		assert.isTrue(Exit.isFailure(exit))
		assert.strictEqual(failure?._tag, "@maple/http/errors/OrganizationAccessDeniedError")
	}

	it.effect("naming the organization you already have costs nothing", () =>
		Effect.gen(function* () {
			const membership = verifier([{ orgId: "org_123", role: "org:admin" }])
			const resolveTenant = makeResolveTenant(clerkEnv, clerkAuth(), undefined, membership.verify)

			const tenant = yield* resolveTenant({
				authorization: "Bearer test-token",
				[ORG_SELECTION_HEADER]: "org_123",
			})

			assert.strictEqual(tenant.orgId, asOrgId("org_123"))
			// The invariant that keeps a client free to send the header always.
			assert.strictEqual(membership.calls(), 0)
		}),
	)

	it.effect("adopts a verified organization AND its role, not the token's", () =>
		Effect.gen(function* () {
			const membership = verifier([{ orgId: "org_other", role: "org:member" }])
			const resolveTenant = makeResolveTenant(clerkEnv, clerkAuth(), undefined, membership.verify)

			const tenant = yield* resolveTenant({
				authorization: "Bearer test-token",
				[ORG_SELECTION_HEADER]: "org_other",
			})

			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("org_other"),
				// Carrying `org:admin` across would make an admin of one org an
				// admin of every org they belong to.
				roles: [asRoleName("org:member")],
				userId: asUserId("user_123"),
				authMode: "clerk",
			})
		}),
	)

	// The widget's cold case: a token whose session has no active organization
	// at all still resolves when the request names one it can prove.
	it.effect("works with no active organization in the token", () =>
		Effect.gen(function* () {
			const membership = verifier([{ orgId: "org_other", role: "org:member" }])
			const resolveTenant = makeResolveTenant(
				clerkEnv,
				clerkAuth({ orgId: null }),
				undefined,
				membership.verify,
			)

			const tenant = yield* resolveTenant({
				authorization: "Bearer test-token",
				[ORG_SELECTION_HEADER]: "org_other",
			})

			assert.strictEqual(tenant.orgId, asOrgId("org_other"))
		}),
	)

	it.effect("refuses an organization the user is not in", () =>
		Effect.gen(function* () {
			const membership = verifier([])
			const resolveTenant = makeResolveTenant(clerkEnv, clerkAuth(), undefined, membership.verify)

			const exit = yield* Effect.exit(
				resolveTenant({
					authorization: "Bearer test-token",
					[ORG_SELECTION_HEADER]: "org_other",
				}),
			)

			// 403, and deliberately not the 401 that a missing active organization
			// produces — a client must be able to tell "stop asking for that org"
			// from "sign in again".
			assertDenied(exit)
		}),
	)

	it.effect("a lookup failure rejects rather than falling back to the token's org", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(clerkEnv, clerkAuth(), undefined, () =>
				Effect.fail(new AuthorizationUnavailableError({ message: "Clerk unreachable" })),
			)

			const exit = yield* Effect.exit(
				resolveTenant({
					authorization: "Bearer test-token",
					[ORG_SELECTION_HEADER]: "org_other",
				}),
			)
			const failure = getFailure(exit) as { _tag?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/AuthorizationUnavailableError")
		}),
	)

	it.effect("rejects the header when no verifier is wired", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(clerkEnv, clerkAuth())

			const exit = yield* Effect.exit(
				resolveTenant({
					authorization: "Bearer test-token",
					[ORG_SELECTION_HEADER]: "org_other",
				}),
			)

			assertDenied(exit)
		}),
	)

	it.effect("rejects the header for an API-key credential", () =>
		Effect.gen(function* () {
			const membership = verifier([{ orgId: "org_other", role: "org:admin" }])
			const resolveTenant = makeResolveMcpTenant(clerkEnv, clerkAuth({ tokenType: "api_key" }))

			const exit = yield* Effect.exit(
				resolveTenant({
					authorization: "Bearer test-token",
					[ORG_SELECTION_HEADER]: "org_other",
				}),
			)

			assertDenied(exit)
			assert.strictEqual(membership.calls(), 0)
		}),
	)

	it.effect("ignores the selection header when MAPLE_ORG_ID_OVERRIDE pins the deployment", () =>
		Effect.gen(function* () {
			const membership = verifier([{ orgId: "org_other", role: "org:admin" }])
			const resolveTenant = makeResolveTenant(
				{ ...clerkEnv, MAPLE_ORG_ID_OVERRIDE: Option.some("org_pinned") },
				clerkAuth(),
				undefined,
				membership.verify,
			)

			const tenant = yield* resolveTenant({
				authorization: "Bearer test-token",
				[ORG_SELECTION_HEADER]: "org_other",
			})

			assert.strictEqual(tenant.orgId, asOrgId("org_pinned"))
		}),
	)

	// The pin replaces the organization, so it must replace the role too.
	it.effect("MAPLE_ORG_ID_OVERRIDE takes its role from the pinned org's membership", () =>
		Effect.gen(function* () {
			const membership = verifier([{ orgId: "org_pinned", role: "org:member" }])
			const resolveTenant = makeResolveTenant(
				{ ...clerkEnv, MAPLE_ORG_ID_OVERRIDE: Option.some("org_pinned") },
				// The session is an `org:admin` of org_123, a different organization.
				clerkAuth(),
				undefined,
				membership.verify,
			)

			const tenant = yield* resolveTenant({ authorization: "Bearer test-token" })

			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("org_pinned"),
				roles: [asRoleName("org:member")],
				userId: asUserId("user_123"),
				authMode: "clerk",
			})
		}),
	)

	it.effect("MAPLE_ORG_ID_OVERRIDE keeps the session role for a non-member", () =>
		Effect.gen(function* () {
			const membership = verifier([])
			const resolveTenant = makeResolveTenant(
				{ ...clerkEnv, MAPLE_ORG_ID_OVERRIDE: Option.some("org_pinned") },
				clerkAuth(),
				undefined,
				membership.verify,
			)

			const tenant = yield* resolveTenant({ authorization: "Bearer test-token" })

			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("org_pinned"),
				roles: [asRoleName("org:admin")],
				userId: asUserId("user_123"),
				authMode: "clerk",
			})
		}),
	)

	// No membership directory wired (MCP, electric-sync): the session role stands.
	it.effect("MAPLE_ORG_ID_OVERRIDE keeps the session role without a verifier", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(
				{ ...clerkEnv, MAPLE_ORG_ID_OVERRIDE: Option.some("org_pinned") },
				clerkAuth(),
			)

			const tenant = yield* resolveTenant({ authorization: "Bearer test-token" })

			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("org_pinned"),
				roles: [asRoleName("org:admin")],
				userId: asUserId("user_123"),
				authMode: "clerk",
			})
		}),
	)

	// Self-hosted mode has no membership directory, so an honoured header would
	// be unconditional cross-tenant access.
	it.effect("rejects the header in self-hosted mode", () =>
		Effect.gen(function* () {
			const exit = yield* atFixedTime(
				Effect.exit(
					makeResolveTenant(baseEnv)({
						authorization: `Bearer ${signClaims(validClaims)}`,
						[ORG_SELECTION_HEADER]: "org_other",
					}),
				),
			)

			assertDenied(exit)
		}),
	)
})

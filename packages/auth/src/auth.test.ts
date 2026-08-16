import { assert, describe, it } from "@effect/vitest"
import { createHmac } from "node:crypto"
import { Effect, Exit, Option, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { makeGetCustomerData, makeLoginSelfHosted, makeResolveMcpTenant, makeResolveTenant } from "./index"

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

const validClaims = { sub: "root", org_id: "default", roles: ["root"], authMode: "self_hosted" }

// TestClock starts at epoch 0; park it at a round wall-clock so `exp`/`nbf`
// boundaries are exact rather than racing the real clock.
const clockSeconds = 1_700_000_000
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
					'{"sub":"root","org_id":"default","roles":["root"],"authMode":"self_hosted","exp":1e999}',
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

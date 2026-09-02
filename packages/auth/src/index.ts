// Shared auth core for Maple services. These are the pure tenant-resolution +
// self-hosted login primitives — Clerk session verification and self-hosted
// HS256 JWT verify/sign — with NO dependency on any app's `Env` service: every
// factory takes a structural {@link AuthEnv} (or a `Pick` of it). `apps/api`
// wraps these in an `AuthService` Context.Service bound to its `Env`; the
// standalone `apps/electric-sync` worker feeds them its own small config. Auth
// is the one genuinely cross-service concern, so it lives in this lean package
// (effect + @maple/domain + @clerk/backend) rather than an app.
import { createHmac, timingSafeEqual } from "node:crypto"
import { createClerkClient } from "@clerk/backend"
import {
	AuthMode,
	AuthorizationUnavailableError,
	OrganizationAccessDeniedError,
	OrgId,
	RoleName,
	SelfHostedAuthDisabledError,
	SelfHostedInvalidPasswordError,
	SelfHostedLoginResponse,
	UnauthorizedError,
	UserId,
} from "@maple/domain/http"
import { Clock, Effect, Option, Redacted, Schema, SchemaGetter } from "effect"

/**
 * A self-hosted session is bounded by TWO clocks, because the HMAC key IS the
 * root password: there is no session store to revoke against, so the only thing
 * that can end a leaked token is time.
 *
 * - {@link SELF_HOSTED_SESSION_TTL_SECONDS} bounds ONE minted token — short
 *   enough that a leaked token dies on its own, long enough to cover a working
 *   day of dashboard use without a mid-session logout.
 * - {@link SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS} bounds the whole login.
 *   Renewal mints a fresh token but carries the ORIGINAL deadline forward in
 *   `session_exp`, so a stolen token cannot be refreshed forever; past the
 *   deadline the root password has to be entered again.
 *
 * The second clock is what makes the first one mean something. Sliding renewal
 * with no absolute cap is indistinguishable from the non-expiring token this
 * replaced.
 */
export const SELF_HOSTED_SESSION_TTL_SECONDS = 12 * 60 * 60
export const SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS = 7 * 24 * 60 * 60

// Minting and verification normally share one clock (one deployment verifying
// what it just signed), but a multi-instance self-hosted install can skew by a
// few seconds, and a fresh token rejected as "issued in the future" is an
// unrecoverable login loop. The leeway therefore applies ONLY to `iat`, which we
// mint ourselves; `nbf`/`exp` boundaries stay exact because they are
// RFC-specified and, on a correctly signed token, attacker-chosen.
const CLOCK_SKEW_LEEWAY_SECONDS = 60

export interface TenantContext {
	readonly orgId: OrgId
	readonly userId: UserId
	readonly roles: readonly RoleName[]
	readonly authMode: AuthMode
}

type HeaderRecord = Record<string, string | undefined>

const JwtHeaderSchema = Schema.Struct({
	alg: Schema.optionalKey(Schema.String),
})

// RFC 7519 temporal claims are "seconds since epoch" numbers. `isFinite` rejects
// the one JSON-reachable non-number: an overflowing literal such as `1e999`,
// which parses to `Infinity` and would otherwise mean "never expires".
const JwtSeconds = Schema.Number.check(Schema.isFinite())

// A `roles` claim arrives either as an array or as a comma-separated string.
// Normalization is deliberately ASYMMETRIC and must stay that way: the string
// form splits/trims/drops blanks, the array form is passed through untouched so
// that `["root", "  "]` keeps failing `RoleName` (trimmed, min length 1). Trimming
// array entries here would ACCEPT tokens that are rejected today.
const normalizeRoles = (value: readonly string[] | string): readonly string[] => {
	const roles =
		typeof value === "string"
			? value
					.split(",")
					.map((part) => part.trim())
					.filter(Boolean)
			: value
	// A self-hosted token that names no role is the root operator: the HMAC key IS
	// the root password, so signing capability already implies root. Preserved from
	// the pre-schema code path rather than introduced here.
	return roles.length > 0 ? roles : ["root"]
}

const SelfHostedRoles = Schema.Union([Schema.Array(Schema.String), Schema.String]).pipe(
	Schema.decodeTo(Schema.Array(RoleName), {
		decode: SchemaGetter.transform(normalizeRoles),
		encode: SchemaGetter.passthrough({ strict: false }),
	}),
	Schema.withDecodingDefaultKey(Effect.succeed<readonly string[]>([])),
)

/**
 * The self-hosted session contract, decoded IMMEDIATELY after the HMAC signature
 * is verified — there is no permissive intermediate payload and no second
 * validation pipeline downstream.
 *
 * Every field a caller is trusted with is required and branded here: `sub` is a
 * `UserId`, `org_id` an `OrgId`, `roles` a normalized `RoleName[]`, and `authMode`
 * the literal `"self_hosted"` (a Clerk-mode token presented on the self-hosted
 * path is not a self-hosted session).
 *
 * `iat` is REQUIRED: `signHs256Jwt` is the only minter that has ever existed and
 * it has always set `iat`, so requiring it invalidates nothing already issued —
 * and it is what gives a pre-`exp` token a bounded life (see the max-age check in
 * {@link verifySelfHostedSessionToken}). `exp`/`session_exp` stay optional for
 * exactly one release cycle: tokens minted before this change carry neither, and
 * requiring them would log every running deployment out at deploy time. They age
 * out under the max-age rule within
 * {@link SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS}, after which both can be
 * promoted to required. `nbf` is optional because nothing mints it; it is honored
 * if a token carries one.
 */
const SelfHostedSessionClaims = Schema.Struct({
	sub: UserId,
	org_id: OrgId,
	authMode: Schema.Literal("self_hosted"),
	roles: SelfHostedRoles,
	iat: JwtSeconds,
	exp: Schema.optionalKey(JwtSeconds),
	session_exp: Schema.optionalKey(JwtSeconds),
	nbf: Schema.optionalKey(JwtSeconds),
})
type SelfHostedSessionClaims = Schema.Schema.Type<typeof SelfHostedSessionClaims>

const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)
const decodeUserIdSync = Schema.decodeUnknownSync(UserId)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)

const unauthorized = (message: string) =>
	new UnauthorizedError({
		message,
	})

// NOTE: the decode helpers below deliberately discard the parse error and the
// JWT helpers in `verifyHs256Jwt` do the same. Auth failures must NOT leak
// validation hints (e.g. which schema field rejected the input) to unauthorized
// callers — that's an oracle for credential stuffing. Do not refactor these to
// preserve `cause`.
const decodeOrgId = (value: string, message: string): Effect.Effect<OrgId, UnauthorizedError> =>
	Schema.decodeEffect(OrgId)(value).pipe(Effect.mapError(() => unauthorized(message)))

const decodeUserId = (value: string, message: string): Effect.Effect<UserId, UnauthorizedError> =>
	Schema.decodeEffect(UserId)(value).pipe(Effect.mapError(() => unauthorized(message)))

const decodeRoleName = (value: string, message: string): Effect.Effect<RoleName, UnauthorizedError> =>
	Schema.decodeEffect(RoleName)(value).pipe(Effect.mapError(() => unauthorized(message)))

const getHeader = (headers: HeaderRecord, key: string): string | undefined => {
	const exact = headers[key]
	if (exact) return exact
	return headers[key.toLowerCase()]
}

const getBearerToken = (headers: HeaderRecord): string | undefined => {
	const header = getHeader(headers, "authorization")
	if (!header) return undefined
	const [scheme, token] = header.split(" ")
	if (!scheme || !token || scheme.toLowerCase() !== "bearer") return undefined
	return token
}

const toHeaders = (headers: HeaderRecord): Headers => {
	const requestHeaders = new Headers()

	for (const [name, value] of Object.entries(headers)) {
		if (value !== undefined) {
			requestHeaders.set(name, value)
		}
	}

	return requestHeaders
}

const toRequest = (headers: HeaderRecord): Request => {
	const host = getHeader(headers, "host") ?? "localhost"
	const protocol = getHeader(headers, "x-forwarded-proto") ?? "http"

	return new Request(`${protocol}://${host}/`, {
		headers: toHeaders(headers),
	})
}

const decodeBase64Url = (input: string): string => {
	const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
	const padding = normalized.length % 4
	const padded = padding === 0 ? normalized : normalized + "=".repeat(4 - padding)
	return Buffer.from(padded, "base64").toString("utf8")
}

const encodeBase64Url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url")

const verifySelfHostedSessionToken = Effect.fn("AuthService.verifySelfHostedSessionToken")(function* (
	token: string,
	secret: string,
): Effect.fn.Return<SelfHostedSessionClaims, UnauthorizedError> {
	const parts = token.split(".")
	if (parts.length !== 3) {
		return yield* unauthorized("Invalid JWT format")
	}

	const [encodedHeader, encodedPayload, encodedSignature] = parts
	const header = yield* Schema.decodeEffect(Schema.fromJsonString(JwtHeaderSchema))(
		decodeBase64Url(encodedHeader),
	).pipe(Effect.mapError(() => unauthorized("Invalid JWT header")))
	// HS256 is pinned, not negotiated: the header cannot select `none`, another MAC,
	// or an asymmetric algorithm. The only verification below is an HMAC with the
	// root password, so there is no key-confusion surface either.
	if (header.alg !== "HS256") {
		return yield* unauthorized("Unsupported JWT algorithm")
	}

	const data = `${encodedHeader}.${encodedPayload}`
	const expected = createHmac("sha256", secret).update(data).digest("base64url")
	const expectedBuffer = Buffer.from(expected)
	const actualBuffer = Buffer.from(encodedSignature)

	if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
		return yield* unauthorized("Invalid JWT signature")
	}

	const claims = yield* Schema.decodeEffect(Schema.fromJsonString(SelfHostedSessionClaims))(
		decodeBase64Url(encodedPayload),
	).pipe(Effect.mapError(() => unauthorized("Invalid self-hosted session token")))
	// JWT exp/nbf are in seconds since epoch (RFC 7519); divide Clock millis.
	const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)

	// Presence, not truthiness: `exp: 0` is a token that expired at the epoch, and
	// a truthiness guard silently turned it into a token that never expires.
	// Boundaries follow RFC 7519 §4.1.4/§4.1.5 — `now >= exp` is expired, `now == nbf`
	// is already active.
	if (claims.nbf !== undefined && now < claims.nbf) {
		return yield* unauthorized("JWT is not active yet")
	}

	// An `iat` ahead of now is either a skewed minter or a forged claim buying
	// itself extra life under the max-age rule below. Only the first is worth
	// tolerating, and only by seconds.
	if (claims.iat > now + CLOCK_SKEW_LEEWAY_SECONDS) {
		return yield* unauthorized("JWT was issued in the future")
	}

	if (claims.exp !== undefined && now >= claims.exp) {
		return yield* unauthorized("JWT has expired")
	}

	// The absolute deadline of the login this token descends from. It survives
	// renewal unchanged, so refreshing cannot extend a session past it.
	if (claims.session_exp !== undefined && now >= claims.session_exp) {
		return yield* unauthorized("Self-hosted session has expired")
	}

	// The backstop, and the rollout mechanism: a token minted before `exp` existed
	// carries only `iat`, and this is what bounds it. It never fires on a current
	// token — `exp` is at most SELF_HOSTED_SESSION_TTL_SECONDS out and the session
	// deadline is capped at the same horizon — so it costs nothing to keep
	// afterwards as a floor under any future minting bug.
	if (now - claims.iat >= SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS) {
		return yield* unauthorized("JWT has expired")
	}

	return claims
})

type SelfHostedTokenClaims = {
	readonly sub: UserId
	readonly org_id: OrgId
	readonly roles: readonly RoleName[]
	readonly authMode: "self_hosted"
	readonly iat: number
	readonly exp: number
	readonly session_exp: number
}

const signHs256Jwt = (payload: SelfHostedTokenClaims, secret: string): string => {
	const header = { alg: "HS256", typ: "JWT" }
	const encodedHeader = encodeBase64Url(header)
	const encodedPayload = encodeBase64Url(payload)
	const data = `${encodedHeader}.${encodedPayload}`
	const signature = createHmac("sha256", secret).update(data).digest("base64url")
	return `${data}.${signature}`
}

/**
 * The single place a self-hosted session token is minted — login and renewal both
 * go through it, so they cannot drift apart on lifetime.
 *
 * `sessionExpiresAt` is the absolute deadline of the login, chosen once at login
 * and carried forward by every renewal. Clamping `exp` to it is what stops the
 * last renewal before the deadline from handing out a token that outlives it.
 */
const mintSelfHostedSessionToken = (
	tenant: TenantContext,
	nowSeconds: number,
	sessionExpiresAt: number,
	secret: string,
): { readonly token: string; readonly expiresAt: number } => {
	const expiresAt = Math.min(nowSeconds + SELF_HOSTED_SESSION_TTL_SECONDS, sessionExpiresAt)
	const token = signHs256Jwt(
		{
			sub: tenant.userId,
			org_id: tenant.orgId,
			roles: [...tenant.roles],
			authMode: "self_hosted",
			iat: nowSeconds,
			exp: expiresAt,
			session_exp: sessionExpiresAt,
		},
		secret,
	)
	return { token, expiresAt }
}

const constantTimeEquals = (left: string, right: string): boolean => {
	const leftBuffer = Buffer.from(left)
	const rightBuffer = Buffer.from(right)
	const size = Math.max(leftBuffer.length, rightBuffer.length, 1)
	const normalizedLeft = Buffer.alloc(size)
	const normalizedRight = Buffer.alloc(size)

	leftBuffer.copy(normalizedLeft)
	rightBuffer.copy(normalizedRight)

	return leftBuffer.length === rightBuffer.length && timingSafeEqual(normalizedLeft, normalizedRight)
}

const getAuthMode = (mode: string): AuthMode => (mode.toLowerCase() === "clerk" ? "clerk" : "self_hosted")

const makeSelfHostedTenant = (defaultOrgId: string): TenantContext => ({
	orgId: decodeOrgIdSync(defaultOrgId),
	userId: decodeUserIdSync("root"),
	roles: [decodeRoleNameSync("root")],
	authMode: "self_hosted",
})

type ClerkSessionAuth = {
	readonly isAuthenticated: boolean
	readonly tokenType: string | null | undefined
	readonly userId: string | null | undefined
	readonly orgId: string | null | undefined
	readonly orgRole: string | null | undefined
}

type ClerkRequestState = {
	readonly isAuthenticated: boolean
	readonly message: string | null
	readonly toAuth: () => ClerkSessionAuth | null
}

type ClerkAuthenticateRequest = (
	request: Request,
	options: {
		readonly acceptsToken: string | string[]
		readonly jwtKey?: string
	},
) => Promise<ClerkRequestState>

export interface AuthEnv {
	readonly MAPLE_AUTH_MODE: string
	readonly MAPLE_DEFAULT_ORG_ID: string
	readonly MAPLE_ORG_ID_OVERRIDE: Option.Option<string>
	readonly MAPLE_ROOT_PASSWORD: Option.Option<Redacted.Redacted<string>>
	readonly CLERK_SECRET_KEY: Option.Option<Redacted.Redacted<string>>
	readonly CLERK_PUBLISHABLE_KEY: Option.Option<string>
	readonly CLERK_JWT_KEY: Option.Option<Redacted.Redacted<string>>
}

const getOptionalString = <A>(option: Option.Option<A>): A | undefined => Option.getOrUndefined(option)

const getOptionalSecret = (option: Option.Option<Redacted.Redacted<string>>): string | undefined =>
	Option.match(option, { onNone: () => undefined, onSome: Redacted.value })

/**
 * A secret the auth mode requires but the deployment did not supply. Config is
 * read once at layer build, so this is a misconfigured deployment rather than a
 * request that could be answered differently.
 */
class MissingAuthSecretError extends Schema.TaggedError<MissingAuthSecretError>()(
	"@maple/auth/MissingAuthSecretError",
	{ secret: Schema.String, message: Schema.String },
) {}

const requireSecret = (
	option: Option.Option<Redacted.Redacted<string>>,
	label: string,
): Effect.Effect<string, never> =>
	Option.match(option, {
		// Config is read once at layer build, so a missing secret is a misconfigured
		// deployment, not a request that could be answered differently.
		onNone: () =>
			// oxlint-disable-next-line maple/no-effect-die
			Effect.die(new MissingAuthSecretError({ secret: label, message: `${label} is required` })),
		onSome: (value) => Effect.succeed(Redacted.value(value)),
	})

const makeClerkAuthenticateRequest = (
	env: Pick<AuthEnv, "CLERK_SECRET_KEY" | "CLERK_PUBLISHABLE_KEY" | "CLERK_JWT_KEY">,
): ClerkAuthenticateRequest | undefined => {
	if (Option.isNone(env.CLERK_SECRET_KEY)) {
		return undefined
	}

	const clerkClient = createClerkClient({
		secretKey: Redacted.value(env.CLERK_SECRET_KEY.value),
		publishableKey: getOptionalString(env.CLERK_PUBLISHABLE_KEY),
		jwtKey: getOptionalSecret(env.CLERK_JWT_KEY),
	})

	return (request, options) =>
		clerkClient.authenticateRequest(request, options as any) as Promise<ClerkRequestState>
}

export const makeLoginSelfHosted = (
	env: Pick<AuthEnv, "MAPLE_AUTH_MODE" | "MAPLE_DEFAULT_ORG_ID" | "MAPLE_ROOT_PASSWORD">,
) =>
	Effect.fn("AuthService.loginSelfHosted")(function* (
		password: string,
	): Effect.fn.Return<
		SelfHostedLoginResponse,
		SelfHostedAuthDisabledError | SelfHostedInvalidPasswordError
	> {
		if (getAuthMode(env.MAPLE_AUTH_MODE) !== "self_hosted") {
			return yield* Effect.fail(
				new SelfHostedAuthDisabledError({
					message: "Self-hosted password login is disabled",
				}),
			)
		}

		const rootPassword = yield* requireSecret(env.MAPLE_ROOT_PASSWORD, "MAPLE_ROOT_PASSWORD")

		if (!constantTimeEquals(password, rootPassword)) {
			return yield* Effect.fail(
				new SelfHostedInvalidPasswordError({
					message: "Invalid root password",
				}),
			)
		}

		const tenant = makeSelfHostedTenant(env.MAPLE_DEFAULT_ORG_ID)
		const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
		// Entering the root password is what starts the absolute clock. Renewal
		// never restarts it — only another login does.
		const sessionExpiresAt = now + SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS
		const { token, expiresAt } = mintSelfHostedSessionToken(tenant, now, sessionExpiresAt, rootPassword)

		return new SelfHostedLoginResponse({
			token,
			orgId: tenant.orgId,
			userId: tenant.userId,
			expiresAt: expiresAt * 1000,
			sessionExpiresAt: sessionExpiresAt * 1000,
		})
	})

/**
 * Renewal: trade a still-valid self-hosted token for a fresh one, so a bounded
 * token lifetime does not mean the operator is logged out mid-session.
 *
 * The presented token is re-verified from scratch rather than trusted from the
 * middleware that already let the request through — this function is the only
 * thing standing between a token and a new one, so it does its own checking. An
 * expired token cannot be renewed; that is the point of the expiry.
 */
export const makeRefreshSelfHostedSession = (env: Pick<AuthEnv, "MAPLE_AUTH_MODE" | "MAPLE_ROOT_PASSWORD">) =>
	Effect.fn("AuthService.refreshSelfHostedSession")(function* (
		token: string,
	): Effect.fn.Return<SelfHostedLoginResponse, SelfHostedAuthDisabledError | UnauthorizedError> {
		if (getAuthMode(env.MAPLE_AUTH_MODE) !== "self_hosted") {
			return yield* Effect.fail(
				new SelfHostedAuthDisabledError({
					message: "Self-hosted session renewal is disabled",
				}),
			)
		}

		const rootPassword = yield* requireSecret(env.MAPLE_ROOT_PASSWORD, "MAPLE_ROOT_PASSWORD")
		const claims = yield* verifySelfHostedSessionToken(token, rootPassword)
		const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)

		// A token minted before `session_exp` existed still gets a bounded renewal
		// window rather than an unlimited one: its own `iat` plus the same maximum
		// lifetime, which is exactly the deadline the max-age rule already enforces
		// against it. That is the rollout path — legacy sessions renew until they
		// hit the cap, then the operator logs in again.
		const sessionExpiresAt = claims.session_exp ?? claims.iat + SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS
		const renewed = mintSelfHostedSessionToken(
			{
				orgId: claims.org_id,
				userId: claims.sub,
				roles: claims.roles,
				authMode: claims.authMode,
			},
			now,
			sessionExpiresAt,
			rootPassword,
		)

		return new SelfHostedLoginResponse({
			token: renewed.token,
			orgId: claims.org_id,
			userId: claims.sub,
			expiresAt: renewed.expiresAt * 1000,
			sessionExpiresAt: sessionExpiresAt * 1000,
		})
	})

/**
 * The header a client uses to name an organization explicitly instead of
 * relying on the session token's active-organization claim.
 *
 * It exists for one shape of caller: the iOS app publishing a Home Screen
 * widget snapshot per organization. A Clerk token carries exactly one active
 * organization, and `setActive` is global session state the foreground is
 * using — so the only way to read another org's data without disturbing the
 * user is to name it per request and prove membership server-side.
 *
 * Deliberately NOT `x-org-id`: that name belongs to the internal-service branch
 * in `apps/api/src/mcp/lib/resolve-tenant.ts`, which trusts it wholesale behind
 * a shared secret. Two very different trust models must not share a spelling.
 */
export const ORG_SELECTION_HEADER = "x-maple-org-id"

export interface VerifiedOrgMembership {
	readonly orgId: OrgId
	readonly role: RoleName
}

/**
 * Answers "is this user a member of this organization, and with what role".
 * `Option.none()` is a definite no; a failure is "could not find out", which
 * must never be treated as a no.
 *
 * Injected rather than implemented here, the same way `authenticateClerkRequest`
 * is, so this package keeps its "no app Env, fake it in a test" property.
 */
export type VerifyOrgMembership = (
	userId: UserId,
	orgId: OrgId,
) => Effect.Effect<Option.Option<VerifiedOrgMembership>, AuthorizationUnavailableError>

const ORGANIZATION_ACCESS_DENIED_MESSAGE = "You are not a member of the requested organization."

const organizationAccessDenied = (requestedOrgId?: OrgId) => {
	// The id is included only when it decoded as an `OrgId`; an unparseable
	// header value is never cast into the brand just to appear in an error.
	if (requestedOrgId === undefined) {
		return new OrganizationAccessDeniedError({ message: ORGANIZATION_ACCESS_DENIED_MESSAGE })
	}
	return new OrganizationAccessDeniedError({
		message: ORGANIZATION_ACCESS_DENIED_MESSAGE,
		requestedOrgId,
	})
}

/**
 * Resolves {@link ORG_SELECTION_HEADER} into a verified membership, or
 * `Option.none()` when the request names no organization.
 *
 * Two invariants, and both are load-bearing:
 *
 * 1. **The header only ever selects among organizations the caller can already
 *    be proven a member of.** Wherever that proof is unavailable — self-hosted
 *    mode, `MAPLE_ORG_ID_OVERRIDE`, API keys, no verifier wired — the request is
 *    rejected, never silently served under the credential's own organization.
 *    Silently ignoring it is the failure mode where a widget renders one
 *    organization's incidents under another's name and nobody notices.
 * 2. **Naming the organization you already have is free** — see
 *    {@link applyRequestedOrg}, which short-circuits before reaching here. That
 *    is what lets a client send the header unconditionally instead of branching.
 */
const selectRequestedOrg = Effect.fnUntraced(function* (
	userId: UserId,
	headers: HeaderRecord,
	verify: VerifyOrgMembership | undefined,
): Effect.fn.Return<
	Option.Option<VerifiedOrgMembership>,
	UnauthorizedError | OrganizationAccessDeniedError | AuthorizationUnavailableError
> {
	const requested = getHeader(headers, ORG_SELECTION_HEADER)
	if (!requested) return Option.none()

	const requestedOrgId = yield* decodeOrgId(requested, "Invalid organization selection")
	if (!verify) return yield* Effect.fail(organizationAccessDenied(requestedOrgId))

	// Stamped only when the header actually decides the organization, so
	// `maple.auth.org_source` answers "how much traffic selects an organization
	// explicitly" rather than "how many clients send the header unconditionally".
	yield* Effect.annotateCurrentSpan({
		"maple.auth.org_source": "header",
		"tenant.requested_org_id": requestedOrgId,
	})

	const membership = yield* verify(userId, requestedOrgId)
	if (Option.isNone(membership)) {
		return yield* Effect.fail(organizationAccessDenied(requestedOrgId))
	}
	return membership
})

/** {@link selectRequestedOrg}, applied to a tenant that already has an organization. */
const applyRequestedOrg = Effect.fnUntraced(function* (
	tenant: TenantContext,
	headers: HeaderRecord,
	verify: VerifyOrgMembership | undefined,
): Effect.fn.Return<
	TenantContext,
	UnauthorizedError | OrganizationAccessDeniedError | AuthorizationUnavailableError
> {
	const requested = getHeader(headers, ORG_SELECTION_HEADER)
	if (!requested) return tenant
	// The free no-op. Decoded first so an unparseable value is still rejected.
	const requestedOrgId = yield* decodeOrgId(requested, "Invalid organization selection")
	if (requestedOrgId === tenant.orgId) return tenant

	// `None` means "no header", which the guard above has already ruled out — so
	// this either adopts an organization or fails. There is deliberately no
	// branch here that returns the original tenant: that shape is what a silent
	// ignore looks like, and it is the failure this whole path exists to avoid.
	const membership = yield* selectRequestedOrg(tenant.userId, headers, verify)
	if (Option.isNone(membership)) return yield* Effect.fail(organizationAccessDenied(requestedOrgId))

	// The role travels with the organization. Carrying the token's `orgRole`
	// across would grant an admin of org A admin of org B.
	return { ...tenant, orgId: membership.value.orgId, roles: [membership.value.role] }
})

export const makeResolveTenant = (
	env: AuthEnv,
	authenticateClerkRequest = makeClerkAuthenticateRequest(env),
	acceptsToken: string | string[] = "session_token",
	/**
	 * Omit to disable {@link ORG_SELECTION_HEADER} entirely — the header is then
	 * rejected rather than ignored. Callers that have no membership directory to
	 * check against (electric-sync) and callers where the header has no meaning
	 * (`makeResolveMcpTenant`, whose credentials include org-bound API keys)
	 * deliberately pass nothing.
	 */
	verifyOrgMembership?: VerifyOrgMembership,
) =>
	Effect.fn("AuthService.resolveTenant")(function* (
		headers: HeaderRecord,
	): Effect.fn.Return<
		TenantContext,
		UnauthorizedError | OrganizationAccessDeniedError | AuthorizationUnavailableError
	> {
		const authMode = getAuthMode(env.MAPLE_AUTH_MODE)

		if (authMode === "clerk") {
			if (!authenticateClerkRequest) {
				return yield* unauthorized("CLERK_SECRET_KEY is required when MAPLE_AUTH_MODE=clerk")
			}

			const requestState = yield* Effect.tryPromise({
				try: () =>
					authenticateClerkRequest(toRequest(headers), {
						acceptsToken,
						jwtKey: getOptionalSecret(env.CLERK_JWT_KEY),
					}),
				catch: (error) =>
					unauthorized(
						`Clerk authentication failed: ${error instanceof Error ? error.message : String(error)}`,
					),
			})

			if (!requestState.isAuthenticated) {
				return yield* unauthorized(requestState.message ?? "Invalid Clerk session token")
			}

			const auth = requestState.toAuth()
			if (!auth) {
				return yield* unauthorized("Invalid Clerk session token")
			}

			if (!auth.isAuthenticated) {
				return yield* unauthorized("Invalid Clerk token")
			}

			if (!auth.userId) {
				return yield* unauthorized("Missing user in Clerk session token")
			}

			const orgIdOverride = getOptionalString(env.MAPLE_ORG_ID_OVERRIDE)
			const userId = yield* decodeUserId(auth.userId, "Invalid user in Clerk session token")

			// An API key is organization-bound; for keys the header is a rejection.
			const selectable = auth.tokenType === "session_token" ? verifyOrgMembership : undefined

			const sessionRoles: ReadonlyArray<RoleName> =
				typeof auth.orgRole === "string"
					? yield* Effect.map(
							decodeRoleName(auth.orgRole, "Invalid role in Clerk session token"),
							(role) => [role],
						)
					: []

			if (orgIdOverride !== undefined) {
				const pinnedOrgId = yield* decodeOrgId(orgIdOverride, "Invalid MAPLE_ORG_ID_OVERRIDE value")
				// The pin wins over a selection header (every web session names its own
				// org); the role is the verified membership's when there is one.
				const membership =
					auth.orgId !== pinnedOrgId && verifyOrgMembership
						? yield* verifyOrgMembership(userId, pinnedOrgId)
						: Option.none<VerifiedOrgMembership>()
				return {
					orgId: pinnedOrgId,
					userId,
					roles: Option.match(membership, {
						onNone: () => sessionRoles,
						onSome: (value) => [value.role],
					}),
					authMode: "clerk",
				}
			}

			if (!auth.orgId) {
				// No active organization in the session. A request that names one it
				// can prove membership of is still serviceable — this is the widget
				// publishing path, whose whole point is not to disturb whatever the
				// foreground has active.
				const selected = yield* selectRequestedOrg(userId, headers, selectable)
				if (Option.isNone(selected)) {
					return yield* unauthorized("Active organization is required")
				}
				return {
					orgId: selected.value.orgId,
					userId,
					roles: [selected.value.role],
					authMode: "clerk",
				}
			}

			const clerkTenant: TenantContext = {
				orgId: yield* decodeOrgId(auth.orgId, "Invalid organization in Clerk session token"),
				userId,
				roles: sessionRoles,
				authMode: "clerk",
			}

			return yield* applyRequestedOrg(clerkTenant, headers, selectable)
		}

		const token = getBearerToken(headers)
		if (!token) {
			return yield* unauthorized("Self-hosted mode requires a valid bearer token")
		}

		const rootPassword = yield* requireSecret(env.MAPLE_ROOT_PASSWORD, "MAPLE_ROOT_PASSWORD")
		// `claims` is already the validated tenant: branded ids, a normalized role
		// list and a literal `authMode`. Nothing below re-checks it.
		const claims = yield* verifySelfHostedSessionToken(token, rootPassword)

		const tenant: TenantContext = {
			orgId: claims.org_id,
			userId: claims.sub,
			roles: claims.roles,
			authMode: claims.authMode,
		}

		const orgIdOverride = getOptionalString(env.MAPLE_ORG_ID_OVERRIDE)
		const resolved = orgIdOverride
			? {
					...tenant,
					orgId: yield* decodeOrgId(orgIdOverride, "Invalid MAPLE_ORG_ID_OVERRIDE value"),
				}
			: tenant

		// Self-hosted mode has no membership directory to check a selection
		// against, so an honoured header here would be unconditional cross-tenant
		// access. Passing no verifier makes it a rejection.
		return yield* applyRequestedOrg(resolved, headers, undefined)
	})

export const makeResolveMcpTenant = (
	env: AuthEnv,
	authenticateClerkRequest = makeClerkAuthenticateRequest(env),
	// Accept both api_key (programmatic agents) and session_token: this is the
	// "Clerk / self-hosted session auth" fallback in resolveMcpTenantContext, used
	// by a logged-in browser applying an approved chat proposal via
	// POST /internal/chat/apply. Both resolve to the caller's own org (and a session
	// token keeps the human userId for attribution). The internal-service and
	// api-key paths run before this fallback, so this only widens the
	// already-last-resort branch; self-hosted HS256 mode already ignored
	// acceptsToken, so this just brings Clerk mode to parity.
) => makeResolveTenant(env, authenticateClerkRequest, ["api_key", "session_token"])

type ClerkUser = Awaited<ReturnType<ReturnType<typeof createClerkClient>["users"]["getUser"]>>

class ClerkLookupError extends Schema.TaggedError<ClerkLookupError>()("@maple/auth/ClerkLookupError", {
	operation: Schema.String,
	cause: Schema.Defect(),
}) {}

const clerkLookup = <A>(
	spanName: string,
	attributes: Readonly<Record<string, string>>,
	request: () => Promise<A>,
): Effect.Effect<A, ClerkLookupError> =>
	Effect.tryPromise({
		try: request,
		catch: (cause) => new ClerkLookupError({ operation: spanName, cause }),
	}).pipe(
		Effect.withSpan(spanName, {
			kind: "client",
			attributes: { "peer.service": "clerk", ...attributes },
		}),
	)

const extractPrimaryEmail = (u: ClerkUser): string | null => {
	const primary = u.emailAddresses?.find((e) => e.id === u.primaryEmailAddressId)
	return primary?.emailAddress ?? u.emailAddresses?.[0]?.emailAddress ?? null
}

const makeClerkClient = (
	env: Pick<AuthEnv, "MAPLE_AUTH_MODE" | "CLERK_SECRET_KEY" | "CLERK_PUBLISHABLE_KEY" | "CLERK_JWT_KEY">,
) => {
	if (getAuthMode(env.MAPLE_AUTH_MODE) !== "clerk" || Option.isNone(env.CLERK_SECRET_KEY)) {
		return null
	}
	return createClerkClient({
		secretKey: Redacted.value(env.CLERK_SECRET_KEY.value),
		publishableKey: getOptionalString(env.CLERK_PUBLISHABLE_KEY),
		jwtKey: getOptionalSecret(env.CLERK_JWT_KEY),
	})
}

export const makeGetUserEmail = (
	env: Pick<AuthEnv, "MAPLE_AUTH_MODE" | "CLERK_SECRET_KEY" | "CLERK_PUBLISHABLE_KEY" | "CLERK_JWT_KEY">,
) => {
	const clerkClient = makeClerkClient(env)
	if (!clerkClient) {
		return Effect.fn("AuthService.getUserEmail")(function* (_userId: string) {
			return null as string | null
		})
	}

	return Effect.fn("AuthService.getUserEmail")(function* (userId: string) {
		yield* Effect.annotateCurrentSpan("tenant.userId", userId)
		const user = yield* clerkLookup("Clerk.users.getUser", { "tenant.userId": userId }, () =>
			clerkClient.users.getUser(userId),
		).pipe(Effect.option)

		return Option.match(user, {
			onNone: () => null as string | null,
			onSome: extractPrimaryEmail,
		})
	})
}

export const makeGetCustomerData = (
	env: Pick<AuthEnv, "MAPLE_AUTH_MODE" | "CLERK_SECRET_KEY" | "CLERK_PUBLISHABLE_KEY" | "CLERK_JWT_KEY">,
) => {
	const clerkClient = makeClerkClient(env)
	if (!clerkClient) {
		return Effect.fn("AuthService.getCustomerData")(function* (_tenant: TenantContext) {
			return { email: null as string | null, orgName: null as string | null }
		})
	}

	return Effect.fn("AuthService.getCustomerData")(function* (tenant: TenantContext) {
		yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "tenant.userId": tenant.userId })
		const [user, org] = yield* Effect.all(
			[
				clerkLookup(
					"Clerk.users.getUser",
					{ orgId: tenant.orgId, "tenant.userId": tenant.userId },
					() => clerkClient.users.getUser(tenant.userId),
				).pipe(Effect.option),
				clerkLookup("Clerk.organizations.getOrganization", { orgId: tenant.orgId }, () =>
					clerkClient.organizations.getOrganization({ organizationId: tenant.orgId }),
				).pipe(Effect.option),
			],
			{ concurrency: "unbounded" },
		)

		return {
			email: Option.match(user, { onNone: () => null as string | null, onSome: extractPrimaryEmail }),
			orgName: Option.match(org, {
				onNone: () => null as string | null,
				onSome: (o) => o.name ?? null,
			}),
		}
	})
}

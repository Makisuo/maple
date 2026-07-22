import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import {
	ApiKeyId,
	McpOAuthAuthorizationActionResponse,
	McpOAuthAuthorizationConflictError,
	McpOAuthAuthorizationExpiredError,
	McpOAuthAuthorizationInfoResponse,
	McpOAuthAuthorizationNotFoundError,
	McpOAuthPersistenceError,
	type OrgId,
	type RoleName,
	type UserId,
} from "@maple/domain/http"
import {
	apiKeys,
	generateApiKey,
	hashApiKey,
	mcpOAuthAuthorizations,
	mcpOAuthClients,
	mcpOAuthRefreshTokens,
	parseIngestKeyLookupHmacKey,
} from "@maple/db"
import type { MapleDatabaseTransaction } from "@maple/db/client"
import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Database } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { WorkerEnvironment } from "../lib/WorkerEnvironment"

const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MCP_SCOPE = "mcp:tools"
const MCP_OAUTH_RATE_LIMIT_BINDING = "MCP_OAUTH_RATE_LIMITER"

interface RateLimitBinding {
	readonly limit: (options: { readonly key: string }) => Promise<{ readonly success: boolean }>
}

const isRateLimitBinding = (value: unknown): value is RateLimitBinding =>
	typeof value === "object" &&
	value !== null &&
	"limit" in value &&
	typeof (value as { limit?: unknown }).limit === "function"

export class McpOAuthProtocolError extends Schema.TaggedErrorClass<McpOAuthProtocolError>()(
	"@maple/api/errors/McpOAuthProtocolError",
	{
		error: Schema.String,
		message: Schema.String,
		redirectUri: Schema.optionalKey(Schema.String),
		state: Schema.optionalKey(Schema.String),
	},
) {}

export class McpOAuthRateLimitError extends Schema.TaggedErrorClass<McpOAuthRateLimitError>()(
	"@maple/api/errors/McpOAuthRateLimitError",
	{ message: Schema.String },
) {}

type ApprovalIdentity = {
	readonly orgId: OrgId
	readonly userId: UserId
	readonly roles: ReadonlyArray<RoleName>
	readonly userEmail: string | null
}

export interface McpOAuthRegistrationInput {
	readonly clientName: string
	readonly redirectUris: ReadonlyArray<string>
	readonly clientUri?: string
}

export interface McpOAuthRegistrationResponse {
	readonly client_id: string
	readonly client_id_issued_at: number
	readonly client_name: string
	readonly client_uri?: string
	readonly redirect_uris: ReadonlyArray<string>
	readonly token_endpoint_auth_method: "none"
	readonly grant_types: ReadonlyArray<"authorization_code" | "refresh_token">
	readonly response_types: ReadonlyArray<"code">
}

export interface McpOAuthAuthorizationInput {
	readonly clientId: string
	readonly redirectUri: string
	readonly responseType: string
	readonly state?: string
	readonly codeChallenge: string
	readonly codeChallengeMethod: string
	readonly resource: string
	readonly scope?: string
	readonly expectedResource: string
}

export interface McpOAuthTokenResponse {
	readonly access_token: string
	readonly token_type: "Bearer"
	readonly expires_in: number
	readonly refresh_token: string
	readonly scope: string
}

export interface McpOAuthAuthorizationCodeInput {
	readonly code: string
	readonly clientId: string
	readonly redirectUri: string
	readonly codeVerifier: string
	readonly resource: string
}

export interface McpOAuthRefreshInput {
	readonly refreshToken: string
	readonly clientId: string
	readonly resource: string
	readonly scope?: string
}

const hashOpaqueToken = (value: string) => createHash("sha256").update(value).digest("hex")
const makeOpaqueToken = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`
const decodeApiKeyId = Schema.decodeUnknownSync(ApiKeyId)

const persistenceError = (error: unknown) =>
	new McpOAuthPersistenceError({
		message: error instanceof Error ? error.message : "MCP OAuth persistence failed",
	})

const protocolError = (
	error: string,
	message: string,
	options?: { readonly redirectUri?: string; readonly state?: string },
) =>
	new McpOAuthProtocolError({
		error,
		message,
		...(options?.redirectUri ? { redirectUri: options.redirectUri } : {}),
		...(options?.state ? { state: options.state } : {}),
	})

const parseScopes = (scope: string | undefined) => {
	const scopes = [...new Set((scope ?? MCP_SCOPE).split(/\s+/).filter(Boolean))]
	return scopes.length === 1 && scopes[0] === MCP_SCOPE ? scopes : undefined
}

const isLoopbackHost = (hostname: string) =>
	hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"

export const validateMcpOAuthRedirectUri = (value: string): boolean => {
	try {
		const url = new URL(value)
		if (url.hash || url.username || url.password) return false
		if (url.protocol === "https:") return true
		return url.protocol === "http:" && isLoopbackHost(url.hostname)
	} catch {
		return false
	}
}

const appendOAuthParams = (redirectUri: string, params: Record<string, string | undefined>) => {
	const url = new URL(redirectUri)
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) url.searchParams.set(key, value)
	}
	return url.toString()
}

const challengeForVerifier = (verifier: string) => createHash("sha256").update(verifier).digest("base64url")

const verifyPkce = (verifier: string, challenge: string) => {
	if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
	const actual = Buffer.from(challengeForVerifier(verifier))
	const expected = Buffer.from(challenge)
	return actual.length === expected.length && timingSafeEqual(actual, expected)
}

const oauthKeyMetadata = (roles: ReadonlyArray<string>, clientId: string, resource: string) => ({
	source: "maple_mcp_oauth",
	roles: [...roles],
	clientId,
	resource,
})

export class McpOAuthService extends Context.Service<
	McpOAuthService,
	{
		readonly register: (
			input: McpOAuthRegistrationInput,
			requesterKey: string,
		) => Effect.Effect<
			McpOAuthRegistrationResponse,
			McpOAuthProtocolError | McpOAuthRateLimitError | McpOAuthPersistenceError
		>
		readonly startAuthorization: (
			input: McpOAuthAuthorizationInput,
			requesterKey: string,
		) => Effect.Effect<
			{ readonly consentUrl: string },
			McpOAuthProtocolError | McpOAuthRateLimitError | McpOAuthPersistenceError
		>
		readonly inspect: (
			requestId: string,
		) => Effect.Effect<
			McpOAuthAuthorizationInfoResponse,
			McpOAuthAuthorizationNotFoundError | McpOAuthAuthorizationExpiredError | McpOAuthPersistenceError
		>
		readonly approve: (
			requestId: string,
			identity: ApprovalIdentity,
		) => Effect.Effect<
			McpOAuthAuthorizationActionResponse,
			| McpOAuthAuthorizationNotFoundError
			| McpOAuthAuthorizationExpiredError
			| McpOAuthAuthorizationConflictError
			| McpOAuthPersistenceError
		>
		readonly deny: (
			requestId: string,
		) => Effect.Effect<
			McpOAuthAuthorizationActionResponse,
			| McpOAuthAuthorizationNotFoundError
			| McpOAuthAuthorizationExpiredError
			| McpOAuthAuthorizationConflictError
			| McpOAuthPersistenceError
		>
		readonly exchangeAuthorizationCode: (
			input: McpOAuthAuthorizationCodeInput,
			requesterKey: string,
		) => Effect.Effect<
			McpOAuthTokenResponse,
			McpOAuthProtocolError | McpOAuthRateLimitError | McpOAuthPersistenceError
		>
		readonly refresh: (
			input: McpOAuthRefreshInput,
			requesterKey: string,
		) => Effect.Effect<
			McpOAuthTokenResponse,
			McpOAuthProtocolError | McpOAuthRateLimitError | McpOAuthPersistenceError
		>
		readonly revoke: (token: string, clientId: string) => Effect.Effect<void, McpOAuthPersistenceError>
	}
>()("@maple/api/services/McpOAuthService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const workerEnvironment = yield* Effect.serviceOption(WorkerEnvironment)
		const apiKeyHmacKey = yield* Effect.try({
			try: () => parseIngestKeyLookupHmacKey(Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY)),
			catch: persistenceError,
		}).pipe(Effect.orDie)

		const checkRateLimit = Effect.fn("McpOAuthService.checkRateLimit")(function* (key: string) {
			if (Option.isNone(workerEnvironment)) return
			const binding = workerEnvironment.value[MCP_OAUTH_RATE_LIMIT_BINDING]
			if (!isRateLimitBinding(binding)) return
			const outcome = yield* Effect.tryPromise({
				try: () => binding.limit({ key: `${env.MAPLE_ENVIRONMENT}:mcp-oauth:${key}` }),
				catch: persistenceError,
			}).pipe(Effect.orElseSucceed(() => undefined))
			if (outcome && !outcome.success) {
				return yield* new McpOAuthRateLimitError({
					message: "Too many OAuth requests. Wait a minute and try again.",
				})
			}
		})

		const purgeExpired = Effect.fn("McpOAuthService.purgeExpired")(function* (now: number) {
			yield* database
				.execute((db) =>
					db.transaction(async (tx) => {
						await tx
							.delete(mcpOAuthAuthorizations)
							.where(lt(mcpOAuthAuthorizations.expiresAt, new Date(now)))
						await tx
							.delete(mcpOAuthRefreshTokens)
							.where(lt(mcpOAuthRefreshTokens.expiresAt, new Date(now)))
					}),
				)
				.pipe(Effect.mapError(persistenceError))
		})

		const register = Effect.fn("McpOAuthService.register")(function* (
			input: McpOAuthRegistrationInput,
			requesterKey: string,
		) {
			yield* checkRateLimit(`register:${requesterKey}`)
			const clientName = input.clientName.trim().slice(0, 120)
			const redirectUris = [...new Set(input.redirectUris)]
			if (!clientName) return yield* protocolError("invalid_client_metadata", "client_name is required")
			if (
				redirectUris.length === 0 ||
				redirectUris.length > 10 ||
				redirectUris.some((uri) => uri.length > 2048) ||
				redirectUris.some((uri) => !validateMcpOAuthRedirectUri(uri))
			) {
				return yield* protocolError(
					"invalid_redirect_uri",
					"redirect_uris must contain one to ten HTTPS or loopback HTTP URLs without fragments",
				)
			}
			if (
				input.clientUri &&
				(input.clientUri.length > 2048 || !validateMcpOAuthRedirectUri(input.clientUri))
			) {
				return yield* protocolError(
					"invalid_client_metadata",
					"client_uri must be an HTTPS or loopback URL",
				)
			}
			const now = yield* Clock.currentTimeMillis
			const clientId = makeOpaqueToken("maple_mcp_client_")
			yield* database
				.execute((db) =>
					db.insert(mcpOAuthClients).values({
						clientId,
						clientName,
						redirectUris,
						clientUri: input.clientUri ?? null,
						createdAt: new Date(now),
					}),
				)
				.pipe(Effect.mapError(persistenceError))
			return {
				client_id: clientId,
				client_id_issued_at: Math.floor(now / 1000),
				client_name: clientName,
				...(input.clientUri ? { client_uri: input.clientUri } : {}),
				redirect_uris: redirectUris,
				token_endpoint_auth_method: "none" as const,
				grant_types: ["authorization_code", "refresh_token"] as const,
				response_types: ["code"] as const,
			}
		})

		const startAuthorization = Effect.fn("McpOAuthService.startAuthorization")(function* (
			input: McpOAuthAuthorizationInput,
			requesterKey: string,
		) {
			yield* checkRateLimit(`authorize:${requesterKey}`)
			const clients = yield* database
				.execute((db) =>
					db
						.select()
						.from(mcpOAuthClients)
						.where(eq(mcpOAuthClients.clientId, input.clientId))
						.limit(1),
				)
				.pipe(Effect.mapError(persistenceError))
			const client = clients[0]
			if (!client) return yield* protocolError("invalid_request", "Unknown client_id")
			if (!client.redirectUris.includes(input.redirectUri)) {
				return yield* protocolError(
					"invalid_request",
					"redirect_uri is not registered for this client",
				)
			}
			const safeRedirect = { redirectUri: input.redirectUri, state: input.state }
			if (input.state && input.state.length > 1024) {
				return yield* protocolError("invalid_request", "state is too long", {
					redirectUri: input.redirectUri,
				})
			}
			if (input.responseType !== "code") {
				return yield* protocolError(
					"unsupported_response_type",
					"Only response_type=code is supported",
					safeRedirect,
				)
			}
			if (input.codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
				return yield* protocolError(
					"invalid_request",
					"A valid S256 PKCE code challenge is required",
					safeRedirect,
				)
			}
			if (input.resource !== input.expectedResource) {
				return yield* protocolError(
					"invalid_target",
					"resource must identify this Maple MCP server",
					safeRedirect,
				)
			}
			const scopes = parseScopes(input.scope)
			if (!scopes)
				return yield* protocolError("invalid_scope", `Only ${MCP_SCOPE} is supported`, safeRedirect)
			const now = yield* Clock.currentTimeMillis
			yield* purgeExpired(now)
			const requestId = makeOpaqueToken("mcp_auth_")
			yield* database
				.execute((db) =>
					db.insert(mcpOAuthAuthorizations).values({
						requestIdHash: hashOpaqueToken(requestId),
						clientId: client.clientId,
						clientName: client.clientName,
						redirectUri: input.redirectUri,
						state: input.state ?? null,
						resource: input.resource,
						scopes,
						codeChallenge: input.codeChallenge,
						createdAt: new Date(now),
						expiresAt: new Date(now + AUTHORIZATION_REQUEST_TTL_MS),
					}),
				)
				.pipe(Effect.mapError(persistenceError))
			return {
				consentUrl: `${env.MAPLE_APP_BASE_URL.replace(/\/+$/, "")}/mcp-authorize?request_id=${encodeURIComponent(requestId)}`,
			}
		})

		const findAuthorization = Effect.fn("McpOAuthService.findAuthorization")(function* (
			requestId: string,
		) {
			if (!requestId.startsWith("mcp_auth_") || requestId.length > 128) {
				return yield* new McpOAuthAuthorizationNotFoundError({
					message: "OAuth authorization request not found",
				})
			}
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(mcpOAuthAuthorizations)
						.where(eq(mcpOAuthAuthorizations.requestIdHash, hashOpaqueToken(requestId)))
						.limit(1),
				)
				.pipe(Effect.mapError(persistenceError))
			if (!rows[0]) {
				return yield* new McpOAuthAuthorizationNotFoundError({
					message: "OAuth authorization request not found",
				})
			}
			return rows[0]
		})

		const requireActiveAuthorization = Effect.fn("McpOAuthService.requireActiveAuthorization")(function* (
			requestId: string,
		) {
			const row = yield* findAuthorization(requestId)
			const now = yield* Clock.currentTimeMillis
			if (row.expiresAt.getTime() <= now) {
				return yield* new McpOAuthAuthorizationExpiredError({
					message: "OAuth authorization request expired",
				})
			}
			return row
		})

		const inspect = Effect.fn("McpOAuthService.inspect")(function* (requestId: string) {
			const row = yield* requireActiveAuthorization(requestId)
			const status = row.usedAt
				? ("used" as const)
				: row.deniedAt
					? ("denied" as const)
					: row.approvedAt
						? ("approved" as const)
						: ("pending" as const)
			return new McpOAuthAuthorizationInfoResponse({
				clientName: row.clientName,
				redirectUri: row.redirectUri,
				resource: row.resource,
				scopes: row.scopes,
				expiresAt: row.expiresAt.toISOString(),
				status,
			})
		})

		const approve = Effect.fn("McpOAuthService.approve")(function* (
			requestId: string,
			identity: ApprovalIdentity,
		) {
			const row = yield* requireActiveAuthorization(requestId)
			if (row.approvedAt || row.deniedAt || row.usedAt) {
				return yield* new McpOAuthAuthorizationConflictError({
					message: "OAuth authorization request was already used",
				})
			}
			const now = yield* Clock.currentTimeMillis
			const code = makeOpaqueToken("mcp_code_")
			const updated = yield* database
				.execute((db) =>
					db
						.update(mcpOAuthAuthorizations)
						.set({
							authorizationCodeHash: hashOpaqueToken(code),
							approvedOrgId: identity.orgId,
							approvedUserId: identity.userId,
							approvedRoles: [...identity.roles],
							approvedUserEmail: identity.userEmail,
							approvedAt: new Date(now),
							expiresAt: new Date(now + AUTHORIZATION_CODE_TTL_MS),
						})
						.where(
							and(
								eq(mcpOAuthAuthorizations.requestIdHash, row.requestIdHash),
								isNull(mcpOAuthAuthorizations.approvedAt),
								isNull(mcpOAuthAuthorizations.deniedAt),
							),
						)
						.returning({ requestIdHash: mcpOAuthAuthorizations.requestIdHash }),
				)
				.pipe(Effect.mapError(persistenceError))
			if (updated.length === 0) {
				return yield* new McpOAuthAuthorizationConflictError({
					message: "OAuth authorization request was already used",
				})
			}
			return new McpOAuthAuthorizationActionResponse({
				status: "approved",
				redirectUri: appendOAuthParams(row.redirectUri, { code, state: row.state ?? undefined }),
			})
		})

		const deny = Effect.fn("McpOAuthService.deny")(function* (requestId: string) {
			const row = yield* requireActiveAuthorization(requestId)
			if (row.approvedAt || row.deniedAt || row.usedAt) {
				return yield* new McpOAuthAuthorizationConflictError({
					message: "OAuth authorization request was already used",
				})
			}
			const now = yield* Clock.currentTimeMillis
			const updated = yield* database
				.execute((db) =>
					db
						.update(mcpOAuthAuthorizations)
						.set({ deniedAt: new Date(now) })
						.where(
							and(
								eq(mcpOAuthAuthorizations.requestIdHash, row.requestIdHash),
								isNull(mcpOAuthAuthorizations.approvedAt),
								isNull(mcpOAuthAuthorizations.deniedAt),
							),
						)
						.returning({ requestIdHash: mcpOAuthAuthorizations.requestIdHash }),
				)
				.pipe(Effect.mapError(persistenceError))
			if (updated.length === 0) {
				return yield* new McpOAuthAuthorizationConflictError({
					message: "OAuth authorization request was already used",
				})
			}
			return new McpOAuthAuthorizationActionResponse({
				status: "denied",
				redirectUri: appendOAuthParams(row.redirectUri, {
					error: "access_denied",
					error_description: "The user denied the authorization request",
					state: row.state ?? undefined,
				}),
			})
		})

		const makeTokenValues = (input: {
			readonly clientId: string
			readonly clientName: string
			readonly resource: string
			readonly scopes: ReadonlyArray<string>
			readonly orgId: string
			readonly userId: string
			readonly roles: ReadonlyArray<string>
			readonly userEmail: string | null
			readonly familyId?: string
		}) => {
			const accessToken = generateApiKey()
			const refreshToken = makeOpaqueToken("maple_mcp_refresh_")
			const accessKeyId = decodeApiKeyId(randomUUID())
			const refreshId = randomUUID()
			const familyId = input.familyId ?? randomUUID()
			return { accessToken, refreshToken, accessKeyId, refreshId, familyId }
		}

		const tokenResponse = (accessToken: string, refreshToken: string, scopes: ReadonlyArray<string>) => ({
			access_token: accessToken,
			token_type: "Bearer" as const,
			expires_in: ACCESS_TOKEN_TTL_MS / 1000,
			refresh_token: refreshToken,
			scope: scopes.join(" "),
		})

		const exchangeAuthorizationCode = Effect.fn("McpOAuthService.exchangeAuthorizationCode")(function* (
			input: McpOAuthAuthorizationCodeInput,
			requesterKey: string,
		) {
			yield* checkRateLimit(`token:${requesterKey}`)
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(mcpOAuthAuthorizations)
						.where(eq(mcpOAuthAuthorizations.authorizationCodeHash, hashOpaqueToken(input.code)))
						.limit(1),
				)
				.pipe(Effect.mapError(persistenceError))
			const row = rows[0]
			const now = yield* Clock.currentTimeMillis
			if (
				!row ||
				!row.approvedAt ||
				!row.approvedOrgId ||
				!row.approvedUserId ||
				!row.approvedRoles ||
				row.deniedAt ||
				row.usedAt ||
				row.expiresAt.getTime() <= now ||
				row.clientId !== input.clientId ||
				row.redirectUri !== input.redirectUri ||
				row.resource !== input.resource ||
				!verifyPkce(input.codeVerifier, row.codeChallenge)
			) {
				return yield* protocolError(
					"invalid_grant",
					"Authorization code is invalid, expired, or already used",
				)
			}
			const values = makeTokenValues({
				clientId: row.clientId,
				clientName: row.clientName,
				resource: row.resource,
				scopes: row.scopes,
				orgId: row.approvedOrgId,
				userId: row.approvedUserId,
				roles: row.approvedRoles,
				userEmail: row.approvedUserEmail,
			})
			const issued = yield* database
				.execute((db) =>
					db.transaction(async (tx) => {
						const claimed = await tx
							.update(mcpOAuthAuthorizations)
							.set({ usedAt: new Date(now) })
							.where(
								and(
									eq(mcpOAuthAuthorizations.requestIdHash, row.requestIdHash),
									isNull(mcpOAuthAuthorizations.usedAt),
									gt(mcpOAuthAuthorizations.expiresAt, new Date(now)),
								),
							)
							.returning({ requestIdHash: mcpOAuthAuthorizations.requestIdHash })
						if (claimed.length === 0) return false
						await tx.insert(apiKeys).values({
							id: values.accessKeyId,
							orgId: row.approvedOrgId!,
							name: row.clientName,
							description: "OAuth access token for the Maple MCP server",
							keyHash: hashApiKey(values.accessToken, apiKeyHmacKey),
							keyPrefix: values.accessToken.slice(0, 12) + "...",
							kind: "mcp",
							scopes: row.scopes,
							metadataJson: oauthKeyMetadata(row.approvedRoles!, row.clientId, row.resource),
							expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
							createdAt: new Date(now),
							createdBy: row.approvedUserId!,
							createdByEmail: row.approvedUserEmail,
						})
						await tx.insert(mcpOAuthRefreshTokens).values({
							id: values.refreshId,
							tokenHash: hashOpaqueToken(values.refreshToken),
							familyId: values.familyId,
							clientId: row.clientId,
							resource: row.resource,
							scopes: row.scopes,
							orgId: row.approvedOrgId!,
							userId: row.approvedUserId!,
							roles: row.approvedRoles!,
							userEmail: row.approvedUserEmail,
							accessKeyId: values.accessKeyId,
							createdAt: new Date(now),
							expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
						})
						return true
					}),
				)
				.pipe(Effect.mapError(persistenceError))
			if (!issued) return yield* protocolError("invalid_grant", "Authorization code was already used")
			return tokenResponse(values.accessToken, values.refreshToken, row.scopes)
		})

		const revokeFamily = async (tx: MapleDatabaseTransaction, familyId: string, now: Date) => {
			const family = await tx
				.select({ accessKeyId: mcpOAuthRefreshTokens.accessKeyId })
				.from(mcpOAuthRefreshTokens)
				.where(eq(mcpOAuthRefreshTokens.familyId, familyId))
			await tx
				.update(mcpOAuthRefreshTokens)
				.set({ revokedAt: now })
				.where(
					and(
						eq(mcpOAuthRefreshTokens.familyId, familyId),
						isNull(mcpOAuthRefreshTokens.revokedAt),
					),
				)
			const accessKeyIds = family.map((item) => item.accessKeyId)
			if (accessKeyIds.length > 0) {
				await tx
					.update(apiKeys)
					.set({ revoked: true, revokedAt: now })
					.where(inArray(apiKeys.id, accessKeyIds))
			}
		}

		const refresh = Effect.fn("McpOAuthService.refresh")(function* (
			input: McpOAuthRefreshInput,
			requesterKey: string,
		) {
			yield* checkRateLimit(`token:${requesterKey}`)
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(mcpOAuthRefreshTokens)
						.where(eq(mcpOAuthRefreshTokens.tokenHash, hashOpaqueToken(input.refreshToken)))
						.limit(1),
				)
				.pipe(Effect.mapError(persistenceError))
			const row = rows[0]
			const now = yield* Clock.currentTimeMillis
			const requestedScopes = parseScopes(input.scope)
			if (
				!row ||
				row.expiresAt.getTime() <= now ||
				row.clientId !== input.clientId ||
				row.resource !== input.resource ||
				!requestedScopes ||
				requestedScopes.some((scope) => !row.scopes.includes(scope))
			) {
				return yield* protocolError("invalid_grant", "Refresh token is invalid or expired")
			}
			if (row.revokedAt) {
				yield* database
					.execute((db) => db.transaction((tx) => revokeFamily(tx, row.familyId, new Date(now))))
					.pipe(Effect.mapError(persistenceError))
				return yield* protocolError(
					"invalid_grant",
					"Refresh token reuse detected; the grant was revoked",
				)
			}
			const values = makeTokenValues({
				clientId: row.clientId,
				clientName: "Maple MCP client",
				resource: row.resource,
				scopes: requestedScopes,
				orgId: row.orgId,
				userId: row.userId,
				roles: row.roles,
				userEmail: row.userEmail,
				familyId: row.familyId,
			})
			const outcome = yield* database
				.execute((db) =>
					db.transaction(async (tx) => {
						const claimed = await tx
							.update(mcpOAuthRefreshTokens)
							.set({ revokedAt: new Date(now), replacedById: values.refreshId })
							.where(
								and(
									eq(mcpOAuthRefreshTokens.id, row.id),
									isNull(mcpOAuthRefreshTokens.revokedAt),
									gt(mcpOAuthRefreshTokens.expiresAt, new Date(now)),
								),
							)
							.returning({ id: mcpOAuthRefreshTokens.id })
						if (claimed.length === 0) {
							await revokeFamily(tx, row.familyId, new Date(now))
							return "reused" as const
						}
						await tx
							.update(apiKeys)
							.set({ revoked: true, revokedAt: new Date(now) })
							.where(eq(apiKeys.id, row.accessKeyId))
						await tx.insert(apiKeys).values({
							id: values.accessKeyId,
							orgId: row.orgId,
							name: "Maple MCP client",
							description: "OAuth access token for the Maple MCP server",
							keyHash: hashApiKey(values.accessToken, apiKeyHmacKey),
							keyPrefix: values.accessToken.slice(0, 12) + "...",
							kind: "mcp",
							scopes: requestedScopes,
							metadataJson: oauthKeyMetadata(row.roles, row.clientId, row.resource),
							expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
							createdAt: new Date(now),
							createdBy: row.userId,
							createdByEmail: row.userEmail,
						})
						await tx.insert(mcpOAuthRefreshTokens).values({
							id: values.refreshId,
							tokenHash: hashOpaqueToken(values.refreshToken),
							familyId: row.familyId,
							clientId: row.clientId,
							resource: row.resource,
							scopes: requestedScopes,
							orgId: row.orgId,
							userId: row.userId,
							roles: row.roles,
							userEmail: row.userEmail,
							accessKeyId: values.accessKeyId,
							createdAt: new Date(now),
							expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
						})
						return "issued" as const
					}),
				)
				.pipe(Effect.mapError(persistenceError))
			if (outcome === "reused") {
				return yield* protocolError(
					"invalid_grant",
					"Refresh token reuse detected; the grant was revoked",
				)
			}
			return tokenResponse(values.accessToken, values.refreshToken, requestedScopes)
		})

		const revoke = Effect.fn("McpOAuthService.revoke")(function* (token: string, clientId: string) {
			const now = yield* Clock.currentTimeMillis
			if (token.startsWith("maple_mcp_refresh_")) {
				const rows = yield* database
					.execute((db) =>
						db
							.select()
							.from(mcpOAuthRefreshTokens)
							.where(eq(mcpOAuthRefreshTokens.tokenHash, hashOpaqueToken(token)))
							.limit(1),
					)
					.pipe(Effect.mapError(persistenceError))
				const row = rows[0]
				if (row && row.clientId === clientId) {
					yield* database
						.execute((db) =>
							db.transaction((tx) => revokeFamily(tx, row.familyId, new Date(now))),
						)
						.pipe(Effect.mapError(persistenceError))
				}
				return
			}
			const keyHash = hashApiKey(token, apiKeyHmacKey)
			const rows = yield* database
				.execute((db) => db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1))
				.pipe(Effect.mapError(persistenceError))
			const row = rows[0]
			const metadata = row?.metadataJson
			if (
				row &&
				typeof metadata === "object" &&
				metadata !== null &&
				"source" in metadata &&
				metadata.source === "maple_mcp_oauth" &&
				"clientId" in metadata &&
				metadata.clientId === clientId
			) {
				yield* database
					.execute((db) =>
						db.transaction(async (tx) => {
							const refreshRows = await tx
								.select({ familyId: mcpOAuthRefreshTokens.familyId })
								.from(mcpOAuthRefreshTokens)
								.where(eq(mcpOAuthRefreshTokens.accessKeyId, row.id))
								.limit(1)
							if (refreshRows[0]) {
								await revokeFamily(tx, refreshRows[0].familyId, new Date(now))
								return
							}
							await tx
								.update(apiKeys)
								.set({ revoked: true, revokedAt: new Date(now) })
								.where(eq(apiKeys.id, row.id))
						}),
					)
					.pipe(Effect.mapError(persistenceError))
			}
		})

		return {
			register,
			startAuthorization,
			inspect,
			approve,
			deny,
			exchangeAuthorizationCode,
			refresh,
			revoke,
		}
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

export const MCP_OAUTH_SCOPE = MCP_SCOPE

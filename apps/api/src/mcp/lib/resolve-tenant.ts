import { timingSafeEqual } from "node:crypto"
import { Effect, Option, Redacted, Schema } from "effect"
import type { TenantContext as McpTenantContext } from "@/services/auth/tenant-context"
import { AuthService } from "@/services/auth/AuthService"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { Env } from "@/platform/Env"
import { ActorId, OrgId, RoleName, UserId } from "@maple/domain/http"
import {
	McpAuthInvalidError,
	McpAuthMissingError,
	McpAuthUnavailableError,
	McpInvalidTenantError,
} from "@/mcp/tools/types"
import { recordExpectedMcpFailure } from "@/mcp/expected-failures"
import { sessionStore } from "@/mcp/lib/session-store"

/** Exported so the audit layer classifies the same token the same way. */
export const INTERNAL_SERVICE_PREFIX = "maple_svc_"
const decodeOrgId = Schema.decodeUnknownEffect(OrgId)
const decodeUserId = Schema.decodeUnknownEffect(UserId)
const decodeActorIdOption = Schema.decodeUnknownOption(ActorId)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const apiKeyDefaultRoles = [decodeRoleNameSync("root")]

const AGENT_ACTOR_HEADER = "x-maple-agent-id"

const extractAgentActorIdFromMetadata = (metadataJson: string | null): string | null => {
	if (!metadataJson) return null
	try {
		const parsed = JSON.parse(metadataJson)
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const candidate = (parsed as Record<string, unknown>).agentActorId
			return typeof candidate === "string" ? candidate : null
		}
	} catch {
		// fall through
	}
	return null
}

// The negotiated `initialize` payload is keyed by session id in the in-memory
// store (preloaded from KV in worker.ts before the handler runs), so any
// tool call carrying `mcp-session-id` can recover which client is driving it.
const resolveMcpClientName = (headers: Headers): string | undefined => {
	const sessionId = headers.get("mcp-session-id")
	if (!sessionId) return undefined
	const name = sessionStore.get(sessionId)?.clientInfo.name.trim()
	return name ? name : undefined
}

const toHeaderRecord = (headers: Headers): Record<string, string> => {
	const record: Record<string, string> = {}

	for (const [name, value] of headers.entries()) {
		record[name] = value
	}

	return record
}

const getBearerToken = (headers: Headers): string | undefined => {
	const header = headers.get("authorization")
	if (!header) return undefined
	const [scheme, token] = header.split(" ")
	if (!scheme || !token || scheme.toLowerCase() !== "bearer") return undefined
	return token
}

const firstForwardedValue = (value: string | null) => value?.split(",")[0]?.trim()

export const mcpResourceForRequest = (request: Request) => {
	const requestUrl = new URL(request.url)
	const protocol =
		firstForwardedValue(request.headers.get("x-forwarded-proto")) ?? requestUrl.protocol.slice(0, -1)
	const host =
		firstForwardedValue(request.headers.get("x-forwarded-host")) ??
		request.headers.get("host") ??
		requestUrl.host
	return `${protocol}://${host}/mcp`
}

export const resolveMcpTenantContext = Effect.fn("resolveMcpTenantContext")(
	function* (request: Request) {
		const token = getBearerToken(request.headers)
		const mcpClientName = resolveMcpClientName(request.headers)

		// Internal service auth (e.g. chat agent)
		if (token && token.startsWith(INTERNAL_SERVICE_PREFIX)) {
			const provided = token.slice(INTERNAL_SERVICE_PREFIX.length)
			const env = yield* Env
			const expected = Option.match(env.INTERNAL_SERVICE_TOKEN, {
				onNone: () => undefined,
				onSome: (value) => Redacted.value(value),
			})

			if (!expected) {
				return yield* new McpAuthMissingError({
					message: "INTERNAL_SERVICE_TOKEN is not configured on the server",
				})
			}

			if (
				provided.length === expected.length &&
				timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
			) {
				const orgId = Option.match(env.MAPLE_ORG_ID_OVERRIDE, {
					onNone: () => request.headers.get("x-org-id"),
					onSome: (value) => value,
				})
				if (!orgId) {
					return yield* new McpAuthMissingError({
						message: "x-org-id header is required for internal service auth",
					})
				}

				const validOrgId = yield* decodeOrgId(orgId).pipe(
					Effect.mapError(
						(e) =>
							new McpInvalidTenantError({
								message: e.message,
								field: "orgId",
							}),
					),
				)
				const validUserId = yield* decodeUserId("internal-service").pipe(
					Effect.mapError(
						(e) =>
							new McpInvalidTenantError({
								message: e.message,
								field: "userId",
							}),
					),
				)
				return {
					orgId: validOrgId,
					userId: validUserId,
					roles: [],
					authMode: "self_hosted",
					...(mcpClientName ? { mcpClientName } : undefined),
				} as McpTenantContext
			}

			return yield* new McpAuthInvalidError({
				message: "Internal service token mismatch",
			})
		}

		const apiKeys = yield* ApiKeysService
		const apiKeyResolved = yield* apiKeys.resolveByBearer(token).pipe(
			Effect.catchTag("@maple/http/errors/ApiKeyLookupPersistenceError", () =>
				Effect.fail(
					new McpAuthUnavailableError({
						message: "API key validation is temporarily unavailable",
					}),
				),
			),
		)

		if (Option.isSome(apiKeyResolved)) {
			const resolved = apiKeyResolved.value
			const expectedResource = mcpResourceForRequest(request)
			const isMcpOAuthToken = resolved.mcpOAuthResource !== null
			if (
				isMcpOAuthToken &&
				(resolved.kind !== "mcp" ||
					resolved.mcpOAuthResource !== expectedResource ||
					resolved.scopes?.includes("mcp:tools") !== true)
			) {
				return yield* new McpAuthInvalidError({
					message: "OAuth token is not valid for this MCP resource",
					reason: "invalid_target",
				})
			}
			// Manual MCP/API keys remain legacy full-access credentials. Scoped keys
			// are accepted only when they are audience-bound MCP OAuth tokens.
			if (!isMcpOAuthToken && resolved.scopes !== null) {
				return yield* new McpAuthInvalidError({
					message: "Restricted API keys are not supported by the MCP server",
					reason: "insufficient_scope",
				})
			}
			const validOrgId = yield* decodeOrgId(resolved.orgId).pipe(
				Effect.mapError(
					(e) =>
						new McpInvalidTenantError({
							message: e.message,
							field: "orgId",
						}),
				),
			)
			const validUserId = yield* decodeUserId(resolved.userId).pipe(
				Effect.mapError(
					(e) =>
						new McpInvalidTenantError({
							message: e.message,
							field: "userId",
						}),
				),
			)

			// Actor resolution: prefer an explicit agent override header, else the
			// key's pinned agentActorId metadata. Both must be a valid ActorId; we
			// silently drop malformed values rather than failing the request.
			const keyActorId = extractAgentActorIdFromMetadata(resolved.metadataJson)
			const headerActorId = request.headers.get(AGENT_ACTOR_HEADER)
			const actorIdCandidate = headerActorId ?? keyActorId
			const actorIdOpt =
				actorIdCandidate == null
					? Option.none<
							ReturnType<typeof decodeActorIdOption> extends Option.Option<infer A> ? A : never
						>()
					: decodeActorIdOption(actorIdCandidate)
			const actorId = Option.getOrUndefined(actorIdOpt)

			return {
				orgId: validOrgId,
				userId: validUserId,
				roles: resolved.roles ?? apiKeyDefaultRoles,
				authMode: "self_hosted",
				...(actorId ? { actorId } : undefined),
				...(mcpClientName ? { mcpClientName } : undefined),
			} as McpTenantContext
		}

		// Fall back to existing Clerk / self-hosted session auth
		const auth = yield* AuthService
		const tenant = yield* auth.resolveMcpTenant(toHeaderRecord(request.headers)).pipe(
			Effect.mapError(
				(error) =>
					new McpAuthInvalidError({
						message: error.message || "Authentication failed (no details available)",
						reason: "session_auth_fallback",
					}),
			),
		)

		return {
			orgId: tenant.orgId,
			userId: tenant.userId,
			roles: [...tenant.roles],
			authMode: tenant.authMode,
			...(mcpClientName ? { mcpClientName } : undefined),
		}
	},
	// Missing/invalid credentials are an expected 401, not a failure: annotate the
	// span and log at Warn so it exports with an Ok status (the tag is also listed
	// in MCP_ANTICIPATED_ERROR_IDENTIFIERS, which suppresses the exception event).
	// Runs inside the span — `Effect.fn` pipeline transforms wrap the body, and the
	// span wraps them. The typed error itself is untouched.
	(effect) =>
		Effect.tapError(effect, (error) => recordExpectedMcpFailure(error, "MCP authentication failed")),
)

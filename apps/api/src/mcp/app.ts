import { MAPLE_MCP_SERVER_VERSION } from "@maple/domain/mcp-manifest"
import { McpProtocol, McpServer } from "effect/unstable/ai"
import { Cause, Effect, Layer } from "effect"
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { McpToolsLive } from "./server"
import { DebugErrorsPrompt } from "./prompts/debug-errors"
import { LatencyAnalysisPrompt } from "./prompts/latency-analysis"
import { IncidentTriagePrompt } from "./prompts/incident-triage"
import { InstructionsResource } from "./resources/instructions"
import { sessionStore } from "./lib/session-store"
import type { McpToolExecutor } from "./dispatcher"
import { CurrentMcpRequestTenant, CurrentMcpTenant, resolveHttpMcpTenant } from "./lib/query-warehouse"
import { type AuditActorInfo, CurrentAuditActor } from "@/services/auth/audit-actor"
import { INTERNAL_SERVICE_PREFIX } from "./lib/resolve-tenant"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
import {
	MCP_TOOLS_RATE_LIMIT_PERIOD_SECONDS,
	MCP_TOOLS_RATE_LIMIT_REQUESTS,
	McpToolRateLimiter,
} from "@/services/auth/McpToolRateLimiter"
import { Env } from "@/platform/Env"

const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version"

/**
 * The MCP protocol revisions this server implements. Effect currently ships a
 * single adapter (`effect/unstable/ai/McpProtocol`), so this is a one-element
 * list; it stays an array so adding a revision is a one-line change here and
 * `SUPPORTED_PROTOCOL_VERSIONS` cannot drift from what `layerHttp` registers.
 */
const MCP_PROTOCOLS = [McpProtocol.v2025_06_18] as const

/** Revision advertised back to clients during negotiation. */
const NEGOTIATED_PROTOCOL_VERSION = McpProtocol.v2025_06_18.protocolVersion

const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set(
	MCP_PROTOCOLS.map((protocol) => protocol.protocolVersion),
)

/**
 * Coerces an unsupported `mcp-protocol-version` header onto the revision we
 * implement, so version negotiation can happen in the JSON-RPC body instead of
 * being pre-empted by a bare 400.
 *
 * McpServer rejects any header value outside its registry before it parses the
 * body, and rejects a mismatch again on every post-initialize request because
 * `v2025_06_18` sets `requiresVersionHeader`. Body-level negotiation is already
 * tolerant — `initialize` falls back to the first registered protocol — so the
 * header check is the only thing turning a newer client into a hard failure.
 *
 * That failure is invisible in two ways, which is why this went unnoticed: a
 * 4xx on a SERVER span is `Ok` by our semconv, and the MCP clients in eve — the
 * `@ai-sdk/mcp` client used by apps/slack-agent, which defaults to `2025-11-25`
 * — treat 400 as "wrong transport" and retry over SSE, where a POST-only route
 * answers 405. The caller sees an opaque connection error, never a version
 * mismatch.
 *
 * Clients that send a version we DO implement are untouched, so this is a no-op
 * the moment Effect ships newer adapters and they are added to MCP_PROTOCOLS.
 */
const negotiateProtocolVersion = (request: HttpServerRequest.HttpServerRequest) => {
	const offered = request.headers[MCP_PROTOCOL_VERSION_HEADER]
	if (offered === undefined || SUPPORTED_PROTOCOL_VERSIONS.has(offered)) return request
	return request.modify({
		headers: Headers.set(request.headers, MCP_PROTOCOL_VERSION_HEADER, NEGOTIATED_PROTOCOL_VERSION),
	})
}

const mcpChallenge = (invalid: boolean) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const proto = request.headers["x-forwarded-proto"]?.split(",")[0]?.trim() ?? "https"
		const host = request.headers["x-forwarded-host"]?.split(",")[0]?.trim() ?? request.headers.host
		const resourceMetadata = host
			? `${proto}://${host}/.well-known/oauth-protected-resource/mcp`
			: "/.well-known/oauth-protected-resource/mcp"
		const challenge = `Bearer ${[
			`resource_metadata="${resourceMetadata}"`,
			'scope="mcp:tools"',
			...(invalid ? ['error="invalid_token"'] : []),
		].join(", ")}`
		return HttpServerResponse.jsonUnsafe(
			{ error: "unauthorized", message: "Authenticate with Maple to access this MCP server." },
			{
				status: 401,
				headers: { "www-authenticate": challenge, "cache-control": "no-store" },
			},
		)
	})

const mcpUnavailable = () =>
	Effect.succeed(
		HttpServerResponse.jsonUnsafe(
			{
				error: "service_unavailable",
				message: "Authentication is temporarily unavailable; retry with backoff.",
			},
			{ status: 503, headers: { "cache-control": "no-store" } },
		),
	)

/**
 * Which credential an MCP request presented, as far as the transport can tell.
 * Mirrors the branches in `resolveMcpTenantContext`: an internal service token
 * is Maple acting on its own behalf, any other bearer is an API key or OAuth
 * token, and no bearer at all means a forwarded dashboard session.
 */
const mcpAuditActor = (headers: Record<string, string | undefined>): AuditActorInfo => {
	const authorization = headers["authorization"] ?? headers["Authorization"]
	if (authorization?.toLowerCase().startsWith("bearer ") !== true) {
		return { type: "user", source: "mcp" }
	}
	const bearer = authorization.slice("bearer ".length).trim()
	return bearer.startsWith(INTERNAL_SERVICE_PREFIX)
		? { type: "system", source: "system" }
		: { type: "api_key", source: "mcp" }
}

// Wording mirrors the v2 envelope's `V2RateLimited`; the body stays in this
// surface's `{ error, message }` shape like the 401/503 responses above.
const mcpRateLimited = () =>
	HttpServerResponse.jsonUnsafe(
		{
			error: "rate_limited",
			message: "Too many requests. Retry after the interval in the Retry-After header.",
		},
		{
			status: 429,
			headers: {
				"retry-after": String(MCP_TOOLS_RATE_LIMIT_PERIOD_SECONDS),
				"cache-control": "no-store",
			},
		},
	)

const McpAuthorizationMiddleware = HttpRouter.middleware<{ provides: CurrentMcpTenant }>()(
	Effect.gen(function* () {
		const apiKeys = yield* ApiKeysService
		const auth = yield* AuthService
		const env = yield* Env
		const rateLimiter = yield* McpToolRateLimiter
		return (httpEffect) =>
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				return yield* resolveHttpMcpTenant.pipe(
					Effect.provideService(ApiKeysService, apiKeys),
					Effect.provideService(AuthService, auth),
					Effect.provideService(Env, env),
					Effect.flatMap((tenant) =>
						Effect.gen(function* () {
							if (tenant.rateLimitCredentialId !== undefined) {
								const outcome = yield* rateLimiter.check(tenant.rateLimitCredentialId)
								yield* Effect.annotateCurrentSpan({
									"maple.rate_limit.outcome": outcome,
									"maple.rate_limit.limit": MCP_TOOLS_RATE_LIMIT_REQUESTS,
									"maple.rate_limit.period_seconds": MCP_TOOLS_RATE_LIMIT_PERIOD_SECONDS,
								})
								if (outcome === "limited") return mcpRateLimited()
							}
							return yield* Effect.provideService(httpEffect, CurrentMcpTenant, tenant).pipe(
								Effect.provideService(CurrentMcpRequestTenant, tenant),
								// Without this an MCP mutation reads the reference's `undefined`
								// default and is audited as a dashboard session. The credential
								// kind is all this layer can see — `resolveMcpTenantContext`
								// returns the tenant, not the key it resolved — so the key id is
								// deliberately absent rather than guessed.
								Effect.provideService(CurrentAuditActor, mcpAuditActor(request.headers)),
							)
						}),
					),
					Effect.catchTags({
						"@maple/mcp/errors/McpAuthMissingError": () => mcpChallenge(false),
						"@maple/mcp/errors/McpAuthInvalidError": () => mcpChallenge(true),
						"@maple/mcp/errors/McpAuthUnavailableError": mcpUnavailable,
						"@maple/mcp/errors/McpInvalidTenantError": () => mcpChallenge(true),
					}),
					Effect.provideService(
						HttpServerRequest.HttpServerRequest,
						negotiateProtocolVersion(request),
					),
				)
			})
	}),
)

const McpHttpLive = McpServer.layerHttp({
	name: "maple-observability",
	// Kept equal to the public `server.json` manifest (`@maple/domain/mcp-manifest`).
	version: MAPLE_MCP_SERVER_VERSION,
	path: "/mcp",
	protocols: MCP_PROTOCOLS,
	clientSessions: sessionStore,
}).pipe(Layer.provide(McpAuthorizationMiddleware.layer))

export const McpLive: Layer.Layer<
	never,
	Cause.IllegalArgumentError,
	HttpRouter.HttpRouter | ApiKeysService | AuthService | Env | McpToolExecutor | McpToolRateLimiter
> = Layer.mergeAll(
	McpToolsLive,
	DebugErrorsPrompt,
	LatencyAnalysisPrompt,
	IncidentTriagePrompt,
	InstructionsResource,
).pipe(Layer.provide(McpHttpLive))

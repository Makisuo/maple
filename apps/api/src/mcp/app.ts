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
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
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
 * 4xx on a SERVER span is `Ok` by our semconv, and the MCP clients in eve treat
 * 400 as "wrong transport" and retry over SSE, where a POST-only route answers
 * 405. The caller sees an opaque connection error, never a version mismatch.
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

const McpAuthorizationMiddleware = HttpRouter.middleware<{ provides: CurrentMcpTenant }>()(
	Effect.gen(function* () {
		const apiKeys = yield* ApiKeysService
		const auth = yield* AuthService
		const env = yield* Env
		return (httpEffect) =>
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				return yield* resolveHttpMcpTenant.pipe(
					Effect.provideService(ApiKeysService, apiKeys),
					Effect.provideService(AuthService, auth),
					Effect.provideService(Env, env),
					Effect.flatMap((tenant) =>
						Effect.provideService(httpEffect, CurrentMcpTenant, tenant).pipe(
							Effect.provideService(CurrentMcpRequestTenant, tenant),
						),
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
	version: "1.0.0",
	path: "/mcp",
	protocols: MCP_PROTOCOLS,
	clientSessions: sessionStore,
}).pipe(Layer.provide(McpAuthorizationMiddleware.layer))

export const McpLive: Layer.Layer<
	never,
	Cause.IllegalArgumentError,
	HttpRouter.HttpRouter | ApiKeysService | AuthService | Env | McpToolExecutor
> = Layer.mergeAll(
	McpToolsLive,
	DebugErrorsPrompt,
	LatencyAnalysisPrompt,
	IncidentTriagePrompt,
	InstructionsResource,
).pipe(Layer.provide(McpHttpLive))

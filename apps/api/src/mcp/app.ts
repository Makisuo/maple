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
 * `effect`'s `McpServer.layerHttp` (as of the pinned rc.108) rejects any request whose
 * `Mcp-Protocol-Version` header isn't in the server's declared `protocols` list with a
 * bare 400 — including the `initialize` request, where that header is only the client's
 * *preferred* version, not yet a negotiated one (negotiation happens via the `initialize`
 * body/response per the MCP spec). Clients that default to a newer version than we
 * implement — e.g. the `@ai-sdk/mcp` client vendored in `eve`, which defaults to
 * `2025-11-25` — get a 400 on the very first request instead of a normal downgrade.
 * Since this server only ever implements one protocol version, rewriting an
 * unsupported header to that version is always correct: it fixes the `initialize`
 * precheck and keeps the post-initialize session-continuity check (which compares the
 * header against the version recorded on the session) consistent too.
 */
const normalizeMcpProtocolVersionHeader = <A, E, R>(
	httpEffect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | HttpServerRequest.HttpServerRequest> =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const protocolVersion = request.headers["mcp-protocol-version"]
		if (protocolVersion === undefined || protocolVersion === McpProtocol.v2025_06_18.protocolVersion) {
			return yield* httpEffect
		}
		const normalizedRequest = request.modify({
			headers: Headers.set(request.headers, "mcp-protocol-version", McpProtocol.v2025_06_18.protocolVersion),
		})
		return yield* Effect.provideService(httpEffect, HttpServerRequest.HttpServerRequest, normalizedRequest)
	})

const McpAuthorizationMiddleware = HttpRouter.middleware<{ provides: CurrentMcpTenant }>()(
	Effect.gen(function* () {
		const apiKeys = yield* ApiKeysService
		const auth = yield* AuthService
		const env = yield* Env
		return (httpEffect) =>
			resolveHttpMcpTenant.pipe(
				Effect.provideService(ApiKeysService, apiKeys),
				Effect.provideService(AuthService, auth),
				Effect.provideService(Env, env),
				Effect.flatMap((tenant) =>
					Effect.provideService(normalizeMcpProtocolVersionHeader(httpEffect), CurrentMcpTenant, tenant).pipe(
						Effect.provideService(CurrentMcpRequestTenant, tenant),
					),
				),
				Effect.catchTags({
					"@maple/mcp/errors/McpAuthMissingError": () => mcpChallenge(false),
					"@maple/mcp/errors/McpAuthInvalidError": () => mcpChallenge(true),
					"@maple/mcp/errors/McpAuthUnavailableError": mcpUnavailable,
					"@maple/mcp/errors/McpInvalidTenantError": () => mcpChallenge(true),
				}),
			)
	}),
)

const McpHttpLive = McpServer.layerHttp({
	name: "maple-observability",
	version: "1.0.0",
	path: "/mcp",
	protocols: [McpProtocol.v2025_06_18],
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

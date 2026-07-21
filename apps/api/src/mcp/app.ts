import { McpServer } from "effect/unstable/ai"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { McpToolsLive } from "./server"
import { DebugErrorsPrompt } from "./prompts/debug-errors"
import { LatencyAnalysisPrompt } from "./prompts/latency-analysis"
import { IncidentTriagePrompt } from "./prompts/incident-triage"
import { InstructionsResource } from "./resources/instructions"
import { sessionStore } from "./lib/session-store"
import { CurrentMcpTenant, resolveHttpMcpTenant } from "./lib/query-warehouse"
import { ApiKeysService } from "../services/ApiKeysService"
import { AuthService } from "../services/AuthService"
import { Env } from "../lib/Env"

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
				Effect.flatMap((tenant) => Effect.provideService(httpEffect, CurrentMcpTenant, tenant)),
				Effect.catchTags({
					"@maple/mcp/errors/McpAuthMissingError": () => mcpChallenge(false),
					"@maple/mcp/errors/McpAuthInvalidError": () => mcpChallenge(true),
					"@maple/mcp/errors/McpInvalidTenantError": () => mcpChallenge(true),
				}),
			)
	}),
)

const McpHttpLive = McpServer.layerHttp({
	name: "maple-observability",
	version: "1.0.0",
	path: "/mcp",
	clientSessions: sessionStore,
}).pipe(Layer.provide(McpAuthorizationMiddleware.layer))

export const McpLive = Layer.mergeAll(
	McpToolsLive,
	DebugErrorsPrompt,
	LatencyAnalysisPrompt,
	IncidentTriagePrompt,
	InstructionsResource,
).pipe(Layer.provide(McpHttpLive))

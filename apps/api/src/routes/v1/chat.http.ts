import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	ChatApplyResponse,
	ChatToolInvalidInputError,
	ChatToolNotApplicableError,
	ChatToolNotFoundError,
	MapleApi,
} from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { mapleToolDefinitions } from "@/mcp/tools/registry"
import { MUTATING_TOOL_NAMES } from "@/mcp/tools/mutating"
import type { McpToolResult } from "@/mcp/tools/types"

const errorResult = (label: string, message: string): McpToolResult => ({
	isError: true,
	content: [{ type: "text", text: `${label}: ${message}` }],
})

/**
 * `POST /api/chat/apply` — apply an approval-gated AI chat proposal by re-running
 * the named MCP mutation tool under the caller's Clerk-authenticated org. The
 * tool handler resolves its own tenant from the request (Clerk session fallback
 * in `resolveMcpTenantContext`), so no extra tenant wiring is needed — the route
 * just guards the allowlist, validates input against the tool's schema, and runs
 * the existing handler with the full app service layer (provided via `MainLive`).
 */
export const HttpChatLive = HttpApiBuilder.group(MapleApi, "chat", (handlers) =>
	handlers.handle("apply", ({ payload }) =>
		Effect.gen(function* () {
			const tool = payload.tool

			// Defense in depth: only approval-gated mutations are applicable here.
			if (!MUTATING_TOOL_NAMES.has(tool)) {
				return yield* new ChatToolNotApplicableError({
					tool,
					message: `Tool "${tool}" is not an approval-applicable mutation.`,
				})
			}

			const definition = mapleToolDefinitions.find((d) => d.name === tool)
			if (!definition) {
				return yield* new ChatToolNotFoundError({ tool, message: `Unknown tool "${tool}".` })
			}

			const decoded = yield* Effect.try({
				try: () => Schema.decodeUnknownSync(definition.schema)(payload.input),
				catch: (error) =>
					new ChatToolInvalidInputError({
						tool,
						message: `Invalid input for "${tool}": ${String(error)}`,
					}),
			})

			// Run the real tool. Mirror the MCP server: domain-level tool failures
			// (query/tenant/auth) become an `isError` result carrying the message,
			// rather than a transport error — the approval card surfaces it inline.
			const result = yield* definition.handler(decoded).pipe(
				Effect.catchTags({
					"@maple/mcp/errors/McpQueryError": (e) => Effect.succeed(errorResult(e._tag, e.message)),
					"@maple/mcp/errors/McpTenantError": (e) => Effect.succeed(errorResult(e._tag, e.message)),
					"@maple/mcp/errors/McpAuthMissingError": (e) =>
						Effect.succeed(errorResult(e._tag, e.message)),
					"@maple/mcp/errors/McpAuthInvalidError": (e) =>
						Effect.succeed(errorResult(e._tag, e.message)),
					"@maple/mcp/errors/McpInvalidTenantError": (e) =>
						Effect.succeed(errorResult(`${e._tag} (${e.field})`, e.message)),
				}),
			)

			return new ChatApplyResponse({
				content: result.content.map((entry) => entry.text).join("\n"),
				...(result.isError === true ? { isError: true } : {}),
			})
		}),
	),
)

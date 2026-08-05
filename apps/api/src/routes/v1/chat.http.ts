import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	ChatApplyResponse,
	ChatToolInvalidInputError,
	ChatToolNotApplicableError,
	ChatToolNotFoundError,
	MapleApi,
} from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"
import { WorkerEnvironment } from "@maple/effect-cloudflare"
import { orgIdFromChatSessionId } from "@maple/domain/chat-session"
import { chatSessionStub } from "@/chat/session"
import { mapleToolDefinitions } from "@/mcp/tools/registry"
import { MUTATING_TOOL_NAMES } from "@/mcp/tools/mutating"
import { resolveHttpMcpTenant } from "@/mcp/lib/query-warehouse"
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
 *
 * When the caller names the conversation the proposal came from, the outcome is also appended to
 * that session's durable log as the proposed call's `tool-result`. That is what settles the
 * approval card and what tells the model, on its next turn, that the mutation actually happened —
 * both of which the propose-then-apply split otherwise loses.
 */
/**
 * Append the applied mutation's outcome to the conversation as the proposed call's `tool-result`.
 *
 * Org-checked against the caller for the same reason the chat transport is: the session id names
 * an org, and it arrives in a request body.
 */
const recordApplyOutcome = (
	payload: {
		readonly sessionId?: string
		readonly messageId?: string
		readonly toolCallId?: string
	},
	content: string,
	isError: boolean,
) =>
	Effect.gen(function* () {
		const { sessionId, messageId, toolCallId } = payload
		if (sessionId === undefined || messageId === undefined || toolCallId === undefined) return

		const sessionOrgId = orgIdFromChatSessionId(sessionId)
		if (!sessionOrgId) return

		const tenant = yield* Effect.option(resolveHttpMcpTenant)
		if (Option.isNone(tenant) || tenant.value.orgId !== sessionOrgId) return

		const env = yield* WorkerEnvironment
		const stub = chatSessionStub(env, sessionId)
		if (!stub) return

		yield* Effect.tryPromise(() =>
			stub.append({
				type: "tool-result",
				// Must be the assistant message that issued the proposal: `history()` opens the
				// message by `messageId` and only then finds the call by `callId`. Anything else
				// spawns a stray message and the proposal stays unsettled.
				messageId,
				callId: toolCallId,
				output: content,
				...(isError ? { isError: true } : {}),
			}),
		)
	})

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

			const content = result.content.map((entry) => entry.text).join("\n")

			// Best-effort: the mutation has already run and its outcome is the response. A session
			// that cannot be reached must not turn a successful apply into a failed request.
			yield* recordApplyOutcome(payload, content, result.isError === true).pipe(
				Effect.catchCause(() => Effect.void),
			)

			return new ChatApplyResponse({
				content,
				...(result.isError === true ? { isError: true } : {}),
			})
		}),
	),
)

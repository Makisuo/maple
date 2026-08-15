import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	ChatApplyResponse,
	ChatToolExecutionError,
	ChatToolInvalidInputError,
	ChatToolNotApplicableError,
	ChatToolNotFoundError,
	CurrentTenant,
	MapleApi,
} from "@maple/domain/http"
import { Cause, Effect, Schema } from "effect"
import { WorkerEnvironment } from "@maple/effect-cloudflare"
import { orgIdFromChatSessionId } from "@maple/domain/chat-session"
import { chatSessionStub } from "@/chat/session"
import { mapleToolCatalog } from "@/mcp/tools/registry"
import { MUTATING_TOOL_NAMES } from "@/mcp/tools/mutating"
import { McpToolExecutor } from "@/mcp/dispatcher"
import type { TenantContext } from "@/services/auth/tenant-context"

const executionDefect = (tool: string, defect: unknown) =>
	Effect.logError("Chat approval tool execution defect").pipe(
		Effect.annotateLogs({ tool, defect }),
		Effect.andThen(
			Effect.fail(
				new ChatToolExecutionError({
					tool,
					message: `Could not apply "${tool}". Please try again.`,
				}),
			),
		),
	)

/**
 * `POST /api/chat/apply` — apply an approval-gated AI chat proposal by re-running
 * the named MCP mutation tool under the caller's authenticated tenant. The
 * authorization middleware has already resolved CurrentTenant; the executor
 * requires that tenant as an ordinary argument and closes all handler services.
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
	orgId: TenantContext["orgId"],
	content: string,
	isError: boolean,
) =>
	Effect.gen(function* () {
		const { sessionId, messageId, toolCallId } = payload
		if (sessionId === undefined || messageId === undefined || toolCallId === undefined) return

		const sessionOrgId = orgIdFromChatSessionId(sessionId)
		if (!sessionOrgId) return

		if (orgId !== sessionOrgId) return

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
				...(isError ? { isError: true } : undefined),
			}),
		)
	})

export const HttpChatLive = HttpApiBuilder.group(MapleApi, "chat", (handlers) =>
	handlers.handle("apply", ({ payload }) =>
		Effect.gen(function* () {
			const tool = payload.tool
			const authenticated = yield* CurrentTenant.Context
			const executor = yield* McpToolExecutor
			const tenant: TenantContext = {
				orgId: authenticated.orgId,
				userId: authenticated.userId,
				roles: [...authenticated.roles],
				authMode: authenticated.authMode,
			}

			// Defense in depth: only approval-gated mutations are applicable here.
			if (!MUTATING_TOOL_NAMES.has(tool)) {
				return yield* new ChatToolNotApplicableError({
					tool,
					message: `Tool "${tool}" is not an approval-applicable mutation.`,
				})
			}

			const definition = mapleToolCatalog.find((d) => d.name === tool)
			if (!definition) {
				return yield* new ChatToolNotFoundError({ tool, message: `Unknown tool "${tool}".` })
			}

			yield* Schema.decodeUnknownEffect(definition.schema)(payload.input).pipe(
				Effect.mapError(
					(error) =>
						new ChatToolInvalidInputError({
							tool,
							message: `Invalid input for "${tool}": ${String(error)}`,
						}),
				),
			)

			// Domain-level tool failures are encoded as `isError` by the shared dispatcher.
			// A defect remains a transport failure, but it is declared and serialized instead
			// of falling through HttpApi as a bodyless 500.
			const result = yield* executor.execute(tenant, tool, payload.input).pipe(
				Effect.catchTag("@maple/internal-rpc/ToolNotFoundError", () =>
					Effect.fail(new ChatToolNotFoundError({ tool, message: `Unknown tool "${tool}".` })),
				),
				Effect.catchDefect((defect) => executionDefect(tool, defect)),
			)

			const content = result.content.map((entry) => entry.text).join("\n")

			// Best-effort: the mutation has already run and its outcome is the response. A session
			// that cannot be reached must not turn a successful apply into a failed request.
			yield* recordApplyOutcome(payload, tenant.orgId, content, result.isError === true).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.annotateCurrentSpan("maple.chat.apply_outcome_record_failed", true).pipe(
								Effect.andThen(
									Effect.logWarning("Failed to record a chat approval outcome").pipe(
										Effect.annotateLogs({
											orgId: tenant.orgId,
											tool,
											sessionId: payload.sessionId ?? "(none)",
											messageId: payload.messageId ?? "(none)",
											toolCallId: payload.toolCallId ?? "(none)",
											cause: Cause.pretty(cause),
										}),
									),
								),
							),
				),
			)

			return new ChatApplyResponse({
				content,
				...(result.isError === true ? { isError: true } : undefined),
			})
		}),
	),
)

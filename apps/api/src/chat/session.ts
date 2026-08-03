/**
 * Starting a chat turn — the one entry point, shared by the HTTP transport and by the autonomous
 * investigation kickoff.
 *
 * Under Flue there were two very different paths into the same conversation: the browser POSTed to
 * `/agents/maple-chat/:id` on the chat-flue Worker, and `InvestigationService` POSTed the *same*
 * URL back over the `CHAT_FLUE` service binding with an internal service token, purely because the
 * agent lived in another Worker. Now that the agent runs here, both are one function call.
 */
import type { ChatEventInput, ChatMessage } from "@maple/domain/chat-session"
import { Message } from "@maple/llm"
import { Effect, Stream } from "effect"
import { resolveTriageModel } from "@/platform/Llm"
import type { TenantContext } from "@/services/auth/tenant-context"
import { buildSubmitDiagnosisTool, runChatTurn, type ChatTurnEvent, type SubmitDiagnosis } from "./agent"

/** The `ChatSession` Durable Object's RPC surface. Mirrors `./ChatSession.ts`. */
export interface ChatSessionStub {
	readonly cursor: () => Promise<number>
	readonly running: () => Promise<boolean>
	readonly history: () => Promise<ReadonlyArray<ChatMessage>>
	readonly since: (cursor: number) => Promise<ReadonlyArray<import("@maple/domain/chat-session").ChatEvent>>
	readonly tail: (cursor: number) => Promise<ReadonlyArray<import("@maple/domain/chat-session").ChatEvent>>
	readonly append: (event: ChatEventInput) => Promise<number>
	readonly beginTurn: (
		messageId: string,
		text: string,
	) => Promise<{ cursor: number; messageId: string } | undefined>
	readonly endTurn: () => Promise<void>
	readonly abort: (messageId: string) => Promise<void>
}

export interface ChatSessionNamespace {
	readonly idFromName: (name: string) => unknown
	readonly get: (id: unknown) => ChatSessionStub
}

export const isChatSessionNamespace = (value: unknown): value is ChatSessionNamespace =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { get?: unknown }).get === "function" &&
	typeof (value as { idFromName?: unknown }).idFromName === "function"

/** Resolve the `CHAT_SESSION` binding off a worker env record, or `undefined` if it is missing. */
export const chatSessionStub = (
	env: Record<string, unknown>,
	sessionId: string,
): ChatSessionStub | undefined => {
	const namespace = env.CHAT_SESSION
	if (!isChatSessionNamespace(namespace)) return undefined
	return namespace.get(namespace.idFromName(sessionId))
}

export interface StartChatTurnInput {
	readonly sessionId: string
	readonly tenant: TenantContext
	readonly env: Record<string, unknown>
	readonly stub: ChatSessionStub
	readonly messageId: string
	/**
	 * How an investigate-mode session records its report. Passed in rather than resolved here so
	 * `InvestigationService` — which is both the implementation and a caller of this function —
	 * does not end up requiring itself.
	 */
	readonly submitDiagnosis: SubmitDiagnosis
}

/**
 * Drive one turn, appending each event to the session as it is produced.
 *
 * Events go to the Durable Object rather than straight to the caller for two reasons: the
 * transcript has to survive a reload, and the request that submits a message is not the request
 * reading the stream. `endTurn` runs in an ensuring block so a defect cannot strand the session
 * with `running = 1` and wedge the composer for every tab on the conversation.
 */
export const runChatSessionTurn = (input: StartChatTurnInput) =>
	Effect.gen(function* () {
		const history = yield* Effect.promise(() => input.stub.history())
		const extraTools = buildSubmitDiagnosisTool(input.sessionId, input.tenant, input.submitDiagnosis)
		yield* runChatTurn({
			sessionId: input.sessionId,
			tenant: input.tenant,
			model: resolveTriageModel(input.env),
			messages: toLlmMessages(history),
			messageId: input.messageId,
			extraTools,
		}).pipe(Stream.runForEach((event: ChatTurnEvent) => Effect.promise(() => input.stub.append(event))))
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.promise(() =>
				input.stub.append({
					type: "turn-end",
					messageId: input.messageId,
					reason: "error",
					error: String(cause),
				}),
			).pipe(Effect.asVoid),
		),
		Effect.ensuring(Effect.promise(() => input.stub.endTurn())),
		Effect.withSpan("chat.turn", {
			attributes: { orgId: input.tenant.orgId, "maple.chat.session": input.sessionId },
		}),
	)

/**
 * Project the durable transcript into `@maple/llm` messages.
 *
 * Tool calls are deliberately NOT replayed as tool messages: a rehydrated conversation needs the
 * *conclusions*, not a second copy of every tool payload, and replaying tool results without their
 * matching provider-native call ids is what makes providers reject a continuation. The assistant's
 * text is what carries forward.
 */
const toLlmMessages = (history: ReadonlyArray<ChatMessage>): ReadonlyArray<Message> =>
	history
		.filter((message) => message.text.trim() !== "")
		.map((message) =>
			message.role === "user" ? Message.user(message.text) : Message.assistant(message.text),
		)

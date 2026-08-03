/**
 * Reaching a chat session's Durable Object.
 *
 * This module is deliberately tiny and dependency-free: it is imported by `ai-triage-enqueue` and
 * `InvestigationService`, which are themselves reachable from the MCP tool registry, so anything
 * heavy here would close an import cycle back through `chat/agent.ts`.
 *
 * Starting a turn is now a single `beginTurn` call. Under Flue there were two very different paths
 * into the same conversation — the browser POSTed to `/agents/maple-chat/:id` on the chat-flue
 * Worker, and `InvestigationService` POSTed the *same* URL back over the `CHAT_FLUE` service
 * binding with an internal service token, purely because the agent lived in another Worker. The
 * turn now runs inside the Durable Object itself (see `ChatSession.beginTurn`), so both paths are
 * one method call and neither has to keep the turn alive.
 */
import type {
	ChatEvent,
	ChatEventInput,
	ChatMessage,
	ChatTurnTenant,
} from "@maple/domain/chat-session"

/** The `ChatSession` Durable Object's RPC surface. Mirrors `./ChatSession.ts`. */
export interface ChatSessionStub {
	readonly cursor: () => Promise<number>
	readonly running: () => Promise<boolean>
	readonly history: () => Promise<ReadonlyArray<ChatMessage>>
	readonly since: (cursor: number) => Promise<ReadonlyArray<ChatEvent>>
	readonly tail: (cursor: number) => Promise<ReadonlyArray<ChatEvent>>
	readonly append: (event: ChatEventInput) => Promise<number>
	readonly beginTurn: (input: {
		readonly sessionId: string
		readonly messageId: string
		readonly text: string
		readonly tenant: ChatTurnTenant
	}) => Promise<{ cursor: number; messageId: string } | undefined>
	readonly holdsTurn: (messageId: string) => Promise<boolean>
	readonly endTurn: (messageId: string) => Promise<void>
	readonly abort: () => Promise<void>
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

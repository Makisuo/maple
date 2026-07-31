import { createFlueClient, type FlueClient } from "@flue/sdk"
import { flueChatUrl } from "@/lib/services/common/flue-chat-url"
import { getMapleAuthHeaders } from "@/lib/services/common/auth-headers"
import { tracedFetch } from "@/lib/services/common/telemetry"

/** Mount path of the chat agent's router in `apps/chat-flue`'s `app.ts`. */
const AGENT_MOUNT = "agents/maple-chat"

/**
 * Build a `@flue/sdk` client for ONE chat conversation.
 *
 * Flue 2 removed the deployment-wide client (and with it `FlueProvider` /
 * `useFlueClient`): a client addresses exactly one conversation by URL — the
 * agent's mount path plus the conversation id — so there is nothing left to
 * share through React context. Callers memoize per conversation id; a new client
 * instance replaces the live session.
 *
 * The `headers` resolver runs per HTTP request (and per Durable-Streams
 * reconnect), so it always attaches a fresh Clerk session token — the chat-flue
 * worker's `/agents/maple-chat/*` middleware verifies it and checks the caller's
 * org owns the addressed instance.
 */
export const createChatConversationClient = (conversationId: string): FlueClient =>
	createFlueClient({
		url: `${flueChatUrl}/${AGENT_MOUNT}/${encodeURIComponent(conversationId)}`,
		fetch: (input, init) => tracedFetch("maple-chat-flue", input, init),
		headers: async (): Promise<Record<string, string>> => {
			const headers = await getMapleAuthHeaders()
			return headers.authorization ? { Authorization: headers.authorization } : {}
		},
	})

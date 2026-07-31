import { fetch as expoFetch } from "expo/fetch"
import { createFlueClient, type FlueClient } from "@flue/sdk"
import { conversationUrl } from "./flue-chat-url"

/**
 * Build a `@flue/sdk` client for ONE chat conversation.
 *
 * Flue 2 removed the deployment-wide client: a client addresses exactly one
 * conversation by URL (the agent's mount path plus the conversation id), so
 * callers memoize per org+thread.
 *
 * - `fetch: expoFetch` — RN's built-in fetch can't read streaming response
 *   bodies; `expo/fetch` can, which the Durable-Streams transport needs.
 * - `headers` resolves per request (and per stream reconnect), so it always
 *   attaches a fresh Clerk token; the chat-flue `/agents/maple-chat/*`
 *   middleware verifies it and checks the caller's org owns the addressed
 *   instance.
 */
export function makeFlueChatClient(
	orgId: string,
	threadId: string,
	getToken: () => Promise<string | null>,
): FlueClient {
	return createFlueClient({
		url: conversationUrl(orgId, threadId),
		fetch: expoFetch as unknown as typeof fetch,
		headers: async (): Promise<Record<string, string>> => {
			const token = await getToken()
			return token ? { Authorization: `Bearer ${token}` } : {}
		},
	})
}

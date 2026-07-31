// Base URL of the Flue chat backend (`apps/chat-flue`). Dev defaults to the
// `vite dev` port; prod to the chat custom domain. Override with
// EXPO_PUBLIC_FLUE_CHAT_URL.
export const flueChatUrl =
	process.env.EXPO_PUBLIC_FLUE_CHAT_URL ?? (__DEV__ ? "http://127.0.0.1:3583" : "https://chat.maple.dev")

/** Mount path of the chat agent's router in chat-flue's `app.ts`. */
const AGENT_MOUNT = "agents/maple-chat"

/** Flue conversation id: the org-scoped conversation address. */
export function scopedAgentName(orgId: string, threadId: string): string {
	return `${orgId}:${threadId}`
}

/**
 * URL of one chat conversation — what `createFlueClient({ url })` addresses in
 * Flue 2, replacing the old deployment origin + agent-name pair.
 */
export function conversationUrl(orgId: string, threadId: string): string {
	return `${flueChatUrl}/${AGENT_MOUNT}/${encodeURIComponent(scopedAgentName(orgId, threadId))}`
}

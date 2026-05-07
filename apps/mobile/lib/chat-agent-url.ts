export const chatAgentUrl =
	process.env.EXPO_PUBLIC_CHAT_AGENT_URL ?? (__DEV__ ? "http://127.0.0.1:8787" : "https://chat.maple.dev")

export const CHAT_AGENT_CLASS = "chat-agent"

export function scopedAgentName(orgId: string, threadId: string): string {
	return `${orgId}:${threadId}`
}

export function mobileChatUrl(orgId: string, threadId: string): string {
	const name = encodeURIComponent(scopedAgentName(orgId, threadId))
	return `${chatAgentUrl}/agents/${CHAT_AGENT_CLASS}/${name}/mobile-chat`
}

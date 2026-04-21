export const chatAgentUrl =
	process.env.EXPO_PUBLIC_CHAT_AGENT_URL ??
	(__DEV__ ? "http://127.0.0.1:8787" : "https://chat.maple.dev")

export const CHAT_AGENT_CLASS = "chat-agent"

export function mobileChatUrl(threadId: string): string {
	return `${chatAgentUrl}/agents/${CHAT_AGENT_CLASS}/${encodeURIComponent(threadId)}/mobile-chat`
}

import { ChatConversation } from "@/components/chat/chat-conversation"

export function GlobalChatContent({ tabId }: { tabId: string }) {
	return <ChatConversation tabId={tabId} isActive />
}

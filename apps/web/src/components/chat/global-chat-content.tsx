import { ChatConversation } from "@/components/chat/chat-conversation"

export function GlobalChatContent({
	tabId,
	onFirstMessage,
}: {
	tabId: string
	onFirstMessage?: (tabId: string, text: string) => void
}) {
	return <ChatConversation tabId={tabId} isActive onFirstMessage={onFirstMessage} />
}

import { ChatConversation } from "@/components/chat/chat-conversation"
import { FlueClientProvider } from "@/components/chat/flue-client-provider"

export function GlobalChatContent({ tabId }: { tabId: string }) {
	return (
		<FlueClientProvider>
			<ChatConversation tabId={tabId} isActive />
		</FlueClientProvider>
	)
}

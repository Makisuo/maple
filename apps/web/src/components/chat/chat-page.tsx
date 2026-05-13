import { useAuth } from "@clerk/clerk-react"
import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@maple/ui/components/ui/sidebar"
import { useChatTabs } from "@/hooks/use-chat-tabs"
import { ChatTabBar } from "./chat-tabs"
import { ChatConversation } from "./chat-conversation"

interface ChatPageProps {
	initialTabId?: string
}

export function ChatPage({ initialTabId }: ChatPageProps) {
	const { orgId } = useAuth()
	if (!orgId) return null
	return <ChatPageInner orgId={orgId} initialTabId={initialTabId} />
}

interface ChatPageInnerProps extends ChatPageProps {
	orgId: string
}

function ChatPageInner({ orgId, initialTabId }: ChatPageInnerProps) {
	const { tabs, activeTabId, createTab, closeTab, setActiveTab, renameTab } =
		useChatTabs(orgId, initialTabId)

	return (
		<SidebarProvider>
			<AppSidebar />
			<SidebarInset>
				<header className="flex h-12 shrink-0 items-center border-b px-2">
					<SidebarTrigger className="-ml-0.5" />
					<ChatTabBar
						tabs={tabs}
						activeTabId={activeTabId}
						onSelect={setActiveTab}
						onClose={closeTab}
						onCreate={createTab}
					/>
				</header>
				<div className="relative min-h-0 flex-1 bg-background">
					{/* Only mount the active tab. Mounting all of them opens one
					    long-poll stream per tab; on HTTP/1.1 (no HTTPS in dev),
					    the browser caps at ~6 concurrent connections per origin
					    and the streams deadlock. */}
					{activeTabId && (
						<div key={activeTabId} className="flex h-full flex-col">
							<ChatConversation
								tabId={activeTabId}
								isActive
								onFirstMessage={(id, text) => renameTab(id, text)}
							/>
						</div>
					)}
				</div>
			</SidebarInset>
		</SidebarProvider>
	)
}

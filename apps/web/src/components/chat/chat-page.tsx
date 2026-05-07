import { useEffect } from "react"
import { useAuth } from "@clerk/clerk-react"
import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@maple/ui/components/ui/sidebar"
import { useChatTabs } from "@/hooks/use-chat-tabs"
import { ChatTabBar } from "./chat-tabs"
import { ChatConversation } from "./chat-conversation"
import { alertTabId, alertTabTitle, type AlertContext } from "./alert-context"

interface ChatPageProps {
	initialTabId?: string
	mode?: "alert"
	alertContext?: AlertContext
}

export function ChatPage({ initialTabId, mode, alertContext }: ChatPageProps) {
	const { orgId } = useAuth()
	if (!orgId) return null
	return (
		<ChatPageInner
			orgId={orgId}
			initialTabId={initialTabId}
			mode={mode}
			alertContext={alertContext}
		/>
	)
}

interface ChatPageInnerProps extends ChatPageProps {
	orgId: string
}

function ChatPageInner({ orgId, initialTabId, mode, alertContext }: ChatPageInnerProps) {
	const { tabs, activeTabId, createTab, closeTab, setActiveTab, renameTab, ensureTab } =
		useChatTabs(orgId, initialTabId)

	useEffect(() => {
		if (mode !== "alert" || !alertContext) return
		ensureTab(alertTabId(alertContext), alertTabTitle(alertContext))
	}, [mode, alertContext, ensureTab])

	const alertTab = mode === "alert" && alertContext ? alertTabId(alertContext) : undefined

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
					{tabs.map((tab) => {
						const isAlertTab = tab.id === alertTab
						return (
							<div
								key={tab.id}
								className={tab.id === activeTabId ? "flex h-full flex-col" : "hidden"}
							>
								<ChatConversation
									tabId={tab.id}
									isActive={tab.id === activeTabId}
									onFirstMessage={(id, text) => renameTab(id, text)}
									mode={isAlertTab ? "alert" : undefined}
									alertContext={isAlertTab ? alertContext : undefined}
								/>
							</div>
						)
					})}
				</div>
			</SidebarInset>
		</SidebarProvider>
	)
}

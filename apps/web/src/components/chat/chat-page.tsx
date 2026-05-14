import { useEffect } from "react"
import { useAuth } from "@clerk/clerk-react"
import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { SidebarInset, SidebarProvider } from "@maple/ui/components/ui/sidebar"
import { useChatTabs } from "@/hooks/use-chat-tabs"
import { ChatSidebar } from "./chat-sidebar"
import { ChatConversation } from "./chat-conversation"
import { alertTabId, alertTabTitle, type AlertContext } from "./alert-context"
import {
	widgetFixTabId,
	widgetFixTabTitle,
	type WidgetFixContext,
} from "./widget-fix-context"

interface ChatPageProps {
	initialTabId?: string
	mode?: "alert" | "widget-fix"
	alertContext?: AlertContext
	widgetFixContext?: WidgetFixContext
}

export function ChatPage({ initialTabId, mode, alertContext, widgetFixContext }: ChatPageProps) {
	const { orgId } = useAuth()
	if (!orgId) return null
	return (
		<ChatPageInner
			orgId={orgId}
			initialTabId={initialTabId}
			mode={mode}
			alertContext={alertContext}
			widgetFixContext={widgetFixContext}
		/>
	)
}

interface ChatPageInnerProps extends ChatPageProps {
	orgId: string
}

function ChatPageInner({
	orgId,
	initialTabId,
	mode,
	alertContext,
	widgetFixContext,
}: ChatPageInnerProps) {
	const { tabs, activeTabId, createTab, closeTab, setActiveTab, renameTab, ensureTab } =
		useChatTabs(orgId, initialTabId)

	useEffect(() => {
		if (mode !== "alert" || !alertContext) return
		ensureTab(alertTabId(alertContext), alertTabTitle(alertContext))
	}, [mode, alertContext, ensureTab])

	useEffect(() => {
		if (mode !== "widget-fix" || !widgetFixContext) return
		ensureTab(widgetFixTabId(widgetFixContext), widgetFixTabTitle(widgetFixContext))
	}, [mode, widgetFixContext, ensureTab])

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey
			if (!mod || !e.shiftKey) return
			if (e.key === "O" || e.key === "o") {
				e.preventDefault()
				createTab()
			}
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [createTab])

	const alertTab = mode === "alert" && alertContext ? alertTabId(alertContext) : undefined
	const widgetFixTab =
		mode === "widget-fix" && widgetFixContext ? widgetFixTabId(widgetFixContext) : undefined

	return (
		<SidebarProvider open={false} onOpenChange={() => {}}>
			<AppSidebar />
			<SidebarInset>
				<div className="flex h-full min-h-0 flex-1">
					<ChatSidebar
						tabs={tabs}
						activeTabId={activeTabId}
						onSelect={setActiveTab}
						onClose={closeTab}
						onCreate={createTab}
						onRename={renameTab}
					/>
					<div className="flex min-w-0 flex-1 flex-col">
						<div className="relative min-h-0 flex-1 bg-background">
							{tabs.map((tab) => {
								const isAlertTab = tab.id === alertTab
								const isWidgetFixTab = tab.id === widgetFixTab
								return (
									<div
										key={tab.id}
										className={tab.id === activeTabId ? "flex h-full flex-col" : "hidden"}
									>
										<ChatConversation
											tabId={tab.id}
											isActive={tab.id === activeTabId}
											onFirstMessage={(id, text) => renameTab(id, text)}
											mode={isAlertTab ? "alert" : isWidgetFixTab ? "widget-fix" : undefined}
											alertContext={isAlertTab ? alertContext : undefined}
											widgetFixContext={isWidgetFixTab ? widgetFixContext : undefined}
										/>
									</div>
								)
							})}
						</div>
					</div>
				</div>
			</SidebarInset>
		</SidebarProvider>
	)
}

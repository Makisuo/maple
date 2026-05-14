import { useCallback, useEffect } from "react"
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
	urlTabId?: string
	mode?: "alert" | "widget-fix"
	alertContext?: AlertContext
	widgetFixContext?: WidgetFixContext
}

export function ChatPage({ urlTabId, mode, alertContext, widgetFixContext }: ChatPageProps) {
	const { orgId } = useAuth()
	if (!orgId) return null
	return (
		<ChatPageInner
			orgId={orgId}
			urlTabId={urlTabId}
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
	urlTabId,
	mode,
	alertContext,
	widgetFixContext,
}: ChatPageInnerProps) {
	const { tabs, activeTabId, createTab, closeTab, setActiveTab, renameTab, ensureTab } =
		useChatTabs(orgId, urlTabId)

	// state → URL: reflect the current tab in the URL via history.replaceState so
	// refresh / bookmark works without re-rendering the route tree (using TanStack
	// Router's navigate here caused React DOM cleanup crashes when switching tabs).
	const writeTabToUrl = useCallback((id: string) => {
		if (typeof window === "undefined") return
		const url = new URL(window.location.href)
		if (url.searchParams.get("tab") === id) return
		url.searchParams.set("tab", id)
		window.history.replaceState(window.history.state, "", url.toString())
	}, [])

	useEffect(() => {
		if (!activeTabId) return
		writeTabToUrl(activeTabId)
	}, [activeTabId, writeTabToUrl])

	// URL → state: pick up browser back/forward via popstate. Direct user clicks
	// flow through setActiveTab/writeTabToUrl above; only history navigation needs
	// this pull direction.
	useEffect(() => {
		const onPopState = () => {
			const tab = new URL(window.location.href).searchParams.get("tab")
			if (!tab) return
			setActiveTab(tab)
		}
		window.addEventListener("popstate", onPopState)
		return () => window.removeEventListener("popstate", onPopState)
	}, [setActiveTab])

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

import { Suspense, useCallback, useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@maple/ui/components/ui/sidebar"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@maple/ui/components/ui/sheet"
import { Button } from "@maple/ui/components/ui/button"
import { useIsMobile } from "@maple/ui/hooks/use-media-query"
import { ChevronDownIcon, LinkIcon, PlusIcon } from "@/components/icons"
import { useAppHotkey } from "@/hooks/use-app-hotkey"
import { useChatTabs, type ChatTab } from "@/hooks/use-chat-tabs"
import { ChatSidebar } from "./chat-sidebar"
import { ChatConversation } from "./chat-conversation"
import { FlueClientProvider } from "./flue-client-provider"
import {
	investigationTabId,
	investigationTabTitle,
	type InvestigationContext,
} from "./investigation-context"
import { widgetFixTabId, widgetFixTabTitle, type WidgetFixContext } from "./widget-fix-context"
import { useMapleOrganizationId } from "@/hooks/use-maple-organization"

interface ChatPageProps {
	urlTabId?: string
	mode?: "investigation" | "widget-fix"
	investigationContext?: InvestigationContext
	widgetFixContext?: WidgetFixContext
	/** When set, render a read-only view of a teammate's shared conversation. */
	sharedTabId?: string
	sharedTitle?: string
}

export function ChatPage({
	urlTabId,
	mode,
	investigationContext,
	widgetFixContext,
	sharedTabId,
	sharedTitle,
}: ChatPageProps) {
	const orgId = useMapleOrganizationId();
	if (!orgId) return null;
	return (
		<FlueClientProvider>
			{sharedTabId ? (
				<SharedChatView tabId={sharedTabId} title={sharedTitle} />
			) : (
				<ChatPageInner
					orgId={orgId}
					urlTabId={urlTabId}
					mode={mode}
					investigationContext={investigationContext}
					widgetFixContext={widgetFixContext}
				/>
			)}
		</FlueClientProvider>
	)
}

interface ChatPageInnerProps {
	orgId: string
	urlTabId?: string
	mode?: "investigation" | "widget-fix"
	investigationContext?: InvestigationContext
	widgetFixContext?: WidgetFixContext
}

function ChatPageInner({ orgId, urlTabId, mode, investigationContext, widgetFixContext }: ChatPageInnerProps) {
	const { tabs, activeTabId, createTab, closeTab, setActiveTab, renameTab, ensureTab } = useChatTabs(
		orgId,
		urlTabId,
	)

	const isMobile = useIsMobile()
	const [convListOpen, setConvListOpen] = useState(false)

	const [loadingTabIds, setLoadingTabIds] = useState<ReadonlySet<string>>(() => new Set())
	const handleLoadingChange = useCallback((id: string, loading: boolean) => {
		setLoadingTabIds((prev) => {
			const has = prev.has(id)
			if (has === loading) return prev
			const next = new Set(prev)
			if (loading) next.add(id)
			else next.delete(id)
			return next
		})
	}, [])

	// Build a read-only share link for the conversation and copy it to the clipboard.
	// The link carries only the tab id (the conversation lives in an org-scoped agent),
	// so it resolves for signed-in teammates in the same workspace and no one else.
	const handleShare = useCallback((tab: ChatTab) => {
		if (typeof window === "undefined") return
		const url = new URL("/chat", window.location.origin)
		url.searchParams.set("shared", tab.id)
		const title = tab.title.trim()
		if (title) url.searchParams.set("title", title)
		navigator.clipboard
			.writeText(url.toString())
			.then(() => toast.success("Share link copied to clipboard"))
			.catch(() => toast.error("Failed to copy share link"))
	}, [])

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
		if (mode !== "investigation" || !investigationContext) return
		ensureTab(investigationTabId(investigationContext), investigationTabTitle(investigationContext))
	}, [mode, investigationContext, ensureTab])

	useEffect(() => {
		if (mode !== "widget-fix" || !widgetFixContext) return
		ensureTab(widgetFixTabId(widgetFixContext), widgetFixTabTitle(widgetFixContext))
	}, [mode, widgetFixContext, ensureTab])

	useAppHotkey("chat.newTab", () => createTab())

	const investigationTab =
		mode === "investigation" && investigationContext ? investigationTabId(investigationContext) : undefined
	const widgetFixTab =
		mode === "widget-fix" && widgetFixContext ? widgetFixTabId(widgetFixContext) : undefined

	const activeTitle = tabs.find((t) => t.id === activeTabId)?.title ?? "New chat"

	const conversationArea = (
		<div className="relative min-h-0 flex-1 bg-background">
			{tabs.map((tab) => {
				const isInvestigationTab = tab.id === investigationTab
				const isWidgetFixTab = tab.id === widgetFixTab
				return (
					<div key={tab.id} className={tab.id === activeTabId ? "flex h-full flex-col" : "hidden"}>
						<Suspense fallback={<ChatConversationFallback />}>
							<ChatConversation
								tabId={tab.id}
								isActive={tab.id === activeTabId}
								onFirstMessage={(id, text) => renameTab(id, text)}
								onLoadingChange={handleLoadingChange}
								mode={isInvestigationTab ? "investigation" : isWidgetFixTab ? "widget-fix" : undefined}
								investigationContext={isInvestigationTab ? investigationContext : undefined}
								widgetFixContext={isWidgetFixTab ? widgetFixContext : undefined}
							/>
						</Suspense>
					</div>
				)
			})}
		</div>
	)

	return (
		<SidebarProvider open={false} onOpenChange={() => {}} className="h-svh overflow-hidden">
			<AppSidebar />
			<SidebarInset>
				{isMobile ? (
					<div className="flex h-full min-h-0 flex-1 flex-col">
						<header className="flex h-12 shrink-0 items-center gap-1 border-b bg-sidebar px-2 text-sidebar-foreground">
							<SidebarTrigger className="size-9" />
							<button
								type="button"
								onClick={() => setConvListOpen(true)}
								className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-sidebar-accent/50"
								aria-label="Switch conversation"
							>
								<span className="truncate text-sm font-medium">{activeTitle}</span>
								<ChevronDownIcon size={14} className="shrink-0 opacity-60" />
							</button>
							<Button
								onClick={() => {
									const tab = tabs.find((t) => t.id === activeTabId)
									if (tab) handleShare(tab)
								}}
								variant="ghost"
								size="icon"
								className="size-9"
								aria-label="Copy share link"
							>
								<LinkIcon size={16} />
							</Button>
							<Button
								onClick={createTab}
								variant="ghost"
								size="icon"
								className="size-9"
								aria-label="New chat"
							>
								<PlusIcon size={16} />
							</Button>
						</header>
						{conversationArea}
						<Sheet open={convListOpen} onOpenChange={setConvListOpen}>
							<SheetContent side="left" className="w-[300px] max-w-[85vw] bg-sidebar p-0">
								<SheetHeader className="sr-only">
									<SheetTitle>Conversations</SheetTitle>
									<SheetDescription>Switch between chat conversations.</SheetDescription>
								</SheetHeader>
								<ChatSidebar
									tabs={tabs}
									activeTabId={activeTabId}
									loadingTabIds={loadingTabIds}
									onClose={closeTab}
									onRename={renameTab}
									onShare={handleShare}
									onSelect={(id) => {
										setActiveTab(id)
										setConvListOpen(false)
									}}
									onCreate={() => {
										createTab()
										setConvListOpen(false)
									}}
									className="w-full"
								/>
							</SheetContent>
						</Sheet>
					</div>
				) : (
					<div className="flex h-full min-h-0 flex-1">
						<ChatSidebar
							tabs={tabs}
							activeTabId={activeTabId}
							loadingTabIds={loadingTabIds}
							onSelect={setActiveTab}
							onClose={closeTab}
							onCreate={createTab}
							onRename={renameTab}
							onShare={handleShare}
							className="w-[260px] border-r"
						/>
						<div className="flex min-w-0 flex-1 flex-col">{conversationArea}</div>
					</div>
				)}
			</SidebarInset>
		</SidebarProvider>
	)
}

/**
 * Read-only view of a teammate's shared conversation. Renders the existing
 * <ChatConversation> in `readOnly` mode (no composer) for the shared tab id —
 * the agent is org-scoped, so this only loads for signed-in teammates in the
 * same workspace. The tab is intentionally NOT added to `useChatTabs`, so a
 * shared link never pollutes the viewer's own conversation list.
 */
function SharedChatView({ tabId, title }: { tabId: string; title?: string }) {
	const heading = title?.trim() || "Shared conversation"
	return (
		<SidebarProvider open={false} onOpenChange={() => {}} className="h-svh overflow-hidden">
			<AppSidebar />
			<SidebarInset>
				<div className="flex h-full min-h-0 flex-1 flex-col">
					<header className="flex h-12 shrink-0 items-center gap-2 border-b bg-sidebar px-2 text-sidebar-foreground">
						<SidebarTrigger className="size-9" />
						<LinkIcon size={14} className="shrink-0 opacity-60" />
						<div className="flex min-w-0 flex-1 flex-col justify-center">
							<span className="truncate text-sm font-medium leading-tight" title={heading}>
								{heading}
							</span>
							<span className="text-[10px] font-medium uppercase tracking-wider text-sidebar-foreground/60 leading-tight">
								Read-only · shared
							</span>
						</div>
						<Button
							render={<Link to="/chat" search={{}} />}
							variant="outline"
							size="sm"
							className="shrink-0 gap-1.5"
						>
							<PlusIcon size={14} />
							New chat
						</Button>
					</header>
					<div className="relative min-h-0 flex-1 bg-background">
						<div className="flex h-full flex-col">
							<Suspense fallback={<ChatConversationFallback />}>
								<ChatConversation tabId={tabId} isActive readOnly />
							</Suspense>
						</div>
					</div>
				</div>
			</SidebarInset>
		</SidebarProvider>
	)
}

/**
 * Shown while <ChatConversation> suspends — the agent token query and the
 * initial-messages fetch both call React's `use()`. Without this boundary the
 * suspension bubbles to the route and the page renders blank.
 */
function ChatConversationFallback() {
	return (
		<div className="flex h-full flex-col">
			<div className="mx-auto w-full max-w-3xl flex-1 space-y-3 px-4 py-6" aria-hidden>
				<div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
				<div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
				<div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
			</div>
			<div className="mx-auto w-full max-w-3xl px-4 pb-4" aria-hidden>
				<div className="h-[88px] animate-pulse rounded-lg border bg-muted/40" />
			</div>
		</div>
	)
}

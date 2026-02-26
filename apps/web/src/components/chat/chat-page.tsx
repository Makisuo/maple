import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@maple/ui/components/ui/sidebar"
import { useChatTabs } from "@/hooks/use-chat-tabs"
import { ChatTabBar } from "./chat-tabs"
import { ChatConversation } from "./chat-conversation"

interface ChatPageProps {
  initialTabId?: string
}

export function ChatPage({ initialTabId }: ChatPageProps) {
  const { tabs, activeTabId, createTab, closeTab, setActiveTab, renameTab } =
    useChatTabs(initialTabId)

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
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={
                tab.id === activeTabId
                  ? "flex h-full flex-col"
                  : "hidden"
              }
            >
              <ChatConversation
                tabId={tab.id}
                onFirstMessage={(id, text) => renameTab(id, text)}
              />
            </div>
          ))}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

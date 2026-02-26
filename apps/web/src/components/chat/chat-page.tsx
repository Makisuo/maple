import { DashboardLayout } from "@/components/layout/dashboard-layout"
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
    <DashboardLayout breadcrumbs={[{ label: "Chat" }]}>
      <div className="-mx-4 -mb-4 flex min-h-0 flex-1 flex-col">
        <ChatTabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={setActiveTab}
          onClose={closeTab}
          onCreate={createTab}
        />
        <div className="flex min-h-0 flex-1 flex-col">
          {activeTabId && (
            <ChatConversation
              key={activeTabId}
              tabId={activeTabId}
              onFirstMessage={(id, text) => renameTab(id, text)}
            />
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}

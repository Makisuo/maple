import type { ChatTab } from "@/hooks/use-chat-tabs"
import { cn } from "@maple/ui/lib/utils"
import { PlusIcon, XmarkIcon } from "@/components/icons"

interface ChatTabsProps {
  tabs: ChatTab[]
  activeTabId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onCreate: () => void
}

export function ChatTabBar({ tabs, activeTabId, onSelect, onClose, onCreate }: ChatTabsProps) {
  return (
    <div className="flex items-center border-b bg-muted/30">
      <div className="flex flex-1 items-center gap-0 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          return (
            <button
              key={tab.id}
              type="button"
              className={cn(
                "group relative flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors",
                "hover:bg-muted/50",
                isActive
                  ? "bg-background text-foreground"
                  : "text-muted-foreground",
              )}
              onClick={() => onSelect(tab.id)}
            >
              <span className="max-w-32 truncate">{tab.title}</span>
              {tabs.length > 1 && (
                <span
                  role="button"
                  tabIndex={0}
                  className="ml-1 rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(tab.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation()
                      onClose(tab.id)
                    }
                  }}
                >
                  <XmarkIcon size={12} />
                </span>
              )}
              {isActive && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
              )}
            </button>
          )
        })}
      </div>
      <button
        type="button"
        className="flex shrink-0 items-center gap-1 px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        onClick={onCreate}
      >
        <PlusIcon size={14} />
        <span>New Chat</span>
      </button>
    </div>
  )
}

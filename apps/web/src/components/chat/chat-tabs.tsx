import type { ChatTab } from "@/hooks/use-chat-tabs"
import { cn } from "@maple/ui/lib/utils"
import { PlusIcon, XmarkIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { Separator } from "@maple/ui/components/ui/separator"

interface ChatTabsProps {
  tabs: ChatTab[]
  activeTabId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onCreate: () => void
}

export function ChatTabBar({ tabs, activeTabId, onSelect, onClose, onCreate }: ChatTabsProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center">
      <Separator orientation="vertical" className="mx-2 h-4" />
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          return (
            <button
              key={tab.id}
              type="button"
              className={cn(
                "group flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                "hover:bg-muted/80",
                isActive
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground",
              )}
              onClick={() => onSelect(tab.id)}
            >
              <span className="max-w-32 truncate">{tab.title}</span>
              {tabs.length > 1 && (
                <span
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "ml-0.5 rounded-sm p-0.5 transition-opacity hover:bg-foreground/10",
                    isActive
                      ? "opacity-60 hover:opacity-100"
                      : "opacity-0 group-hover:opacity-60 hover:!opacity-100",
                  )}
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
            </button>
          )
        })}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="ml-1 shrink-0 text-muted-foreground"
        onClick={onCreate}
      >
        <PlusIcon size={14} />
        <span className="sr-only">New Chat</span>
      </Button>
    </div>
  )
}

import type { ReactNode } from "react"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input"
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion"
import type {
  DashboardWidget,
  VisualizationType,
  WidgetDataSource,
  WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"
import { MapleChatMessages, type MapleToolPart } from "@/components/chat/maple-chat-messages"
import { useMapleChat } from "@/components/chat/use-maple-chat"
import { WidgetProposalCard } from "./widget-proposal-card"
import { WidgetRemovalCard } from "./widget-removal-card"
import { normalizeAiWidgetProposal } from "./normalize-widget-proposal"

const DASHBOARD_SUGGESTIONS = [
  "Add an error rate stat widget",
  "Show me a service overview table",
  "Create a latency chart by service",
  "Build a dashboard to monitor my services",
]

interface DashboardAiConversationProps {
  dashboardId: string
  dashboardName: string
  widgets: DashboardWidget[]
  onAddWidget: (
    visualization: VisualizationType,
    dataSource: WidgetDataSource,
    display: WidgetDisplayConfig,
  ) => void
  onRemoveWidget: (widgetId: string) => void
}

const isWidgetProposalInput = (
  value: unknown,
): value is {
  visualization: VisualizationType
  dataSource: WidgetDataSource
  display: WidgetDisplayConfig
} =>
  typeof value === "object" &&
  value !== null &&
  "visualization" in value &&
  "dataSource" in value &&
  "display" in value

const isWidgetRemovalInput = (value: unknown): value is { widgetTitle: string } =>
  typeof value === "object" &&
  value !== null &&
  "widgetTitle" in value &&
  typeof value.widgetTitle === "string"

export function DashboardAiConversation({
  dashboardId,
  dashboardName,
  widgets,
  onAddWidget,
  onRemoveWidget,
}: DashboardAiConversationProps) {
  const { messages, status, error, isLoading, sendText } = useMapleChat({
    id: `dashboard-${dashboardId}`,
    mode: "dashboard_builder",
    dashboardContext: {
      dashboardName,
      existingWidgets: widgets.map((widget) => ({
        title: widget.display.title ?? "Untitled",
        visualization: widget.visualization,
      })),
    },
  })

  const renderToolPart = (part: MapleToolPart, fallback: ReactNode) => {
    if (part.toolName === "add_dashboard_widget" && isWidgetProposalInput(part.input)) {
      const normalized = normalizeAiWidgetProposal(part.input)

      if (normalized.kind === "blocked") {
        return (
          <WidgetProposalCard
            key={part.toolCallId}
            input={normalized.proposal}
            disabledReason={normalized.reason}
          />
        )
      }

      return (
        <WidgetProposalCard
          key={part.toolCallId}
          input={normalized.proposal}
          onAccept={() => {
            onAddWidget(
              normalized.proposal.visualization,
              normalized.proposal.dataSource,
              normalized.proposal.display,
            )
          }}
        />
      )
    }

    if (part.toolName === "remove_dashboard_widget" && isWidgetRemovalInput(part.input)) {
      return (
        <WidgetRemovalCard
          key={part.toolCallId}
          input={{ widgetTitle: part.input.widgetTitle }}
          widgets={widgets}
          onConfirm={onRemoveWidget}
        />
      )
    }

    return fallback
  }

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="mx-4 mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {error.message || "Connection error"}
        </div>
      )}
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full gap-4 px-4 py-4">
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="Dashboard AI"
              description="Tell me what you want to visualize and I'll add widgets to your dashboard."
            >
              <div className="mt-3 flex flex-col items-center gap-2">
                <Suggestions className="mt-1 flex-wrap justify-center">
                  {DASHBOARD_SUGGESTIONS.map((suggestion) => (
                    <Suggestion
                      key={suggestion}
                      suggestion={suggestion}
                      onClick={() => sendText(suggestion)}
                    />
                  ))}
                </Suggestions>
              </div>
            </ConversationEmptyState>
          ) : (
            <MapleChatMessages
              messages={messages}
              isLoading={isLoading}
              renderToolPart={renderToolPart}
            />
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="w-full px-4 pb-4">
        <PromptInput
          onSubmit={({ text }) => sendText(text)}
          className="rounded-lg border shadow-sm"
        >
          <PromptInputTextarea
            placeholder="Describe what you want to visualize..."
            disabled={isLoading}
          />
          <PromptInputFooter>
            <PromptInputSubmit status={status} disabled={isLoading && status !== "streaming"} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}

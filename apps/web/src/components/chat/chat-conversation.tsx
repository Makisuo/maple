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
import { MapleChatMessages } from "./maple-chat-messages"
import { useMapleChat } from "./use-maple-chat"

const PROMPT_SUGGESTIONS = [
  "What's the overall system health?",
  "Show me the slowest traces",
  "Are there any errors right now?",
  "Which services have the highest error rate?",
]

interface ChatConversationProps {
  tabId: string
  onFirstMessage?: (tabId: string, text: string) => void
}

export function ChatConversation({ tabId, onFirstMessage }: ChatConversationProps) {
  const { messages, status, isLoading, sendText } = useMapleChat({
    id: tabId,
    mode: "default",
  })

  const handleSend = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || isLoading) {
      return
    }

    if (messages.length === 0 && onFirstMessage) {
      onFirstMessage(tabId, trimmed.slice(0, 40))
    }

    sendText(trimmed)
  }

  return (
    <div className="flex h-full flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="Maple AI"
              description="Ask me about your traces, logs, errors, and services."
            >
              <div className="mt-4 flex flex-col items-center gap-3">
                <div className="space-y-1 text-center">
                  <h3 className="text-sm font-medium">Maple AI</h3>
                  <p className="text-muted-foreground text-sm">
                    Ask me about your traces, logs, errors, and services.
                  </p>
                </div>
                <Suggestions className="mt-2 justify-center">
                  {PROMPT_SUGGESTIONS.map((suggestion) => (
                    <Suggestion
                      key={suggestion}
                      suggestion={suggestion}
                      onClick={() => handleSend(suggestion)}
                    />
                  ))}
                </Suggestions>
              </div>
            </ConversationEmptyState>
          ) : (
            <MapleChatMessages messages={messages} isLoading={isLoading} />
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        {messages.length > 0 && (
          <Suggestions className="mb-3">
            {PROMPT_SUGGESTIONS.map((suggestion) => (
              <Suggestion
                key={suggestion}
                suggestion={suggestion}
                onClick={() => handleSend(suggestion)}
              />
            ))}
          </Suggestions>
        )}
        <PromptInput
          onSubmit={({ text }) => handleSend(text)}
          className="rounded-lg border shadow-sm"
        >
          <PromptInputTextarea
            placeholder="Ask about your system..."
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

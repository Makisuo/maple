import { useAgent } from "agents/react"
import { useAgentChat } from "@cloudflare/ai-chat/react"
import { useAuth } from "@clerk/clerk-react"
import { chatAgentUrl } from "@/lib/services/common/chat-agent-url"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input"
import { Suggestions, Suggestion } from "@/components/ai-elements/suggestion"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { ThinkingIndicator } from "@/components/ai-elements/thinking-indicator"
import { Tool } from "@/components/ai-elements/tool"
import type { UIMessage } from "ai"

function shouldShowThinkingIndicator(
  message: UIMessage,
  isLoading: boolean,
  isLastMessage: boolean,
): boolean {
  if (!isLoading || !isLastMessage || message.role !== "assistant") return false
  const parts = message.parts
  if (parts.length === 0) return true
  const lastPart = parts[parts.length - 1]
  // If text is actively streaming, user already sees content appearing
  if (
    lastPart.type === "text" &&
    (lastPart as { state?: string }).state === "streaming"
  )
    return false
  return true
}

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
  const { orgId } = useAuth()

  const agent = useAgent({
    agent: "ChatAgent",
    name: tabId,
    host: chatAgentUrl,
  })

  const { messages, sendMessage, status } = useAgentChat({
    agent,
    body: { orgId },
  })

  const isLoading = status === "streaming" || status === "submitted"

  const handleSend = (text: string) => {
    if (!text.trim() || isLoading) return
    if (messages.length === 0 && onFirstMessage) {
      onFirstMessage(tabId, text.trim().slice(0, 40))
    }
    sendMessage({ text: text.trim() })
  }

  return (
    <div className="flex h-full flex-col">
      <Conversation className="flex-1 min-h-0">
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
                  {PROMPT_SUGGESTIONS.map((s) => (
                    <Suggestion
                      key={s}
                      suggestion={s}
                      onClick={() => handleSend(s)}
                    />
                  ))}
                </Suggestions>
              </div>
            </ConversationEmptyState>
          ) : (
            <>
              {messages.map((message) => (
                <Message key={message.id} from={message.role}>
                  <MessageContent>
                    {message.parts.map((part, i) => {
                      if (part.type === "text") {
                        return <MessageResponse key={i}>{part.text}</MessageResponse>
                      }
                      if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
                        const toolPart = part as {
                          type: string
                          toolCallId: string
                          toolName?: string
                          state: string
                          input?: unknown
                          output?: unknown
                          errorText?: string
                        }
                        const toolName = part.type.startsWith("tool-")
                          ? part.type.replace(/^tool-/, "")
                          : (toolPart.toolName ?? "unknown")
                        return (
                          <Tool
                            key={toolPart.toolCallId ?? i}
                            toolName={toolName}
                            toolCallId={toolPart.toolCallId}
                            state={toolPart.state}
                            input={toolPart.input}
                            output={toolPart.output}
                            errorText={toolPart.errorText}
                          />
                        )
                      }
                      return null
                    })}
                  </MessageContent>
                </Message>
              ))}
              {isLoading && messages[messages.length - 1]?.role === "user" && (
                <Message from="assistant">
                  <MessageContent>
                    <Shimmer>Thinking...</Shimmer>
                  </MessageContent>
                </Message>
              )}
            </>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        {messages.length > 0 && (
          <Suggestions className="mb-3">
            {PROMPT_SUGGESTIONS.map((s) => (
              <Suggestion
                key={s}
                suggestion={s}
                onClick={() => handleSend(s)}
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

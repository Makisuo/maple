import type { ReactNode } from "react"
import type { UIMessage } from "ai"
import {
  Message,
  MessageContent,
} from "@/components/ai-elements/message"
import { RichText } from "@/components/ai-elements/rich-text"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { ThinkingIndicator } from "@/components/ai-elements/thinking-indicator"
import { Tool } from "@/components/ai-elements/tool"

export interface MapleToolPart {
  type: string
  toolCallId: string
  toolName: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isTextPart = (
  part: UIMessage["parts"][number],
): part is Extract<UIMessage["parts"][number], { type: "text"; text: string }> =>
  isRecord(part) && part.type === "text" && typeof part.text === "string"

const isMapleToolPart = (
  part: UIMessage["parts"][number],
): part is UIMessage["parts"][number] & MapleToolPart => {
  if (!isRecord(part)) {
    return false
  }

  const candidate = part as Record<string, unknown>

  return typeof candidate.type === "string" &&
    typeof candidate.toolCallId === "string" &&
    typeof candidate.state === "string" &&
    (candidate.toolName === undefined || typeof candidate.toolName === "string")
}

function shouldShowThinkingIndicator(
  message: UIMessage,
  isLoading: boolean,
  isLastMessage: boolean,
): boolean {
  if (!isLoading || !isLastMessage || message.role !== "assistant") return false
  const parts = message.parts
  if (parts.length === 0) return true
  const lastPart = parts[parts.length - 1]
  return !(isTextPart(lastPart) && isRecord(lastPart) && lastPart.state === "streaming")
}

interface MapleChatMessagesProps {
  messages: UIMessage[]
  isLoading: boolean
  renderToolPart?: (part: MapleToolPart, fallback: ReactNode) => ReactNode
}

export function MapleChatMessages({
  messages,
  isLoading,
  renderToolPart,
}: MapleChatMessagesProps) {
  return (
    <>
      {messages.map((message, messageIndex) => {
        const isLastMessage = messageIndex === messages.length - 1
        return (
          <Message key={message.id} from={message.role}>
            <MessageContent>
              {message.parts.map((part, index) => {
                if (isTextPart(part)) {
                  return <RichText key={index}>{part.text}</RichText>
                }

                if (isMapleToolPart(part)) {
                  const toolPart: MapleToolPart = {
                    type: part.type,
                    toolCallId: part.toolCallId,
                    toolName: part.toolName ?? "unknown",
                    state: part.state,
                    input: part.input,
                    output: part.output,
                    errorText: part.errorText,
                  }
                  const fallback = (
                    <Tool
                      key={toolPart.toolCallId}
                      toolName={toolPart.toolName}
                      toolCallId={toolPart.toolCallId}
                      state={toolPart.state}
                      input={toolPart.input}
                      output={toolPart.output}
                      errorText={toolPart.errorText}
                    />
                  )
                  return renderToolPart ? renderToolPart(toolPart, fallback) : fallback
                }

                return null
              })}
              {shouldShowThinkingIndicator(message, isLoading, isLastMessage) && (
                <ThinkingIndicator />
              )}
            </MessageContent>
          </Message>
        )
      })}
      {isLoading && messages[messages.length - 1]?.role === "user" && (
        <Message from="assistant">
          <MessageContent>
            <Shimmer>Thinking...</Shimmer>
          </MessageContent>
        </Message>
      )}
    </>
  )
}

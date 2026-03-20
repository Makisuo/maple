import { Chat, useChat } from "@ai-sdk/react"
import type { UIMessage } from "ai"
import { DefaultChatTransport } from "ai"
import { useAuth } from "@clerk/clerk-react"
import type { ChatDashboardContext, ChatMode } from "@maple/domain"
import { useRef } from "react"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"

interface UseMapleChatOptions {
  id: string
  mode: ChatMode
  dashboardContext?: ChatDashboardContext
}

export function useMapleChat({ id, mode, dashboardContext }: UseMapleChatOptions) {
  const { orgId, getToken } = useAuth()
  const orgIdRef = useRef(orgId)
  const getTokenRef = useRef(getToken)
  const modeRef = useRef(mode)
  const dashboardContextRef = useRef(dashboardContext)
  const chatRef = useRef<Chat<UIMessage> | null>(null)

  orgIdRef.current = orgId
  getTokenRef.current = getToken
  modeRef.current = mode
  dashboardContextRef.current = dashboardContext

  if (chatRef.current === null || chatRef.current.id !== id) {
    chatRef.current = new Chat({
      id,
      transport: new DefaultChatTransport({
        api: `${apiBaseUrl}/api/chat`,
        prepareSendMessagesRequest: async ({
          id: chatId,
          messages,
          trigger,
          messageId,
          body,
          headers,
        }) => {
          const token = await getTokenRef.current()
          return {
            headers: {
              ...headers,
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(orgIdRef.current ? { "X-Org-Id": orgIdRef.current } : {}),
            },
            body: {
              id: chatId,
              messages,
              trigger,
              messageId,
              ...body,
              mode: modeRef.current,
              ...(dashboardContextRef.current
                ? { dashboardContext: dashboardContextRef.current }
                : {}),
            },
          }
        },
      }),
    })
  }

  const chat = useChat({
    chat: chatRef.current,
  })

  const isLoading = chat.status === "streaming" || chat.status === "submitted"

  const sendText = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || isLoading) {
      return
    }

    chat.sendMessage({ text: trimmed })
  }

  return {
    ...chat,
    isLoading,
    sendText,
  }
}

import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { useAuth } from "@clerk/clerk-react"
import type { ChatDashboardContext, ChatMode } from "@maple/domain"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"

interface UseMapleChatOptions {
  id: string
  mode: ChatMode
  dashboardContext?: ChatDashboardContext
}

export function useMapleChat({ id, mode, dashboardContext }: UseMapleChatOptions) {
  const { orgId, getToken } = useAuth()

  const chat = useChat({
    id,
    transport: new DefaultChatTransport({
      api: `${apiBaseUrl}/api/chat`,
      headers: async () => {
        const token = await getToken()
        return {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(orgId ? { "X-Org-Id": orgId } : {}),
        }
      },
      body: {
        mode,
        ...(dashboardContext ? { dashboardContext } : {}),
      },
    }),
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

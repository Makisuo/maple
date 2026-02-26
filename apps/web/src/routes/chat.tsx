import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { ChatPage } from "@/components/chat/chat-page"

const ChatSearch = Schema.Struct({
  tab: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/chat")({
  component: ChatRoute,
  validateSearch: Schema.standardSchemaV1(ChatSearch),
})

function ChatRoute() {
  const { tab } = Route.useSearch()
  return <ChatPage initialTabId={tab} />
}

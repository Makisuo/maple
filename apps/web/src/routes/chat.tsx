import { createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { ChatPage } from "@/components/chat/chat-page"

const ChatSearch = Schema.Struct({
	tab: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/chat"))({
	component: ChatRoute,
	validateSearch: Schema.toStandardSchemaV1(ChatSearch),
})

function ChatRoute() {
	const { tab } = Route.useSearch()
	return <ChatPage initialTabId={tab} />
}

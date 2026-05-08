import { createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { ChatPage } from "@/components/chat/chat-page"
import { decodeAlertContextFromSearchParam, type AlertContext } from "@/components/chat/alert-context"
import {
	decodeWidgetFixContextFromSearchParam,
	type WidgetFixContext,
} from "@/components/chat/widget-fix-context"

const ChatSearch = Schema.Struct({
	tab: Schema.optional(Schema.String),
	mode: Schema.optional(Schema.Literals(["alert", "widget-fix"])),
	alert: Schema.optional(Schema.String),
	widget: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/chat"))({
	component: ChatRoute,
	validateSearch: Schema.toStandardSchemaV1(ChatSearch),
})

function ChatRoute() {
	const { tab, mode, alert, widget } = Route.useSearch()
	const alertContext: AlertContext | undefined =
		mode === "alert" && alert ? decodeAlertContextFromSearchParam(alert) : undefined
	const widgetFixContext: WidgetFixContext | undefined =
		mode === "widget-fix" && widget ? decodeWidgetFixContextFromSearchParam(widget) : undefined
	return (
		<ChatPage
			initialTabId={tab}
			mode={mode}
			alertContext={alertContext}
			widgetFixContext={widgetFixContext}
		/>
	)
}

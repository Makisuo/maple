import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { ChatPage } from "@/components/chat/chat-page"
import { decodeAlertContextFromSearchParam } from "@/components/chat/alert-context"
import {
	alertContextToInvestigation,
	type InvestigationContext,
} from "@/components/chat/investigation-context"
import {
	decodeWidgetFixContextFromSearchParam,
	type WidgetFixContext,
} from "@/components/chat/widget-fix-context"

const ChatSearch = Schema.Struct({
	tab: Schema.optional(Schema.String),
	// `alert` is retained for back-compat with notification deep links; it is
	// mapped onto the unified investigation context below.
	mode: Schema.optional(Schema.Literals(["alert", "widget-fix"])),
	alert: Schema.optional(Schema.String),
	widget: Schema.optional(Schema.String),
	/** Read-only shared view: the tab id of a teammate's conversation to display. */
	shared: Schema.optional(Schema.String),
	/** Title to show for a shared conversation (the viewer doesn't have it locally). */
	title: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/chat")({
	component: ChatRoute,
	validateSearch: Schema.toStandardSchemaV1(ChatSearch),
})

function ChatRoute() {
	const { tab, mode, alert, widget, shared, title } = Route.useSearch()
	const investigationContext: InvestigationContext | undefined = (() => {
		if (mode !== "alert" || !alert) return undefined
		const decoded = decodeAlertContextFromSearchParam(alert)
		return decoded ? alertContextToInvestigation(decoded) : undefined
	})()
	const widgetFixContext: WidgetFixContext | undefined =
		mode === "widget-fix" && widget ? decodeWidgetFixContextFromSearchParam(widget) : undefined
	return (
		<ChatPage
			urlTabId={tab}
			mode={widgetFixContext ? "widget-fix" : investigationContext ? "investigation" : undefined}
			investigationContext={investigationContext}
			widgetFixContext={widgetFixContext}
			sharedTabId={shared}
			sharedTitle={title}
		/>
	)
}

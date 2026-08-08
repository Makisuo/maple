import { lazy, Suspense, useState } from "react"
import { Link } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "@maple/ui/components/ui/sheet"
import { ExternalLinkIcon, PlusIcon } from "@/components/icons"
import { ensureStoredTab, useChatTabs } from "@/hooks/use-chat-tabs"
import { QUICK_CHAT_TAB_ID } from "./global-chat-constants"

const GlobalChatContent = lazy(() =>
	import("./global-chat-content").then((module) => ({ default: module.GlobalChatContent })),
)

function ChatConversationFallback() {
	return (
		<div className="flex flex-1 flex-col gap-3 p-4" aria-label="Loading chat conversation">
			<div className="h-16 w-3/4 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
			<div className="h-20 w-4/5 animate-pulse self-end rounded-md bg-muted motion-reduce:animate-none" />
			<div className="mt-auto h-20 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
		</div>
	)
}

export function GlobalChatPanel({
	orgId,
	onOpenChange,
}: {
	orgId: string
	onOpenChange: (open: boolean) => void
}) {
	const { createTab, renameTab } = useChatTabs(orgId)
	const [tabId, setTabId] = useState(QUICK_CHAT_TAB_ID)

	const handleCreate = () => {
		setTabId(createTab())
	}

	return (
		<Sheet open onOpenChange={onOpenChange}>
			<SheetPopup
				side="right"
				className="w-[calc(100%-(--spacing(12)))] sm:max-w-2xl"
				closeProps={{ className: "absolute end-3 top-5 z-10" }}
			>
				<SheetHeader className="gap-3 border-b pb-4">
					<div className="min-w-0 space-y-1 pe-8">
						<SheetTitle className="truncate text-base">Maple AI</SheetTitle>
						<SheetDescription>
							Ask about your services, traces, errors, and alerts.
						</SheetDescription>
					</div>
					<div className="flex flex-wrap items-center gap-1">
						<Button size="sm" variant="ghost" onClick={handleCreate}>
							<PlusIcon className="size-3.5" />
							New chat
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => {
								ensureStoredTab(
									orgId,
									tabId,
									tabId === QUICK_CHAT_TAB_ID ? "Quick chat" : "New Chat",
								)
								onOpenChange(false)
							}}
							render={<Link to="/chat" search={{ tab: tabId }} />}
						>
							Open full page
							<ExternalLinkIcon className="size-3.5" />
						</Button>
					</div>
				</SheetHeader>
				<div className="flex min-h-0 flex-1 flex-col">
					<Suspense fallback={<ChatConversationFallback />}>
						<GlobalChatContent key={tabId} tabId={tabId} onFirstMessage={renameTab} />
					</Suspense>
				</div>
			</SheetPopup>
		</Sheet>
	)
}

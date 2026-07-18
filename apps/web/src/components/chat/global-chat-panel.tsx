import { lazy, Suspense } from "react"
import { Link } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "@maple/ui/components/ui/sheet"
import { ExternalLinkIcon } from "@/components/icons"
import { ensureStoredTab } from "@/hooks/use-chat-tabs"
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
	return (
		<Sheet open onOpenChange={onOpenChange}>
			<SheetPopup
				side="right"
				className="w-[calc(100%-(--spacing(12)))] sm:max-w-2xl"
				closeProps={{ className: "absolute end-3 top-5 z-10" }}
			>
				<SheetHeader className="flex flex-row items-start justify-between gap-3 border-b pe-14 pb-4">
					<div className="min-w-0 space-y-1">
						<SheetTitle className="truncate text-base">Maple AI</SheetTitle>
						<SheetDescription>
							Ask about your services, traces, errors, and alerts.
						</SheetDescription>
					</div>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							ensureStoredTab(orgId, QUICK_CHAT_TAB_ID, "Quick chat")
							onOpenChange(false)
						}}
						render={<Link to="/chat" search={{ tab: QUICK_CHAT_TAB_ID }} />}
					>
						Open full page
						<ExternalLinkIcon className="size-3.5" />
					</Button>
				</SheetHeader>
				<div className="flex min-h-0 flex-1 flex-col">
					<Suspense fallback={<ChatConversationFallback />}>
						<GlobalChatContent tabId={QUICK_CHAT_TAB_ID} />
					</Suspense>
				</div>
			</SheetPopup>
		</Sheet>
	)
}

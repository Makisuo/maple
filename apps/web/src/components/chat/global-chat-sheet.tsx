import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import {
	Sheet,
	SheetDescription,
	SheetHeader,
	SheetPopup,
	SheetTitle,
} from "@maple/ui/components/ui/sheet"
import { ExternalLinkIcon } from "@/components/icons"

import { ChatConversation } from "@/components/chat/chat-conversation"
import { FlueClientProvider } from "@/components/chat/flue-client-provider"
import { ensureStoredTab } from "@/hooks/use-chat-tabs"
import { useAppHotkey } from "@/hooks/use-app-hotkey"
import { useMapleOrganizationId } from "@/hooks/use-maple-organization"

const OPEN_CHAT_EVENT = "maple:open-chat-sheet"

/** Stable conversation id for the quick chat — one org-scoped thread. */
export const QUICK_CHAT_TAB_ID = "quick"
const QUICK_CHAT_TAB_TITLE = "Quick chat"

/** Open the global chat slide-over from anywhere (header button, ⌘K action). */
export function openGlobalChat() {
	document.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT))
}

/**
 * App-wide chat surface, mounted once in the root AppFrame: a right slide-over
 * hosting the Maple AI conversation on a persistent org-scoped "quick" thread.
 * Replaces the old sidebar nav entry — the full /chat page remains for deep
 * links (alert triage, widget fix, shared views) and multi-tab work.
 *
 * The popup content (and with it the Flue connection) only mounts while open;
 * history restores from the durable stream on reopen, same as AlertChatSheet.
 */
export function GlobalChatSheet() {
	const [open, setOpen] = useState(false)
	const orgId = useMapleOrganizationId()

	useAppHotkey("chat.quickOpen", () => setOpen(true))

	useEffect(() => {
		const onOpen = () => setOpen(true)
		document.addEventListener(OPEN_CHAT_EVENT, onOpen)
		return () => document.removeEventListener(OPEN_CHAT_EVENT, onOpen)
	}, [])

	if (!orgId) return null

	return (
		<Sheet open={open} onOpenChange={setOpen}>
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
							ensureStoredTab(orgId, QUICK_CHAT_TAB_ID, QUICK_CHAT_TAB_TITLE)
							setOpen(false)
						}}
						render={<Link to="/chat" search={{ tab: QUICK_CHAT_TAB_ID }} />}
					>
						Open full page
						<ExternalLinkIcon className="size-3.5" />
					</Button>
				</SheetHeader>
				<div className="flex min-h-0 flex-1 flex-col">
					<FlueClientProvider>
						<ChatConversation tabId={QUICK_CHAT_TAB_ID} isActive={open} />
					</FlueClientProvider>
				</div>
			</SheetPopup>
		</Sheet>
	)
}

import { lazy, Suspense, useState } from "react"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { useMapleOrganizationId } from "@/hooks/use-maple-organization"
import { isDialogOpen, isEditableTarget } from "@/lib/keyboard"

const OPEN_CHAT_EVENT = "maple:open-chat-sheet"

const GlobalChatPanel = lazy(() =>
	import("./global-chat-panel").then((module) => ({ default: module.GlobalChatPanel })),
)

function ChatContentFallback() {
	return (
		<div className="flex flex-1 flex-col gap-3 p-4" aria-label="Loading chat">
			<div className="h-16 w-3/4 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
			<div className="h-20 w-4/5 animate-pulse self-end rounded-md bg-muted motion-reduce:animate-none" />
			<div className="mt-auto h-20 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
		</div>
	)
}

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

	useMountEffect(() => {
		const onOpen = () => setOpen(true)
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== "c" || event.metaKey || event.ctrlKey || event.altKey) return
			if (isEditableTarget(event.target) || isDialogOpen()) return
			event.preventDefault()
			setOpen(true)
		}
		document.addEventListener(OPEN_CHAT_EVENT, onOpen)
		document.addEventListener("keydown", onKeyDown)
		return () => {
			document.removeEventListener(OPEN_CHAT_EVENT, onOpen)
			document.removeEventListener("keydown", onKeyDown)
		}
	})

	if (!orgId) return null

	if (!open) return null

	return (
		<Suspense fallback={<ChatContentFallback />}>
			<GlobalChatPanel orgId={orgId} onOpenChange={setOpen} />
		</Suspense>
	)
}

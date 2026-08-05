import { ArrowUpIcon, ChatBubbleSparkleIcon } from "@/components/icons"

/**
 * The docked follow-up. The page pins it: it renders as a `shrink-0` sibling
 * below the scroll area, so it stays put while the tab scrolls behind it.
 *
 * It looks like a composer but it is a button, and that is deliberate. The real
 * composer belongs to `ChatConversation`, which owns the session, the approval
 * flow and the failed-send queue; a second text field here would either need a
 * duplicate of all that or would swallow what the user typed on the way to the
 * Chat tab. Handing off before anything is typed loses nothing.
 */
export function FollowUpComposer({ onSubmit }: { onSubmit: () => void }) {
	return (
		<button
			type="button"
			onClick={onSubmit}
			className="flex h-10.5 w-full items-center gap-3 rounded-lg border border-input bg-card px-3.5 text-left transition-colors hover:border-ring hover:bg-accent/40"
		>
			<ChatBubbleSparkleIcon size={14} className="shrink-0 text-primary" />
			<span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
				Ask a follow-up — challenge the cause, widen the window, check another service…
			</span>
			<span
				aria-hidden
				className="flex size-6.5 shrink-0 items-center justify-center rounded-md bg-muted"
			>
				<ArrowUpIcon size={12} className="text-muted-foreground" />
			</span>
		</button>
	)
}

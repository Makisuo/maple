import { CopyButton } from "@maple/ui/components/ui/copy-button"
import type { UIMessage } from "@/components/ai-elements/types"
import { LinkIcon } from "@/components/icons"

/** The visible text of a message, with tool calls and markers left out. */
export function messageText(message: UIMessage): string {
	return message.parts
		.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n\n")
		.trim()
}

interface MessageActionsProps {
	message: UIMessage
	/** Absolute permalink to this message, or `undefined` where the thread isn't shareable. */
	permalink?: string
}

/**
 * Assistant-message actions, revealed on hover of the enclosing `Message` row.
 * Deliberately limited to what `useMapleChat` exposes: just `sendMessage`, so
 * there is no retry or stop to offer here, and no message carries a timestamp
 * to show.
 */
export function MessageActions({ message, permalink }: MessageActionsProps) {
	const text = messageText(message)
	if (!text && !permalink) return null

	return (
		<div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
			{text ? <CopyButton value={text} label="Message" size="icon-sm" toast={false} /> : null}
			{permalink ? (
				<CopyButton
					value={permalink}
					label="Link to message"
					idleIcon={LinkIcon}
					size="icon-sm"
					toast={false}
				/>
			) : null}
		</div>
	)
}

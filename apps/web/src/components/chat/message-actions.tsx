import { Button } from "@maple/ui/components/ui/button"
import { CheckIcon, CopyIcon, LinkIcon } from "@/components/icons"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import type { UIMessage } from "@/components/ai-elements/types"

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
 * Deliberately limited to what the transport can honour: `@flue/react` exposes
 * only `sendMessage`, so there is no retry or stop to offer here, and no message
 * carries a timestamp to show.
 */
export function MessageActions({ message, permalink }: MessageActionsProps) {
	// One hook per affordance so each button owns its own check-icon hold. Silent:
	// the icon swap is the feedback, and a toast per copy would be noise in a chat.
	const textCopy = useCopyToClipboard("Message", { silent: true })
	const linkCopy = useCopyToClipboard("Link", { silent: true })
	const text = messageText(message)
	if (!text && !permalink) return null

	return (
		<div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
			{text ? (
				<Button
					size="icon-sm"
					variant="ghost"
					className="text-muted-foreground"
					aria-label="Copy message"
					onClick={() => textCopy.copy(text)}
				>
					{textCopy.copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
				</Button>
			) : null}
			{permalink ? (
				<Button
					size="icon-sm"
					variant="ghost"
					className="text-muted-foreground"
					aria-label="Copy link to message"
					onClick={() => linkCopy.copy(permalink)}
				>
					{linkCopy.copied ? <CheckIcon className="size-3.5" /> : <LinkIcon className="size-3.5" />}
				</Button>
			) : null}
		</div>
	)
}

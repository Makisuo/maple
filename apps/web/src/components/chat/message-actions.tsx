import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@maple/ui/components/ui/button"
import { CheckIcon, CopyIcon, LinkIcon } from "@/components/icons"
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
	const [copied, setCopied] = useState<"text" | "link" | null>(null)
	const text = messageText(message)
	if (!text && !permalink) return null

	const copy = async (value: string, kind: "text" | "link", success: string) => {
		try {
			await navigator.clipboard.writeText(value)
			setCopied(kind)
			window.setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1500)
		} catch {
			toast.error(success.replace("Copied", "Couldn't copy"))
		}
	}

	return (
		<div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
			{text ? (
				<Button
					size="icon-sm"
					variant="ghost"
					className="text-muted-foreground"
					aria-label="Copy message"
					onClick={() => copy(text, "text", "Copied message")}
				>
					{copied === "text" ? (
						<CheckIcon className="size-3.5" />
					) : (
						<CopyIcon className="size-3.5" />
					)}
				</Button>
			) : null}
			{permalink ? (
				<Button
					size="icon-sm"
					variant="ghost"
					className="text-muted-foreground"
					aria-label="Copy link to message"
					onClick={() => copy(permalink, "link", "Copied link")}
				>
					{copied === "link" ? (
						<CheckIcon className="size-3.5" />
					) : (
						<LinkIcon className="size-3.5" />
					)}
				</Button>
			) : null}
		</div>
	)
}

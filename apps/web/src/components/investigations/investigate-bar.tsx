import { useState } from "react"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"

import { ChatBubbleSparkleIcon } from "@/components/icons"

/**
 * One field, one verb. Shared by the hub's toolbar and its first-run hero — the
 * `accent` variant just turns the ring on, because on the hero this is the only
 * thing to do on the page and it should say so.
 */
export function InvestigateBar({
	onSubmit,
	busy,
	accent = false,
	placeholder = "Ask Maple to investigate — a service, a symptom, a question",
}: {
	onSubmit: (title: string) => void | Promise<void>
	busy: boolean
	accent?: boolean
	placeholder?: string
}) {
	const [subject, setSubject] = useState("")
	const trimmed = subject.trim()

	return (
		<form
			className={cn(
				"flex h-10 items-center gap-3 rounded-lg border bg-card px-3.5 transition-colors focus-within:border-ring",
				accent ? "border-primary/60" : "border-input",
			)}
			onSubmit={(event) => {
				event.preventDefault()
				if (!trimmed || busy) return
				setSubject("")
				void onSubmit(trimmed)
			}}
		>
			<ChatBubbleSparkleIcon size={14} className="shrink-0 text-primary" />
			<input
				value={subject}
				onChange={(event) => setSubject(event.target.value)}
				placeholder={placeholder}
				aria-label="What should Maple investigate?"
				className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
			/>
			<Button
				type="submit"
				size="sm"
				variant={accent ? "default" : "secondary"}
				className="h-6.5 shrink-0 px-3 text-xs"
				disabled={busy || !trimmed}
			>
				{busy ? "Starting…" : "Investigate"}
			</Button>
		</form>
	)
}

import type { ActorDocument } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Kbd, KbdGroup } from "@maple/ui/components/ui/kbd"
import { Textarea } from "@maple/ui/components/ui/textarea"
import { cn } from "@maple/ui/lib/utils"
import * as React from "react"

import { useActorDirectory } from "@/hooks/use-actor-directory"
import { IdentityAvatar, resolveActorIdentity, type ActorIdentity } from "./actor-chip"

interface IssueCommentComposerProps {
	value: string
	onChange: (value: string) => void
	onSubmit: () => void
	disabled?: boolean
	/**
	 * Everyone who has touched this issue. Rendered as a participant strip so the
	 * humans can see which agents are in the thread with them — agents write here
	 * through the MCP `comment_on_error_issue` tool, and a comment from one
	 * arriving with no prior sign of it being present reads as a glitch.
	 */
	participants?: ReadonlyArray<ActorDocument>
	className?: string
}

export function IssueCommentComposer({
	value,
	onChange,
	onSubmit,
	disabled,
	participants = [],
	className,
}: IssueCommentComposerProps) {
	const directory = useActorDirectory()
	const canSubmit = !disabled && value.trim().length > 0

	const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault()
			if (canSubmit) onSubmit()
		}
	}

	const me = directory.me
	const meIdentity: ActorIdentity | null = me
		? {
				kind: "user",
				internal: false,
				name: me.name,
				detail: me.email,
				imageUrl: me.imageUrl,
				initials: me.name.slice(0, 2).toUpperCase(),
				seed: me.userId,
			}
		: null

	return (
		<div className={cn("space-y-2", className)}>
			<ParticipantStrip directory={directory} participants={participants} />
			<div
				className={cn(
					"flex gap-3 rounded-xl border bg-card p-3 transition-colors",
					"focus-within:border-ring/60 focus-within:ring-[3px] focus-within:ring-ring/20",
					disabled && "opacity-60",
				)}
			>
				{meIdentity ? <IdentityAvatar className="mt-0.5" identity={meIdentity} size="md" /> : null}
				<div className="min-w-0 flex-1 space-y-2">
					{/* The card around this already draws the border, background and
					    focus ring, so the control comes in `unstyled` and only brings
					    its own sizing. `field-sizing-content` (from the shared control)
					    grows the box with the draft and shrinks it back on delete with
					    no JS measurement. */}
					<Textarea
						controlClassName="max-h-80 min-h-11 resize-none px-0 py-0 text-sm leading-relaxed placeholder:text-muted-foreground"
						disabled={disabled}
						id="comment-input"
						onChange={(e) => onChange(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Context, findings, links… markdown supported"
						unstyled
						value={value}
					/>
					<div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
						<KbdGroup>
							<Kbd>⌘</Kbd>
							<Kbd>↵</Kbd>
							<span className="ml-1">to comment</span>
						</KbdGroup>
						<Button disabled={!canSubmit} onClick={onSubmit} size="sm">
							{disabled ? "Posting…" : "Comment"}
						</Button>
					</div>
				</div>
			</div>
		</div>
	)
}

/** Overlapping avatars of everyone in the thread, humans and agents alike. */
function ParticipantStrip({
	participants,
	directory,
}: {
	participants: ReadonlyArray<ActorDocument>
	directory: ReturnType<typeof useActorDirectory>
}) {
	const identities = React.useMemo(() => {
		const seen = new Set<string>()
		const out: Array<ActorIdentity> = []
		for (const actor of participants) {
			if (seen.has(actor.id)) continue
			seen.add(actor.id)
			out.push(resolveActorIdentity(actor, directory))
		}
		return out
	}, [participants, directory])

	if (identities.length === 0) return null

	const shown = identities.slice(0, 5)
	const overflow = identities.length - shown.length
	const agentCount = identities.filter((identity) => identity.kind === "agent").length

	return (
		<div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
			<span className="flex -space-x-1.5">
				{shown.map((identity) => (
					<IdentityAvatar
						className="ring-2 ring-background"
						identity={identity}
						key={identity.seed}
					/>
				))}
			</span>
			{overflow > 0 ? <span className="tabular-nums">+{overflow}</span> : null}
			<span>
				{identities.length} participant{identities.length === 1 ? "" : "s"}
				{agentCount > 0 ? ` · ${agentCount} agent${agentCount === 1 ? "" : "s"}` : ""}
			</span>
		</div>
	)
}

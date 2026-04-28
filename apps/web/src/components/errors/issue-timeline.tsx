import type { ErrorIssueEventDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { ActorChip } from "./actor-chip"
import { formatRelativeTime } from "@/lib/format"

const EVENT_LABEL: Record<ErrorIssueEventDocument["type"], string> = {
	created: "Created",
	state_change: "State change",
	assignment: "Assignment",
	claim: "Claimed",
	release: "Released",
	lease_expired: "Lease expired",
	comment: "Comment",
	agent_note: "Agent note",
	fix_proposed: "Fix proposed",
	regression: "Regression",
	snooze: "Snoozed",
	unsnooze: "Unsnoozed",
}

const DOT_CLASS: Record<ErrorIssueEventDocument["type"], string> = {
	created: "bg-primary",
	state_change: "bg-blue-500",
	assignment: "bg-muted-foreground",
	claim: "bg-violet-500",
	release: "bg-violet-500/60",
	lease_expired: "bg-amber-500",
	comment: "bg-muted-foreground",
	agent_note: "bg-violet-500 shadow-[0_0_0_3px_oklch(0.65_0.16_290/0.25)]",
	fix_proposed: "bg-success",
	regression: "bg-destructive",
	snooze: "bg-muted-foreground/70",
	unsnooze: "bg-muted-foreground/70",
}

function payloadString(value: unknown): string | null {
	if (value == null) return null
	if (typeof value === "string") return value
	if (typeof value === "number" || typeof value === "boolean") return String(value)
	try {
		return JSON.stringify(value)
	} catch {
		return null
	}
}

function renderPayload(event: ErrorIssueEventDocument): string | null {
	const p = event.payload
	switch (event.type) {
		case "comment":
		case "agent_note": {
			return payloadString(p.body)
		}
		case "fix_proposed": {
			const summary = payloadString(p.patchSummary) ?? ""
			const url = payloadString(p.prUrl)
			return url ? `${summary} — ${url}` : summary
		}
		case "claim": {
			const expires = payloadString(p.leaseExpiresAt)
			return expires ? `lease expires at ${new Date(Number(expires)).toISOString()}` : null
		}
		case "state_change": {
			return payloadString(p.note)
		}
		default:
			return null
	}
}

export function IssueTimeline({ events }: { events: ReadonlyArray<ErrorIssueEventDocument> }) {
	if (events.length === 0) {
		return <div className="py-6 text-center text-sm text-muted-foreground">No events recorded yet.</div>
	}

	return (
		<ol className="relative ml-16 border-l border-border/60">
			{events.map((event) => {
				const body = renderPayload(event)
				return (
					<li key={event.id} className="relative py-3 pl-4">
						<span className="absolute -left-16 top-4 w-12 text-right text-[11px] tabular-nums text-muted-foreground">
							{formatRelativeTime(event.createdAt)}
						</span>
						<span
							aria-hidden
							className={cn(
								"absolute -left-[5px] top-4 block size-2.5 rounded-full ring-2 ring-background",
								DOT_CLASS[event.type],
								event.type === "regression" && "animate-pulse",
							)}
						/>
						<div className="flex flex-wrap items-center gap-2 text-sm">
							<span className="font-medium text-foreground">{EVENT_LABEL[event.type]}</span>
							{event.fromState && event.toState ? (
								<span className="font-mono text-[11px] text-muted-foreground">
									{event.fromState} → {event.toState}
								</span>
							) : null}
							<ActorChip actor={event.actor} />
						</div>
						{body ? (
							<div className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
								{body}
							</div>
						) : null}
					</li>
				)
			})}
		</ol>
	)
}

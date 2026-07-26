import type { ErrorIssueEventDocument, IssueEscalationAttemptDocument } from "@maple/domain/http"
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
	ai_triage: "AI triage",
	anomaly_linked: "Anomaly",
	severity_change: "Severity",
}

const DOT_CLASS: Record<ErrorIssueEventDocument["type"], string> = {
	created: "bg-primary",
	state_change: "bg-blue-500",
	assignment: "bg-muted-foreground",
	claim: "bg-violet-500",
	release: "bg-violet-500/60",
	lease_expired: "bg-amber-500",
	comment: "bg-muted-foreground",
	agent_note: "bg-violet-500",
	fix_proposed: "bg-success",
	regression: "bg-destructive",
	snooze: "bg-muted-foreground/70",
	unsnooze: "bg-muted-foreground/70",
	ai_triage: "bg-violet-500",
	anomaly_linked: "bg-amber-500",
	severity_change: "bg-orange-500",
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
		case "ai_triage": {
			return payloadString(p.summary)
		}
		case "anomaly_linked": {
			const action = payloadString(p.action) === "unlinked" ? "Unlinked from" : "Linked to"
			const signal = payloadString(p.signalType)
			const service = payloadString(p.serviceName)
			return signal && service ? `${action} a ${signal} anomaly on ${service}` : null
		}
		case "severity_change": {
			const from = payloadString(p.from) ?? "unset"
			const to = payloadString(p.to) ?? "unset"
			const source = payloadString(p.source)
			const confidence = payloadString(p.confidence)
			const note = payloadString(p.note)
			const suffix =
				source === "ai"
					? ` by AI triage${confidence ? ` (${confidence} confidence)` : ""}`
					: source === "detector"
						? " from detector"
						: ""
			return `${from} → ${to}${suffix}${note ? ` — ${note}` : ""}`
		}
		default:
			return null
	}
}

export function IssueTimeline({
	events,
	escalations = [],
}: {
	events: ReadonlyArray<ErrorIssueEventDocument>
	escalations?: ReadonlyArray<IssueEscalationAttemptDocument>
}) {
	const items = [
		...events.map((event) => ({ kind: "event" as const, createdAt: event.createdAt, event })),
		...escalations.map((escalation) => ({
			kind: "escalation" as const,
			createdAt: escalation.createdAt,
			escalation,
		})),
	].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

	if (items.length === 0) {
		return <div className="py-6 text-center text-sm text-muted-foreground">No events recorded yet.</div>
	}

	return (
		<ol className="relative ml-16 border-l border-border/60">
			{items.map((item) => {
				if (item.kind === "escalation") {
					const escalation = item.escalation
					const destinations = escalation.deliveries
						.map(
							(delivery) =>
								`${delivery.destinationName ?? delivery.destinationId}: ${delivery.status}`,
						)
						.join(", ")
					const body =
						destinations ||
						escalation.skipReason?.replaceAll("_", " ") ||
						`${escalation.attempts} delivery attempt${escalation.attempts === 1 ? "" : "s"}`
					return (
						<li key={`escalation:${escalation.id}`} className="relative py-3 pl-4">
							<span className="absolute -left-16 top-4 w-12 text-right text-[11px] tabular-nums text-muted-foreground">
								{formatRelativeTime(escalation.createdAt)}
							</span>
							<span
								aria-hidden
								className="absolute -left-[5px] top-4 block size-2.5 rounded-full bg-orange-500 ring-2 ring-background"
							/>
							<div className="flex flex-wrap items-center gap-2 text-sm">
								<span className="font-medium text-foreground">Escalation</span>
								<span className="font-mono text-[11px] capitalize text-muted-foreground">
									{escalation.severity} · {escalation.status}
								</span>
							</div>
							<div className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
								{body}
							</div>
						</li>
					)
				}
				const event = item.event
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

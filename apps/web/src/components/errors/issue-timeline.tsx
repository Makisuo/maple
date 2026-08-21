import type {
	ActorDocument,
	ErrorIssueEventDocument,
	IssueEscalationAttemptDocument,
} from "@maple/domain/http"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import type { ReactNode } from "react"
import { cn } from "@maple/ui/lib/utils"

import { MessageResponse } from "@/components/ai-elements/message-response"
import { useActorDirectory } from "@/hooks/use-actor-directory"
import { IdentityAvatar, resolveActorIdentity, type ActorIdentity } from "./actor-chip"

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
} satisfies Record<ErrorIssueEventDocument["type"], string>

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
} satisfies Record<ErrorIssueEventDocument["type"], string>

/**
 * Event types that are somebody *saying* something, as opposed to the system
 * recording that something happened. These get the conversation treatment —
 * avatar, name, markdown body in a bubble — because they are written prose that
 * a human or an agent chose the words for. Everything else stays a one-line
 * ledger entry; a state change does not deserve the same visual weight as a
 * paragraph of triage reasoning.
 */
const MESSAGE_TYPES = new Set<ErrorIssueEventDocument["type"]>([
	"comment",
	"agent_note",
	"ai_triage",
	"fix_proposed",
])

/**
 * Verb shown after the author's name on a message row. `null` where the row
 * needs none — a comment reads as one already.
 *
 * Total over the union like `EVENT_LABEL` and `DOT_CLASS` above, rather than a
 * `Partial<Record<...>>`: an open dictionary makes every lookup implicitly
 * `any`, and a new event type should be a type error here, not a silently
 * missing verb.
 */
const MESSAGE_VERB = {
	created: null,
	state_change: null,
	assignment: null,
	claim: null,
	release: null,
	lease_expired: null,
	comment: null,
	agent_note: "left a note",
	fix_proposed: "proposed a fix",
	regression: null,
	snooze: null,
	unsnooze: null,
	ai_triage: "triaged this",
	anomaly_linked: null,
	severity_change: null,
} satisfies Record<ErrorIssueEventDocument["type"], string | null>

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

type TimelineItem =
	| { kind: "event"; key: string; createdAt: string; event: ErrorIssueEventDocument }
	| { kind: "escalation"; key: string; createdAt: string; escalation: IssueEscalationAttemptDocument }

export function IssueTimeline({
	events,
	escalations = [],
}: {
	events: ReadonlyArray<ErrorIssueEventDocument>
	escalations?: ReadonlyArray<IssueEscalationAttemptDocument>
}) {
	const directory = useActorDirectory()

	// Oldest first. This list is read as a conversation with the composer at its
	// foot, and a thread that answers itself upwards is unreadable — a reply
	// rendered above the message it replies to.
	const items: ReadonlyArray<TimelineItem> = [
		...events.map(
			(event): TimelineItem => ({
				kind: "event",
				key: event.id,
				createdAt: event.createdAt,
				event,
			}),
		),
		...escalations.map(
			(escalation): TimelineItem => ({
				kind: "escalation",
				key: `escalation:${escalation.id}`,
				createdAt: escalation.createdAt,
				escalation,
			}),
		),
	].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))

	if (items.length === 0) {
		return (
			<div className="rounded-xl border border-dashed py-10 text-center">
				<p className="text-sm font-medium text-foreground">No activity yet</p>
				<p className="mt-1 text-xs text-muted-foreground">
					Comments from your team and notes from agents working this issue land here.
				</p>
			</div>
		)
	}

	return (
		// A grid, not `ml-16` plus `-left-16` absolutely-positioned timestamps. That
		// pair was two magic numbers that had to agree, and they only agreed at the
		// width the page happened to be: in the narrower tab column the times ran off
		// the left edge of the scroll area. Here the gutter IS a column.
		<ol className="flex flex-col">
			{items.map((item, index) => {
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
						<li className={ITEM} key={item.key}>
							<span className={STAMP}>{formatRelativeTime(escalation.createdAt)}</span>
							<Rail>
								<Dot className="bg-orange-500" />
							</Rail>
							<div className="min-w-0 py-2.5">
								<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
									<span className="font-medium text-foreground">Escalation</span>
									<span className="font-mono text-[11px] capitalize text-muted-foreground">
										{escalation.severity} · {escalation.status}
									</span>
								</div>
								<div className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
									{body}
								</div>
							</div>
						</li>
					)
				}

				const event = item.event
				const body = renderPayload(event)

				if (MESSAGE_TYPES.has(event.type) && body) {
					const previous = items[index - 1]
					return (
						<MessageRow
							body={body}
							continued={isSameAuthorWithin(previous, event)}
							event={event}
							identity={event.actor ? resolveActorIdentity(event.actor, directory) : null}
							key={item.key}
						/>
					)
				}

				return (
					<li className={ITEM} key={item.key}>
						<span className={STAMP}>{formatRelativeTime(event.createdAt)}</span>
						<Rail>
							<Dot
								className={cn(
									DOT_CLASS[event.type],
									event.type === "regression" && "animate-pulse",
								)}
							/>
						</Rail>
						<div className="min-w-0 py-2.5">
							<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
								<span className="font-medium text-foreground">{EVENT_LABEL[event.type]}</span>
								{event.fromState && event.toState ? (
									<span className="font-mono text-[11px] text-muted-foreground">
										{event.fromState} → {event.toState}
									</span>
								) : null}
								<AuthorLabel actor={event.actor} directory={directory} />
							</div>
							{body ? (
								<div className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
									{body}
								</div>
							) : null}
						</div>
					</li>
				)
			})}
		</ol>
	)
}

/** "by Ada Lovelace" — quiet, because the event label already carries the row. */
function AuthorLabel({
	actor,
	directory,
}: {
	actor: ActorDocument | null
	directory: ReturnType<typeof useActorDirectory>
}) {
	if (!actor) return null
	const identity = resolveActorIdentity(actor, directory)
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 text-[11px]",
				identity.kind === "agent" ? "text-violet-600 dark:text-violet-300" : "text-muted-foreground",
			)}
			title={identity.detail ?? undefined}
		>
			<IdentityAvatar identity={identity} />
			{identity.name}
		</span>
	)
}

/**
 * A written message: avatar in the rail, author and time in the header, body in
 * a bubble. Agent messages are tinted violet so a room half-full of automation
 * still reads at a glance as "these two paragraphs weren't written by a person".
 */
function MessageRow({
	event,
	identity,
	body,
	continued,
}: {
	event: ErrorIssueEventDocument
	identity: ActorIdentity | null
	body: string
	continued: boolean
}) {
	const isAgent = identity?.kind === "agent"
	const verb = MESSAGE_VERB[event.type]

	return (
		<li className={MESSAGE_ITEM}>
			<span className={cn(STAMP, continued && "opacity-0 group-hover/row:opacity-100")}>
				{formatRelativeTime(event.createdAt)}
			</span>
			<Rail>
				{continued ? (
					<span aria-hidden />
				) : identity ? (
					<IdentityAvatar
						className="relative ring-2 ring-background"
						identity={identity}
						size="md"
					/>
				) : (
					<Dot className="bg-muted-foreground" />
				)}
			</Rail>
			<div className={cn("min-w-0", continued ? "pb-2.5" : "pt-1 pb-2.5")}>
				{continued ? null : (
					<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
						<span className="text-sm font-medium text-foreground">
							{identity?.name ?? "Unknown"}
						</span>
						{isAgent ? (
							<span
								className="rounded-full bg-violet-500/10 px-1.5 py-px font-mono text-[10px] text-violet-600 dark:text-violet-300"
								title={identity?.detail ?? undefined}
							>
								{identity?.detail ?? "agent"}
							</span>
						) : null}
						{verb ? <span className="text-xs text-muted-foreground">{verb}</span> : null}
					</div>
				)}
				<div
					className={cn(
						"mt-1.5 max-w-prose overflow-x-auto rounded-xl border px-3 py-2 text-sm",
						isAgent
							? "border-violet-500/20 bg-violet-500/[0.06]"
							: "border-border/70 bg-muted/40",
					)}
				>
					<MessageResponse className="text-sm leading-relaxed">{body}</MessageResponse>
				</div>
			</div>
		</li>
	)
}

/**
 * Two messages from the same author, minutes apart, are one turn in a
 * conversation — repeating the avatar and name for each is the visual noise that
 * makes a busy agent thread unreadable.
 */
const CONTINUATION_WINDOW_MS = 5 * 60 * 1000

function isSameAuthorWithin(previous: TimelineItem | undefined, event: ErrorIssueEventDocument): boolean {
	if (!previous || previous.kind !== "event") return false
	if (!MESSAGE_TYPES.has(previous.event.type)) return false
	if (previous.event.type !== event.type) return false
	const previousActor = previous.event.actor?.id ?? null
	if (previousActor === null || previousActor !== (event.actor?.id ?? null)) return false
	return Date.parse(event.createdAt) - Date.parse(previous.event.createdAt) < CONTINUATION_WINDOW_MS
}

/** Timestamp gutter | connector rail | content. `group` so the rail can shorten
 *  itself on the last item rather than trailing into empty space. */
// No `items-start`: the rail column has to stretch to the row height for its
// connector line to reach the next dot.
const ITEM = "group/row grid grid-cols-[4.25rem_1.75rem_minmax(0,1fr)] gap-x-3"
const MESSAGE_ITEM = `${ITEM} first:pt-0`

// `whitespace-nowrap`: `formatRelativeTime` can return "just now", and a gutter
// that wraps it onto two lines pushes the dot out of line with its own row.
const STAMP =
	"py-3 text-right text-[11px] leading-5 whitespace-nowrap tabular-nums text-muted-foreground transition-opacity"

/** The connector column: a hairline the full row height, marker centred on it. */
function Rail({ children }: { children: ReactNode }) {
	return (
		<span className="relative flex h-full justify-center">
			<span aria-hidden className="h-full w-px bg-border/60 group-last/row:h-5" />
			<span className="absolute top-2.5 flex justify-center">{children}</span>
		</span>
	)
}

function Dot({ className }: { className: string }) {
	return <span aria-hidden className={cn("mt-1 size-2.5 rounded-full ring-2 ring-background", className)} />
}

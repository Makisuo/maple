import type { ErrorIssueEventDocument } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
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

function renderPayload(
  event: ErrorIssueEventDocument,
): string | null {
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
      const note = payloadString(p.note)
      return note
    }
    default:
      return null
  }
}

export function IssueTimeline({
  events,
}: {
  events: ReadonlyArray<ErrorIssueEventDocument>
}) {
  if (events.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No events recorded yet.
      </div>
    )
  }

  return (
    <ol className="space-y-3">
      {events.map((event) => {
        const body = renderPayload(event)
        return (
          <li
            key={event.id}
            className="rounded-lg border border-border/60 bg-card p-3"
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline">{EVENT_LABEL[event.type]}</Badge>
              {event.fromState && event.toState ? (
                <span className="text-xs text-muted-foreground">
                  {event.fromState} → {event.toState}
                </span>
              ) : null}
              <ActorChip actor={event.actor} />
              <span className="ml-auto text-xs text-muted-foreground">
                {formatRelativeTime(event.createdAt)}
              </span>
            </div>
            {body ? (
              <div className="mt-2 whitespace-pre-wrap text-sm">{body}</div>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

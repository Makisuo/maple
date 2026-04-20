import { Link } from "@tanstack/react-router"
import type { ErrorIssueDocument } from "@maple/domain/http"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { cn } from "@maple/ui/lib/utils"

import { ActorAvatar } from "./actor-chip"
import { IssueContextMenu } from "./issue-context-menu"
import { WorkflowStatePopover } from "./workflow-state-popover"
import type { IssueMutations } from "./use-issue-mutations"
import { PriorityBarsIcon, WorkflowRingIcon } from "@/components/icons"
import type { PriorityLevel } from "@/components/icons"
import { formatNumber } from "@/lib/format"
import { getServiceColorClass } from "@maple/ui/lib/colors"

function clampPriority(value: number): PriorityLevel {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.trunc(value)
  if (rounded < 0) return 0
  if (rounded > 4) return 4
  return rounded as PriorityLevel
}

function shortIssueId(id: string): string {
  return id.replace(/-/g, "").slice(0, 7).toUpperCase()
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function formatLastSeen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const diffMs = Date.now() - d.getTime()
  if (diffMs < 60_000) return "now"
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m`
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h`
  if (diffMs < WEEK_MS) return `${Math.floor(diffMs / 86_400_000)}d`
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  })
}

export interface SelectToggleEvent {
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}

export interface IssueRowProps {
  issue: ErrorIssueDocument
  mutations: IssueMutations
  selected: boolean
  focused: boolean
  onSelectToggle: (id: string, event: SelectToggleEvent) => void
  onFocus: (id: string) => void
}

export function IssueRow({
  issue,
  mutations,
  selected,
  focused,
  onSelectToggle,
  onFocus,
}: IssueRowProps) {
  const priority = clampPriority(issue.priority)
  const holderOrAssignee = issue.leaseHolder ?? issue.assignedActor
  const id = shortIssueId(issue.id)
  const href = `/errors/issues/${issue.id}`

  return (
    <IssueContextMenu
      issue={issue}
      mutations={mutations}
      issueUrl={href}
      onOpenInNewTab={() =>
        window.open(href, "_blank", "noopener,noreferrer")
      }
    >
      <div
        data-issue-id={issue.id}
        data-focused={focused || undefined}
        data-selected={selected || undefined}
        onMouseEnter={() => onFocus(issue.id)}
        className={cn(
          "group/row relative flex h-9 items-center gap-2 pr-3 pl-2 text-sm",
          "hover:bg-muted/50",
          "data-focused:bg-muted/40",
          "data-selected:bg-primary/10 data-selected:hover:bg-primary/15",
          "transition-colors",
        )}
      >
        <Link
          to="/errors/issues/$issueId"
          params={{ issueId: issue.id }}
          aria-label={`Open ${issue.exceptionType || "issue"}`}
          className="absolute inset-0 focus-visible:outline-none"
          tabIndex={-1}
        />

        <span
          className={cn(
            "relative z-10 flex w-4 shrink-0 items-center justify-center",
            "opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100",
            selected && "opacity-100",
          )}
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            onSelectToggle(issue.id, {
              shiftKey: e.shiftKey,
              metaKey: e.metaKey,
              ctrlKey: e.ctrlKey,
            })
          }}
        >
          <Checkbox
            aria-label={`Select issue ${id}`}
            checked={selected}
            tabIndex={-1}
            onClick={(e) => e.preventDefault()}
          />
        </span>

        <span
          className="relative z-10 flex w-4 shrink-0 items-center justify-center text-muted-foreground"
          onClick={(e) => e.stopPropagation()}
          title={`Priority: ${priority === 0 ? "None" : priority === 1 ? "Urgent" : priority === 2 ? "High" : priority === 3 ? "Medium" : "Low"}`}
        >
          <PriorityBarsIcon level={priority} size={14} />
        </span>

        <span className="relative z-10 w-[72px] shrink-0 truncate font-mono text-xs tabular-nums text-muted-foreground">
          {id}
        </span>

        <span
          className="relative z-10 flex w-4 shrink-0 items-center justify-center"
          onClick={(e) => e.stopPropagation()}
        >
          <WorkflowStatePopover
            current={issue.workflowState}
            onSelect={(next) => mutations.transitionTo(issue.id, next)}
          >
            <WorkflowRingIcon state={issue.workflowState} size={14} />
          </WorkflowStatePopover>
        </span>

        <span className="relative z-0 min-w-0 flex-1 truncate text-foreground">
          {issue.exceptionType || "Unknown error"}
          {issue.exceptionMessage ? (
            <span className="ml-2 text-muted-foreground">
              {issue.exceptionMessage}
            </span>
          ) : null}
        </span>

        {issue.hasOpenIncident ? (
          <span
            className={cn(
              "relative z-10 inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-1.5",
              "text-[11px] font-medium text-destructive",
            )}
            title="Incident open"
          >
            <span className="relative inline-flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive opacity-60" />
              <span className="relative inline-flex size-full rounded-full bg-destructive" />
            </span>
            incident
          </span>
        ) : null}

        <span
          className={cn(
            "relative z-10 hidden h-5 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background px-2",
            "text-[11px] text-muted-foreground md:inline-flex",
          )}
          title={issue.serviceName}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              getServiceColorClass(issue.serviceName),
            )}
          />
          <span className="max-w-[120px] truncate">{issue.serviceName}</span>
        </span>

        <span
          className="relative z-10 hidden shrink-0 text-right text-xs tabular-nums text-muted-foreground md:inline-block md:w-[88px]"
          title={`${issue.occurrenceCount.toLocaleString()} events`}
        >
          {formatNumber(issue.occurrenceCount)} events
        </span>

        <span className="relative z-10 shrink-0">
          <ActorAvatar actor={holderOrAssignee} />
        </span>

        <span
          className="relative z-10 w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
          title={`Last seen ${new Date(issue.lastSeenAt).toLocaleString()}`}
        >
          {formatLastSeen(issue.lastSeenAt)}
        </span>
      </div>
    </IssueContextMenu>
  )
}

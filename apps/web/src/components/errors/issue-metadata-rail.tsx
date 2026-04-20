import type { ErrorIssueDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { getServiceColorClass } from "@maple/ui/lib/colors"

import {
  PriorityBarsIcon,
  WorkflowRingIcon,
  WORKFLOW_LABEL,
  PRIORITY_LABEL,
} from "@/components/icons"
import { formatNumber, formatRelativeTime } from "@/lib/format"
import { clampPriority, shortIssueId } from "./issue-id"

interface IssueMetadataRailProps {
  issue: ErrorIssueDocument
  className?: string
}

export function IssueMetadataRail({
  issue,
  className,
}: IssueMetadataRailProps) {
  const priority = clampPriority(issue.priority)
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border/60 bg-card/50 px-3 py-2 text-xs",
        "divide-border/60 [&>*+*]:border-l [&>*+*]:pl-4",
        className,
      )}
    >
      <Cell>
        <span className="font-mono tabular-nums text-muted-foreground">
          {shortIssueId(issue.id)}
        </span>
      </Cell>

      <Cell>
        <WorkflowRingIcon state={issue.workflowState} size={12} />
        <span className="text-foreground">
          {WORKFLOW_LABEL[issue.workflowState]}
        </span>
      </Cell>

      <Cell title={PRIORITY_LABEL[priority]}>
        <PriorityBarsIcon level={priority} size={12} />
        <span className="text-muted-foreground">
          {PRIORITY_LABEL[priority]}
        </span>
      </Cell>

      <Cell title={issue.serviceName}>
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            getServiceColorClass(issue.serviceName),
          )}
        />
        <span className="max-w-[160px] truncate text-foreground">
          {issue.serviceName}
        </span>
      </Cell>

      <Cell
        title={`First seen ${new Date(issue.firstSeenAt).toLocaleString()} · Last seen ${new Date(issue.lastSeenAt).toLocaleString()}`}
      >
        <span className="text-muted-foreground tabular-nums">
          {formatRelativeTime(issue.firstSeenAt)}
        </span>
        <span aria-hidden className="text-muted-foreground/60">
          ↔
        </span>
        <span className="text-foreground tabular-nums">
          {formatRelativeTime(issue.lastSeenAt)}
        </span>
      </Cell>

      <Cell title={`${issue.occurrenceCount.toLocaleString()} events`}>
        <span className="font-mono tabular-nums text-foreground">
          {formatNumber(issue.occurrenceCount)}
        </span>
        <span className="text-muted-foreground">events</span>
      </Cell>
    </div>
  )
}

function Cell({
  children,
  title,
}: {
  children: React.ReactNode
  title?: string
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap"
      title={title}
    >
      {children}
    </span>
  )
}

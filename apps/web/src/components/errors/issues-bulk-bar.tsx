import type { ErrorIssueId, WorkflowState } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"

import {
  WORKFLOW_LABEL,
  WorkflowRingIcon,
} from "@/components/icons/workflow-ring"
import { XmarkIcon } from "@/components/icons"
import type { IssueMutations } from "./use-issue-mutations"

const STATE_ORDER: ReadonlyArray<WorkflowState> = [
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
  "wontfix",
]

export function IssuesBulkBar({
  selectedIds,
  mutations,
  onClear,
}: {
  selectedIds: ReadonlyArray<ErrorIssueId>
  mutations: IssueMutations
  onClear: () => void
}) {
  if (selectedIds.length === 0) return null

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className={cn(
        "pointer-events-auto fixed bottom-4 left-1/2 z-40 -translate-x-1/2",
        "flex items-center gap-1 rounded-xl border border-border/80 bg-popover/95 p-1 pr-2 pl-2 shadow-lg backdrop-blur",
      )}
    >
      <span className="pr-2 pl-1 text-xs font-medium text-foreground tabular-nums">
        {selectedIds.length} selected
      </span>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <div className="flex items-center gap-0.5">
        {STATE_ORDER.map((state) => (
          <button
            key={state}
            type="button"
            onClick={() => {
              void mutations.transitionMany(selectedIds, state)
              onClear()
            }}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            title={`Move to ${WORKFLOW_LABEL[state]}`}
          >
            <WorkflowRingIcon state={state} size={12} />
            <span className="hidden lg:inline">{WORKFLOW_LABEL[state]}</span>
          </button>
        ))}
      </div>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear selection"
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <XmarkIcon size={14} />
      </button>
    </div>
  )
}

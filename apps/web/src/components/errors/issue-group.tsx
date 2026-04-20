import { useCallback, useEffect, useState } from "react"
import type { ErrorIssueDocument, WorkflowState } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"

import { ChevronDownIcon, ChevronRightIcon } from "@/components/icons"
import { WORKFLOW_LABEL, WorkflowRingIcon } from "@/components/icons/workflow-ring"
import { IssueRow, type SelectToggleEvent } from "./issue-row"
import type { IssueMutations } from "./use-issue-mutations"

const STORAGE_KEY = "issues:collapsed-groups"

function readCollapsed(): Set<WorkflowState> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as WorkflowState[]
    return new Set(parsed)
  } catch {
    return new Set()
  }
}

function writeCollapsed(set: Set<WorkflowState>) {
  if (typeof window === "undefined") return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...set]))
  } catch {
    // ignore quota errors
  }
}

export function IssueGroup({
  state,
  issues,
  mutations,
  selectedIds,
  focusedId,
  onSelectToggle,
  onFocus,
}: {
  state: WorkflowState
  issues: ReadonlyArray<ErrorIssueDocument>
  mutations: IssueMutations
  selectedIds: ReadonlySet<string>
  focusedId: string | null
  onSelectToggle: (id: string, event: SelectToggleEvent) => void
  onFocus: (id: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<WorkflowState>>(() =>
    readCollapsed(),
  )

  useEffect(() => {
    writeCollapsed(collapsed)
  }, [collapsed])

  const isOpen = !collapsed.has(state)

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(state)) next.delete(state)
      else next.add(state)
      return next
    })
  }, [state])

  const label = WORKFLOW_LABEL[state]

  return (
    <section>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-controls={`issue-group-${state}`}
        className={cn(
          "sticky top-0 z-10 flex h-8 w-full items-center gap-2 border-b border-border/60 bg-muted/40 pr-2 pl-2 text-left outline-none",
          "backdrop-blur supports-[backdrop-filter]:bg-muted/60",
          "hover:bg-muted/60",
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {isOpen ? (
            <ChevronDownIcon size={14} />
          ) : (
            <ChevronRightIcon size={14} />
          )}
        </span>
        <span className="flex shrink-0 items-center">
          <WorkflowRingIcon state={state} size={14} />
        </span>
        <span className="shrink-0 text-sm font-medium text-foreground">
          {label}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {issues.length}
        </span>
      </button>
      {isOpen ? (
        <div
          id={`issue-group-${state}`}
          role="list"
          className="divide-y divide-border/40"
        >
          {issues.map((issue) => (
            <div role="listitem" key={issue.id}>
              <IssueRow
                issue={issue}
                mutations={mutations}
                selected={selectedIds.has(issue.id)}
                focused={focusedId === issue.id}
                onSelectToggle={onSelectToggle}
                onFocus={onFocus}
              />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

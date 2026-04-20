import type { ReactNode } from "react"
import { toast } from "sonner"
import type { ErrorIssueDocument, WorkflowState } from "@maple/domain/http"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@maple/ui/components/ui/context-menu"

import { WORKFLOW_LABEL, WorkflowRingIcon } from "@/components/icons/workflow-ring"
import { CheckIcon } from "@/components/icons"
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

export function IssueContextMenu({
  issue,
  mutations,
  issueUrl,
  onOpenInNewTab,
  children,
}: {
  issue: ErrorIssueDocument
  mutations: IssueMutations
  issueUrl: string
  onOpenInNewTab: () => void
  children: ReactNode
}) {
  const canClaim = !issue.leaseHolder
  const canRelease = Boolean(issue.leaseHolder)

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(issue.id)
      toast.success("Copied issue ID")
    } catch {
      toast.error("Copy failed")
    }
  }

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(window.location.origin + issueUrl)
      toast.success("Copied link")
    } catch {
      toast.error("Copy failed")
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div>{children}</div>} />
      <ContextMenuContent className="w-56 p-1">
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <WorkflowRingIcon state={issue.workflowState} size={14} />
            <span>Change status</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-56 p-1">
            {STATE_ORDER.map((state) => {
              const active = state === issue.workflowState
              return (
                <ContextMenuItem
                  key={state}
                  onClick={() => {
                    if (!active) void mutations.transitionTo(issue.id, state)
                  }}
                  disabled={active}
                >
                  <WorkflowRingIcon state={state} size={14} />
                  <span className="flex-1">{WORKFLOW_LABEL[state]}</span>
                  {active ? (
                    <CheckIcon
                      size={12}
                      className="text-muted-foreground"
                    />
                  ) : null}
                </ContextMenuItem>
              )
            })}
          </ContextMenuSubContent>
        </ContextMenuSub>

        {canClaim ? (
          <ContextMenuItem
            onClick={() => void mutations.claimIssue(issue.id)}
          >
            Claim
          </ContextMenuItem>
        ) : null}
        {canRelease ? (
          <ContextMenuItem
            onClick={() => void mutations.releaseIssue(issue.id)}
          >
            Release
          </ContextMenuItem>
        ) : null}

        <ContextMenuSeparator />
        <ContextMenuItem onClick={onOpenInNewTab}>
          Open in new tab
        </ContextMenuItem>
        <ContextMenuItem onClick={copyUrl}>Copy link</ContextMenuItem>
        <ContextMenuItem onClick={copyId}>Copy ID</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

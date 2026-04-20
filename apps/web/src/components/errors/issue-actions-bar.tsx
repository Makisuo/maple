import type { ErrorIssueDocument, WorkflowState } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import { ActorChip } from "./actor-chip"
import { StateSelect } from "./state-select"

type Busy = "state" | "claim" | "release" | "heartbeat" | "comment" | null

interface IssueActionsBarProps {
  issue: ErrorIssueDocument
  busy: Busy
  onTransition: (next: WorkflowState) => void
  onClaim: () => void
  onHeartbeat: () => void
  onRelease: () => void
  className?: string
}

export function IssueActionsBar({
  issue,
  busy,
  onTransition,
  onClaim,
  onHeartbeat,
  onRelease,
  className,
}: IssueActionsBarProps) {
  const isTerminal =
    issue.workflowState === "cancelled" || issue.workflowState === "done"
  const canClaim = !issue.leaseHolder && !isTerminal

  return (
    <div
      className={cn(
        "sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-3 rounded-md border border-border/60 bg-background/80 px-3 py-2 backdrop-blur",
        className,
      )}
    >
      <FieldGroup label="State">
        <StateSelect
          current={issue.workflowState}
          disabled={busy === "state"}
          onChange={onTransition}
        />
      </FieldGroup>

      <FieldGroup label="Assignee">
        <ActorChip actor={issue.assignedActor} />
      </FieldGroup>

      <div className="ml-auto flex items-center gap-2">
        {canClaim ? (
          <Button size="sm" onClick={onClaim} disabled={busy === "claim"}>
            Claim
          </Button>
        ) : null}
        {issue.leaseHolder ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={onHeartbeat}
              disabled={busy === "heartbeat"}
            >
              Heartbeat
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onRelease}
              disabled={busy === "release"}
            >
              Release
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}

function FieldGroup({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

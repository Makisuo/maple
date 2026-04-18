import type { WorkflowState } from "@maple/domain/http"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@maple/ui/components/ui/select"

const TRANSITIONS: Record<WorkflowState, ReadonlyArray<WorkflowState>> = {
  triage: ["todo", "in_progress", "cancelled", "wontfix"],
  todo: ["triage", "in_progress", "cancelled", "wontfix"],
  in_progress: ["triage", "todo", "in_review", "cancelled", "wontfix"],
  in_review: ["triage", "in_progress", "done", "cancelled", "wontfix"],
  done: ["triage", "in_progress", "cancelled", "wontfix"],
  cancelled: [],
  wontfix: ["triage", "cancelled"],
}

const LABEL: Record<WorkflowState, string> = {
  triage: "Triage",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
  wontfix: "Wontfix",
}

const ALL_STATES: ReadonlyArray<WorkflowState> = [
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
  "wontfix",
]

export function StateSelect({
  current,
  disabled,
  onChange,
}: {
  current: WorkflowState
  disabled?: boolean
  onChange: (next: WorkflowState) => void
}) {
  const allowed = new Set<WorkflowState>(TRANSITIONS[current])
  return (
    <Select
      value={current}
      onValueChange={(v) => onChange(v as WorkflowState)}
      disabled={disabled}
    >
      <SelectTrigger className="w-44">
        <SelectValue placeholder="State" />
      </SelectTrigger>
      <SelectContent>
        {ALL_STATES.map((state) => {
          const reachable = state === current || allowed.has(state)
          return (
            <SelectItem key={state} value={state} disabled={!reachable}>
              {LABEL[state]}
              {state === current ? " (current)" : null}
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

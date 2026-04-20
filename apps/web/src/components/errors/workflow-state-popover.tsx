import { useState } from "react"
import type { ReactNode } from "react"
import type { WorkflowState } from "@maple/domain/http"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@maple/ui/components/ui/popover"
import { cn } from "@maple/ui/lib/utils"

import { WORKFLOW_LABEL, WorkflowRingIcon } from "@/components/icons/workflow-ring"
import { CheckIcon } from "@/components/icons"

const STATE_ORDER: ReadonlyArray<WorkflowState> = [
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
  "wontfix",
]

export function WorkflowStatePopover({
  current,
  onSelect,
  children,
  align = "start",
}: {
  current: WorkflowState
  onSelect: (next: WorkflowState) => void | Promise<unknown>
  children: ReactNode
  align?: "start" | "center" | "end"
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Change status (current: ${WORKFLOW_LABEL[current]})`}
          >
            {children}
          </button>
        }
      />
      <PopoverContent
        align={align}
        sideOffset={6}
        className="w-56 gap-0 p-1"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
          Change status
        </div>
        {STATE_ORDER.map((state) => {
          const active = state === current
          return (
            <button
              key={state}
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
                if (!active) {
                  void onSelect(state)
                }
              }}
              className={cn(
                "group/item flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground outline-none",
                active && "bg-muted/60",
              )}
            >
              <WorkflowRingIcon state={state} size={14} />
              <span className="flex-1">{WORKFLOW_LABEL[state]}</span>
              {active ? (
                <CheckIcon size={12} className="text-muted-foreground" />
              ) : null}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

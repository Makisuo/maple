import type { WorkflowState } from "@maple/domain/http"
import {
	allowedTransitionsForAll,
	MACHINE_OWNED_WORKFLOW_STATES,
	WORKFLOW_STATE_ORDER,
} from "@maple/domain/http"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"

import { WORKFLOW_LABEL, WorkflowRingIcon } from "@/components/icons/workflow-ring"

/**
 * `regressed` and `verifying` are set by the ticks, never chosen — each records
 * something observed rather than intended. Both still render as the CURRENT
 * value when an issue is in one; they are only absent from the choices.
 */
const OFFERED_STATES = WORKFLOW_STATE_ORDER.filter((state) => !MACHINE_OWNED_WORKFLOW_STATES.has(state))

const isWorkflowState = (value: string | null): value is WorkflowState =>
	value !== null && WORKFLOW_STATE_ORDER.some((state) => state === value)

export function StateSelect({
	current,
	disabled,
	onChange,
	className = "w-full",
}: {
	current: WorkflowState
	disabled?: boolean
	onChange: (next: WorkflowState) => void
	className?: string
}) {
	const allowed = new Set<WorkflowState>(allowedTransitionsForAll([current]))
	const change = (value: unknown) => {
		const next = WORKFLOW_STATE_ORDER.find((state) => state === value)
		if (next !== undefined && next !== current && allowed.has(next)) onChange(next)
	}
	return (
		<Select value={current} onValueChange={change} disabled={disabled}>
			<SelectTrigger className={className}>
				{/* Base UI prints the raw value ("in_progress") unless given a
				    renderer. Third place this bit — see the errors hub and
				    `severity-select.tsx`. */}
				<SelectValue placeholder="State">
					{(value: string | null) =>
						isWorkflowState(value) ? (
							<span className="flex items-center gap-2">
								<WorkflowRingIcon state={value} size={12} />
								{WORKFLOW_LABEL[value]}
							</span>
						) : (
							"State"
						)
					}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{OFFERED_STATES.map((state) => {
					const reachable = state === current || allowed.has(state)
					return (
						<SelectItem key={state} value={state} disabled={!reachable}>
							<span className="flex items-center gap-2">
								<WorkflowRingIcon state={state} size={12} />
								{WORKFLOW_LABEL[state]}
								{state === current ? " (current)" : null}
							</span>
						</SelectItem>
					)
				})}
			</SelectContent>
		</Select>
	)
}

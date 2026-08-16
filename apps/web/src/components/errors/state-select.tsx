import type { WorkflowState } from "@maple/domain/http"
import { allowedTransitionsForAll, WORKFLOW_STATE_ORDER } from "@maple/domain/http"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"

const LABEL: Record<WorkflowState, string> = {
	triage: "Triage",
	todo: "Todo",
	in_progress: "In progress",
	in_review: "In review",
	done: "Done",
	cancelled: "Cancelled",
	wontfix: "Wontfix",
} satisfies Record<WorkflowState, string>

export function StateSelect({
	current,
	disabled,
	onChange,
}: {
	current: WorkflowState
	disabled?: boolean
	onChange: (next: WorkflowState) => void
}) {
	const allowed = new Set<WorkflowState>(allowedTransitionsForAll([current]))
	const change = (value: unknown) => {
		const next = WORKFLOW_STATE_ORDER.find((state) => state === value)
		if (next !== undefined && next !== current && allowed.has(next)) onChange(next)
	}
	return (
		<Select value={current} onValueChange={change} disabled={disabled}>
			<SelectTrigger className="w-full">
				<SelectValue placeholder="State" />
			</SelectTrigger>
			<SelectContent>
				{WORKFLOW_STATE_ORDER.map((state) => {
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

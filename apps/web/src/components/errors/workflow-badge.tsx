import type { WorkflowState } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"

const WORKFLOW_BADGE: Record<WorkflowState, { label: string; tone: string }> = {
	triage: {
		label: "Triage",
		tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
	},
	// Red, not amber: a regression is a fix that did not hold, and it should read
	// as more urgent than an untriaged issue rather than the same.
	regressed: {
		label: "Regressed",
		tone: "bg-destructive/10 text-destructive",
	},
	todo: { label: "Todo", tone: "bg-muted text-muted-foreground" },
	in_progress: {
		label: "In progress",
		tone: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
	},
	in_review: {
		label: "In review",
		tone: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
	},
	done: { label: "Done", tone: "bg-success/10 text-success" },
	cancelled: { label: "Cancelled", tone: "bg-muted text-muted-foreground" },
	wontfix: { label: "Wontfix", tone: "bg-muted text-muted-foreground" },
} satisfies Record<WorkflowState, { label: string; tone: string }>

export function WorkflowBadge({ state }: { state: WorkflowState }) {
	const { label, tone } = WORKFLOW_BADGE[state]
	return (
		<Badge variant="outline" className={tone}>
			{label}
		</Badge>
	)
}

import type { WorkflowState } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"

import { WORKFLOW_LABEL } from "@/components/icons/workflow-ring"

/**
 * Tone only — the wording comes from {@link WORKFLOW_LABEL}, which the state
 * picker, the bulk bar and the workflow ring already share. This file used to
 * carry a fourth copy of the labels, and it was the one that drifted: it said
 * "Wontfix" where every other surface said "Won't fix".
 */
const WORKFLOW_TONE: Record<WorkflowState, string> = {
	triage: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
	// Red, not amber: a regression is a fix that did not hold, and it should read
	// as more urgent than an untriaged issue rather than the same.
	regressed: "bg-destructive/10 text-destructive",
	todo: "bg-muted text-muted-foreground",
	in_progress: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
	in_review: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
	// Teal, distinct from both `in_review` (a human is looking) and `done` (it is
	// over): a merged fix is being watched, and nobody needs to act yet.
	verifying: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
	done: "bg-success/10 text-success",
	cancelled: "bg-muted text-muted-foreground",
	wontfix: "bg-muted text-muted-foreground",
} satisfies Record<WorkflowState, string>

export function WorkflowBadge({ state }: { state: WorkflowState }) {
	return (
		<Badge variant="outline" className={WORKFLOW_TONE[state]}>
			{WORKFLOW_LABEL[state]}
		</Badge>
	)
}

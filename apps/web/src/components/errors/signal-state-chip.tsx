import { useNavigate } from "@tanstack/react-router"

import { cn } from "@maple/ui/lib/utils"
import { WORKFLOW_LABEL, WorkflowRingIcon } from "@/components/icons/workflow-ring"
import type { V2Investigation } from "@maple/domain/http/v2"
import type { SignalState } from "@/lib/models/error-signal"

/**
 * The one status slot on an error row — the issue header's, now. The list
 * row's status lane became the workflow picker, so the list only draws this
 * for the two kinds that are not a workflow state (an open incident, a live
 * investigation), as a mark beside the error's name.
 *
 * A row used to be able to carry four of these at once — a workflow badge, an
 * "Open incident" pill, a kind badge, and an investigation that was only
 * visible on a different route. Four badge systems for one object meant none of
 * them read as important. `SignalState` picks one by precedence; this draws it.
 *
 * Only `incident` takes colour. Everything else is muted, so the coloured
 * things left on a row — the severity chip and an open incident — are the two
 * that should pull the eye.
 */

/** Total over `InvestigationStatus`. `resolved` never reaches here — a resolved
 *  investigation is history and the row falls back to its workflow state — but
 *  leaving the map total means a new status is a type error, not a blank chip. */
const INVESTIGATION_LABEL = {
	investigating: "Investigating",
	diagnosed: "Diagnosed",
	inconclusive: "Inconclusive",
	failed: "Pass failed",
	resolved: "Resolved",
} satisfies Record<V2Investigation["status"], string>

export function SignalStateChip({
	state,
	withConfidence = true,
	compact = false,
	className,
}: {
	state: SignalState
	/** Inline `· medium` after "Diagnosed". The list row turns it off — its fixed
	 *  lane cannot fit the suffix on one line, and the tooltip still carries it. */
	withConfidence?: boolean
	/** For the list row, whose identity lane this shares with the error message:
	 *  "Incident" rather than "Open incident", and below `@xl` only the dot —
	 *  every character here is one the message loses. */
	compact?: boolean
	className?: string
}) {
	const navigate = useNavigate()

	if (state.kind === "incident") {
		return (
			<span
				className={cn(
					"inline-flex max-w-full items-center gap-1.5 text-[11px] font-medium whitespace-nowrap text-destructive",
					className,
				)}
				title="An incident is open for this error"
			>
				<span className="size-1.5 shrink-0 rounded-full bg-destructive" />
				<span className={cn("truncate", compact && "hidden @xl/page:inline")}>
					{compact ? "Incident" : "Open incident"}
				</span>
			</span>
		)
	}

	if (state.kind === "investigation") {
		const label = INVESTIGATION_LABEL[state.status]
		const isLive = state.status === "investigating"
		return (
			// A button, not a link: the whole row is already an anchor to the issue,
			// and an <a> inside an <a> is invalid markup that browsers unnest in
			// their own way. `preventDefault` stops the row navigation so the chip
			// can take you to the investigation instead.
			<button
				type="button"
				onClick={(event) => {
					event.preventDefault()
					event.stopPropagation()
					navigate({ to: "/investigations/$id", params: { id: state.investigationId } })
				}}
				className={cn(
					"inline-flex max-w-full items-center gap-1.5 text-[11px] font-medium whitespace-nowrap",
					"text-muted-foreground hover:text-foreground hover:underline",
					"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm",
					className,
				)}
				title={
					state.confidence
						? `Maple ${label.toLowerCase()} — ${state.confidence} confidence`
						: `Maple ${label.toLowerCase()}`
				}
			>
				<span
					className={cn(
						"size-1.5 shrink-0 rounded-full bg-current",
						isLive && "motion-safe:animate-pulse",
					)}
				/>
				<span className={cn("truncate", compact && "hidden @xl/page:inline")}>{label}</span>
				{withConfidence && state.confidence && state.status === "diagnosed" ? (
					<span className="text-muted-foreground/60">· {state.confidence}</span>
				) : null}
			</button>
		)
	}

	return (
		<span
			className={cn(
				"inline-flex max-w-full items-center gap-1.5 text-[11px] whitespace-nowrap text-muted-foreground",
				className,
			)}
			title={`Workflow state: ${WORKFLOW_LABEL[state.state]}`}
		>
			<WorkflowRingIcon state={state.state} size={12} />
			<span className="truncate">{WORKFLOW_LABEL[state.state]}</span>
		</span>
	)
}

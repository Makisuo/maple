import { useNavigate } from "@tanstack/react-router"

import { cn } from "@maple/ui/lib/utils"
import { WORKFLOW_LABEL, WorkflowRingIcon } from "@/components/icons/workflow-ring"
import type { V2Investigation } from "@maple/domain/http/v2"
import type { InvestigationSummary, SignalState } from "@/lib/models/error-signal"

/**
 * The one status slot on the issue header.
 *
 * A header used to be able to carry four of these at once — a workflow badge,
 * an "Open incident" pill, a kind badge, and an investigation that was only
 * visible on a different route. Four badge systems for one object meant none of
 * them read as important. `SignalState` picks one by precedence; this draws it.
 *
 * The list row does NOT use this: its status lane is the workflow picker, and
 * the only other thing it draws is {@link InvestigationChip}, on its own rather
 * than through the precedence. An incident is not worth a mark in a list —
 * "currently firing" is true of nearly every open row at once, so it separated
 * nothing while costing the error message the width.
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
	className,
}: {
	state: SignalState
	/** Inline `· medium` after "Diagnosed". */
	withConfidence?: boolean
	className?: string
}) {
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
				<span className="truncate">Open incident</span>
			</span>
		)
	}

	if (state.kind === "investigation") {
		// `SignalState` names the id `investigationId`; the summary names it `id`.
		return (
			<InvestigationChip
				investigation={{
					id: state.investigationId,
					status: state.status,
					confidence: state.confidence,
				}}
				withConfidence={withConfidence}
				className={className}
			/>
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

/**
 * "Investigating" / "Diagnosed" — Maple is looking at this error, or already
 * has an answer. Takes the investigation itself rather than a `SignalState`, so
 * the list row can draw it without asking whether anything outranks it.
 */
export function InvestigationChip({
	investigation,
	withConfidence = true,
	compact = false,
	className,
}: {
	investigation: InvestigationSummary
	/** Inline `· medium` after "Diagnosed". The list row turns it off — its lane
	 *  cannot fit the suffix on one line, and the tooltip still carries it. */
	withConfidence?: boolean
	/** For the list row, which shares this lane with the error message: below
	 *  `@xl` only the dot, because every character here is one the message loses. */
	compact?: boolean
	className?: string
}) {
	const navigate = useNavigate()
	const label = INVESTIGATION_LABEL[investigation.status]
	const isLive = investigation.status === "investigating"

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
				navigate({ to: "/investigations/$id", params: { id: investigation.id } })
			}}
			className={cn(
				"inline-flex max-w-full items-center gap-1.5 text-[11px] font-medium whitespace-nowrap",
				"text-muted-foreground hover:text-foreground hover:underline",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm",
				className,
			)}
			title={
				investigation.confidence
					? `Maple ${label.toLowerCase()} — ${investigation.confidence} confidence`
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
			{withConfidence && investigation.confidence && investigation.status === "diagnosed" ? (
				<span className="text-muted-foreground/60">· {investigation.confidence}</span>
			) : null}
		</button>
	)
}

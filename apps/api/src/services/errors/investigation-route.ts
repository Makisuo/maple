/**
 * Choose the execution shape from the investigation subject. Incident-backed
 * investigations are planned and fan out; a free-form question is one turn in
 * a continuing conversation.
 */
import type { InvestigationSubject, InvestigationSubjectSnapshot } from "@maple/domain/http"
import { widthFor } from "@/workflows/plan-normalize"

export type InvestigationRoute =
	/** One chat-session turn, and then a conversation. Free-form questions only. */
	| { readonly kind: "single_pass"; readonly reason: "freeform" }
	/** The Cloudflare Workflow: planner → N hypotheses → validator. */
	| {
			readonly kind: "planned"
			/** Ceiling on hypotheses. The planner may return fewer. */
			readonly maxWidth: number
			/**
			 * Passes to reserve against the daily budget: planner + width + validator.
			 *
			 * Reserved *before* the planner runs, because nothing here can know the real
			 * width yet, and reconciled downward by the workflow's `plan` step. Reserving
			 * high is the safe direction — under-reserving lets a burst of incidents run
			 * past the daily cap with nothing recording that it happened.
			 */
			readonly reservedPasses: number
	  }

export interface RouteInvestigationInput {
	readonly subject: InvestigationSubject
	readonly snapshot: InvestigationSubjectSnapshot | null
}

/**
 * Hypotheses a fix verification may dispatch.
 *
 * Narrow, and narrower than any incident: the question is "did this specific
 * merged change stop this specific error", the deterministic occurrence split is
 * already in the snapshot, and the honest answers are few — it holds, it does
 * not, or there was not enough traffic to say. Giving it an incident-sized
 * fan-out would spend a diagnosis budget re-deriving a conclusion the evidence
 * already contains.
 */
export const FIX_VERIFICATION_MAX_WIDTH = 2

export function routeInvestigation(input: RouteInvestigationInput): InvestigationRoute {
	// A free-form question is a conversation, not an incident. There is nothing for
	// the planner to scope and no incident window to establish, and the user is
	// expected to keep talking to it afterwards — which the workflow path cannot do.
	if (input.subject.type === "freeform") return { kind: "single_pass", reason: "freeform" }
	// A verification is planned like an incident — it needs the workflow's
	// retry-safety and its verdict lanes — but capped, for the reason above.
	if (input.subject.type === "fix_verification") {
		return {
			kind: "planned",
			maxWidth: FIX_VERIFICATION_MAX_WIDTH,
			reservedPasses: FIX_VERIFICATION_MAX_WIDTH + 2,
		}
	}
	const maxWidth = widthFor(input.snapshot?.severity ?? null, input.subject.incidentKind)
	return { kind: "planned", maxWidth, reservedPasses: maxWidth + 2 }
}

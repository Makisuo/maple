/**
 * How an investigation runs: one turn of a conversation, or a planner and
 * several agents.
 *
 * This replaced `fanout-policy.ts`, which answered two different questions in
 * one function and got both wrong as a result.
 *
 * The first was *whether* to fan out. It required `ai_triage_settings.fanout_enabled`,
 * a column that defaulted false and had no write path anywhere — no route, no
 * UI, no admin RPC. On top of that it required a severity in `{critical, high}`,
 * while error incidents passed no severity at all and alert severities are a
 * two-value scale that cannot express `high`. Three independent reasons the
 * multi-hypothesis path could never run in production, none of which failed
 * loudly.
 *
 * That question is gone, and deliberately not replaced with a better-behaved
 * flag. An incident investigation is planned; a free-form question is one turn
 * of a conversation the user keeps talking to. Those are two different kinds of
 * work, not two settings — and a toggle over them would mean shipping a product
 * whose good version is the one nobody found the switch for. That is exactly
 * what `fanout_enabled` was.
 *
 * The second question was *how wide*, and that survives — as `widthFor` in
 * `plan-normalize.ts`, where it caps the planner's output rather than gating
 * dispatch. Collapsing the two is what produced the bug where a medium-severity
 * alert computed a width of five and dispatched zero.
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

export function routeInvestigation(input: RouteInvestigationInput): InvestigationRoute {
	// A free-form question is a conversation, not an incident. There is nothing for
	// the planner to scope and no incident window to establish, and the user is
	// expected to keep talking to it afterwards — which the workflow path cannot do.
	if (input.subject.type === "freeform") return { kind: "single_pass", reason: "freeform" }
	const maxWidth = widthFor(input.snapshot?.severity ?? null, input.subject.incidentKind)
	return { kind: "planned", maxWidth, reservedPasses: maxWidth + 2 }
}

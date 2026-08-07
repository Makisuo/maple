/**
 * Pure derivations over the real `lens_runs` array.
 *
 * These are what survived `fanout-placeholder.ts`: the tally, the run-spine
 * segment and the checks panel were always derivations, they just used to derive
 * from invented data. Nothing here invents anything — every value traces back to
 * a lens row the workflow wrote.
 */
import type { V2Investigation } from "@maple/domain/http/v2"
import { lensCopy } from "./lens-catalogue"

export type LensRun = V2Investigation["lens_runs"][number]

/**
 * Did this run fan out?
 *
 * Keyed off dispatched lenses, NOT off `fanout.size`. The sizing table and the
 * routing gate are different questions: an automatic medium-severity alert
 * computes a size of 5 and still runs single-pass, and reading the size here
 * would render a Hypotheses tab over an empty array.
 */
export const hasFanout = (investigation: V2Investigation): boolean => investigation.lens_runs.length > 0

export interface LensTally {
	readonly total: number
	/** Lenses that put a candidate forward. A `no_finding` lane is NOT one. */
	readonly reported: number
	/**
	 * Lenses that will not change again — reported *or* no_finding.
	 *
	 * This, not `reported`, is what "is the fan-out still running?" means. A lens
	 * that crashed is terminal: the workflow turns it into a `no_finding` lane and
	 * proceeds to validate. Gating progress on `reported` wedges the run spine on
	 * "4 of 5 reported" forever while the board shows a validated diagnosis.
	 */
	readonly settled: number
	readonly promoted: number
	readonly merged: number
	readonly ruledOut: number
	readonly rejected: number
}

export const lensTally = (lenses: ReadonlyArray<LensRun>): LensTally => ({
	total: lenses.length,
	reported: lenses.filter((lens) => lens.status === "reported").length,
	settled: lenses.filter((lens) => lens.status === "reported" || lens.status === "no_finding").length,
	promoted: lenses.filter((lens) => lens.verdict === "promoted").length,
	merged: lenses.filter((lens) => lens.verdict === "merged").length,
	ruledOut: lenses.filter((lens) => lens.verdict === "ruled_out").length,
	rejected: lenses.filter((lens) => lens.verdict === "rejected").length,
})

/* -------------------------------------------------------------------------------------------------
 * Checks
 * -----------------------------------------------------------------------------------------------*/

/**
 * `pending` is a lens that reported but has not been ranked yet. It is NOT
 * `failed`: rendering an un-ranked candidate as "Did not hold" tells the reader
 * the validator ruled against it while the validator is still reading it.
 */
export type CheckState = "held" | "failed" | "pending" | "checking" | "queued" | "skipped"

export interface LensCheck {
	readonly key: string
	readonly label: string
	/** The terse result line under the label — the whole point of the panel. */
	readonly result: string
	readonly state: CheckState
}

/**
 * The rail's lead: one line per dispatched lens.
 *
 * Derived from the lanes rather than generated alongside them, which is what
 * keeps the rail and the board from disagreeing — a validator that rejected
 * everything cannot leave three green ticks standing 300px away from "none of
 * them held up". The result line is the validator's own sentence where there is
 * one, so the panel quotes the run instead of paraphrasing it.
 */
export const lensChecks = (lenses: ReadonlyArray<LensRun>): ReadonlyArray<LensCheck> =>
	lenses.map((lens) => {
		const label = lensCopy(lens).checkLabel
		const base = { key: lens.lensId, label }
		switch (lens.status) {
			case "checking":
				return { ...base, result: lens.progressNote ?? "checking…", state: "checking" as const }
			case "queued":
				return { ...base, result: "queued", state: "queued" as const }
			case "no_finding":
				return {
					...base,
					result: lens.reason ?? "not checked — the lens reached no finding",
					state: "skipped" as const,
				}
			default: {
				if (lens.verdict === "pending") {
					return {
						...base,
						result: lens.claim ?? "reported — awaiting the validator",
						state: "pending" as const,
					}
				}
				const held = lens.verdict === "promoted" || lens.verdict === "merged"
				return {
					...base,
					// A failed check is a finding, not a gap: "callee percentiles flat"
					// is exactly what rules the obvious alternative out.
					result: lens.reason ?? lens.claim ?? (held ? "held" : "did not hold"),
					state: held ? ("held" as const) : ("failed" as const),
				}
			}
		}
	})

export const checksHeld = (checks: ReadonlyArray<LensCheck>): number =>
	checks.filter((check) => check.state === "held").length

/* -------------------------------------------------------------------------------------------------
 * Run spine — fan-out segment
 * -----------------------------------------------------------------------------------------------*/

export interface RunStep {
	readonly key: string
	readonly label: string
	readonly detail: string
	readonly tone: "muted" | "active" | "success" | "failed"
}

/**
 * The steps between "Opened" and the run's terminal node. The rail still owns
 * the endpoints — those come from real timestamps — and this fills the middle.
 * Empty on the single-pass path, where there is no fan-out to describe.
 */
export const fanoutRunSteps = (investigation: V2Investigation): ReadonlyArray<RunStep> => {
	const lenses = investigation.lens_runs
	if (lenses.length === 0) return []
	const tally = lensTally(lenses)
	const validator = investigation.validator

	const steps: Array<RunStep> = [
		{
			key: "dispatched",
			label: `Dispatched ${tally.total} lenses`,
			detail: investigation.fanout.state === "none" ? "" : "Each works one angle in parallel",
			tone: "muted",
		},
	]

	if (tally.settled < tally.total) {
		steps.push({
			key: "reporting",
			label: `${tally.settled} of ${tally.total} reported`,
			detail: validator?.note ?? "Validation blocked until every lens reports",
			tone: "active",
		})
		return steps
	}

	steps.push({
		key: "reported",
		label: `All ${tally.total} reported`,
		detail: "",
		tone: "muted",
	})

	if (validator?.status === "ranked") {
		steps.push({ key: "validated", label: "Validated", detail: validator.note, tone: "success" })
	} else if (validator?.status === "rejected_all") {
		steps.push({
			key: "validation-inconclusive",
			label: "Validation inconclusive",
			detail: validator.note,
			tone: "failed",
		})
	}
	return steps
}

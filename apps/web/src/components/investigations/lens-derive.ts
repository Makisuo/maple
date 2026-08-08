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
 * Lens nodes — the provenance canvas's fan
 * -----------------------------------------------------------------------------------------------*/

export type LensTone = "muted" | "primary" | "success" | "info" | "warning" | "destructive"
export type LensIcon = "pending" | "running" | "confirmed" | "ruledOut" | "deadline" | "failed"

export interface LensNodeState {
	/** Always present. The word carries the state; colour only reinforces it. */
	readonly word: string
	readonly tone: LensTone
	readonly icon: LensIcon
	/** A ruled-out lane strikes its title — the claim was considered and rejected. */
	readonly struck: boolean
	/** A queued lane hasn't started, so its border is dashed rather than solid. */
	readonly dashed: boolean
}

/**
 * The same status/verdict switch `lensChecks` walks, resolved to a node's badge
 * instead of a rail row.
 *
 * It lives beside `lensChecks` rather than in the canvas for the reason that
 * function exists at all: the fan and the checks rail describe the same lanes
 * 600px apart, and two independent mappings are how you end up with a green tick
 * next to a node reading "ruled out".
 */
export const lensNodeState = (lens: LensRun): LensNodeState => {
	const base = { struck: false, dashed: false }
	switch (lens.status) {
		case "queued":
			return { ...base, word: "PENDING", tone: "muted", icon: "pending", dashed: true }
		case "checking":
			return { ...base, word: "RUNNING", tone: "primary", icon: "running" }
		default: {
			// A lane that ran out of clock says so before it says anything about a
			// verdict — "ruled out" on a lane that never finished is a claim the run
			// did not make.
			if (lens.deadlineHit) {
				return { ...base, word: "DEADLINE HIT", tone: "warning", icon: "deadline" }
			}
			if (lens.status === "no_finding") {
				return { ...base, word: "NO FINDING", tone: "muted", icon: "failed" }
			}
			if (lens.verdict === "pending") {
				return { ...base, word: "REPORTED", tone: "muted", icon: "pending" }
			}
			if (lens.verdict === "promoted") {
				return { ...base, word: "CONFIRMED", tone: "success", icon: "confirmed" }
			}
			if (lens.verdict === "merged") {
				return { ...base, word: "MERGED", tone: "info", icon: "confirmed" }
			}
			return { ...base, word: "RULED OUT", tone: "muted", icon: "ruledOut", struck: true }
		}
	}
}

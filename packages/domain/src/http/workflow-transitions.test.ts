import { describe, expect, it } from "vitest"
import {
	MACHINE_OWNED_WORKFLOW_STATES,
	CLOSED_WORKFLOW_STATES,
	WORKFLOW_STATE_ORDER,
	WORKFLOW_TRANSITIONS,
	allowedTransitionsForAll,
	canReachInReview,
	fixProposalRoute,
	WorkflowState,
	describeWorkflowTransitions,
} from "./errors"

const ALL_STATES = WorkflowState.literals

describe("WORKFLOW_TRANSITIONS", () => {
	it("covers every workflow state as a source", () => {
		expect(Object.keys(WORKFLOW_TRANSITIONS).sort()).toEqual([...ALL_STATES].sort())
	})

	it("only ever targets real workflow states", () => {
		for (const [from, targets] of Object.entries(WORKFLOW_TRANSITIONS)) {
			for (const to of targets) {
				expect(ALL_STATES, `${from}→${to}`).toContain(to)
			}
		}
	})

	it("never lets a state transition to itself", () => {
		for (const [from, targets] of Object.entries(WORKFLOW_TRANSITIONS)) {
			expect(targets, from).not.toContain(from)
		}
	})

	it("keeps cancelled terminal", () => {
		expect(WORKFLOW_TRANSITIONS.cancelled).toEqual([])
	})

	it("lets every actionable state reach done", () => {
		// The issue hub creates alert- and integration-kind issues in `triage` and
		// never advances them through review; requiring `in_review` first left them
		// permanently un-retirable.
		for (const from of ["triage", "todo", "in_progress", "in_review"] as const) {
			expect(WORKFLOW_TRANSITIONS[from], from).toContain("done")
		}
	})

	it("keeps done reopenable so the regression path still works", () => {
		// The errors tick transitions done→triage when a resolved issue recurs.
		expect(WORKFLOW_TRANSITIONS.done).toContain("triage")
	})

	it("keeps wontfix wakeable so snooze expiry still works", () => {
		expect(WORKFLOW_TRANSITIONS.wontfix).toContain("triage")
	})

	it("treats done and cancelled as closed — the states that end the work and drop the lease", () => {
		// `done` is closed but NOT a dead end: it reopens to `regressed`,
		// `verifying` and `triage`. `cancelled` is the only real dead end.
		expect([...CLOSED_WORKFLOW_STATES].sort()).toEqual(["cancelled", "done"])
		expect(WORKFLOW_TRANSITIONS.done.length).toBeGreaterThan(0)
	})
})

describe("fixProposalRoute", () => {
	it("reaches in_review from every state an issue can be worked from", () => {
		// The regression this exists for: `propose_fix` on a `triage` issue used to
		// fail with "Illegal transition from 'triage' to 'in_review'" AFTER it had
		// already written the fix_proposed event and linked the PR.
		for (const from of ["triage", "regressed", "todo", "in_progress", "verifying", "done"] as const) {
			expect(canReachInReview(from), from).toBe(true)
		}
	})

	it("walks a route the matrix actually permits, hop by hop", () => {
		for (const from of ALL_STATES) {
			let at: WorkflowState = from
			for (const hop of fixProposalRoute(from)) {
				expect(WORKFLOW_TRANSITIONS[at], `${from}: ${at}→${hop}`).toContain(hop)
				at = hop
			}
			if (canReachInReview(from)) expect(at, from).toBe("in_review")
		}
	})

	it("is a no-op for an issue already in review", () => {
		expect(fixProposalRoute("in_review")).toEqual([])
		expect(canReachInReview("in_review")).toBe(true)
	})

	it("reports the dead ends rather than routing through them", () => {
		// `cancelled` has no moves at all; `wontfix` only wakes to `triage`. Both
		// must be refused up front, not discovered mid-write.
		expect(canReachInReview("cancelled")).toBe(false)
		expect(canReachInReview("wontfix")).toBe(false)
	})
})

describe("describeWorkflowTransitions", () => {
	it("renders every source that has targets, and omits the dead ends", () => {
		const description = describeWorkflowTransitions()
		expect(description).toContain("triage→(todo|in_progress|done|cancelled|wontfix)")
		expect(description).toContain("wontfix→(triage|cancelled)")
		// `cancelled` has no legal moves, so listing it would only mislead the model.
		expect(description).not.toContain("cancelled→")
	})

	it("never advertises a target the transition tool would reject", () => {
		// `done→verifying` and `done→regressed` are legal edges the ticks travel,
		// but no caller may ask for them. Advertising them told an agent to make a
		// call that could only come back a validation error.
		// Only as TARGETS. They stay as sources — an agent handed an issue already
		// sitting in `regressed` or `verifying` still needs to know its moves.
		const description = describeWorkflowTransitions()
		for (const [, targets] of description.matchAll(/→\(([^)]+)\)/g)) {
			for (const target of targets.split("|")) {
				expect([...MACHINE_OWNED_WORKFLOW_STATES], target).not.toContain(target)
			}
		}
		expect(description).toContain("done→(triage|in_progress|cancelled|wontfix)")
	})
})

describe("allowedTransitionsForAll", () => {
	it("offers the matrix row for a single issue in each state, less machine-owned targets", () => {
		for (const state of ALL_STATES) {
			expect(allowedTransitionsForAll([state]), state).toEqual(
				WORKFLOW_STATE_ORDER.filter(
					(target) =>
						!MACHINE_OWNED_WORKFLOW_STATES.has(target) &&
						WORKFLOW_TRANSITIONS[state].includes(target),
				),
			)
		}
	})

	it("never offers a machine-owned state, even where the matrix allows it", () => {
		// `done -> regressed` is a legal edge because the errors tick travels it,
		// but it records an observation about which build fired. A human choosing
		// it from a menu would be asserting that, and the next tick would overwrite
		// the claim anyway.
		expect(WORKFLOW_TRANSITIONS.done).toContain("regressed")
		// Named literally rather than derived from MACHINE_OWNED_WORKFLOW_STATES: a
		// test that filters by the same set the implementation filters by passes no
		// matter what the set contains, so dropping a state from it would be
		// invisible here — and the state would start appearing in the web state
		// picker and the MCP transition tool.
		const machineOwned = ["regressed", "verifying"] as const
		expect([...MACHINE_OWNED_WORKFLOW_STATES].sort()).toEqual([...machineOwned].sort())
		for (const state of ALL_STATES) {
			for (const target of machineOwned) {
				expect(allowedTransitionsForAll([state]), state).not.toContain(target)
			}
		}
	})

	it("offers nothing for an issue in a state with no outgoing moves", () => {
		expect(allowedTransitionsForAll(["cancelled"])).toEqual([])
	})

	it("returns the intersection for a mixed selection", () => {
		// triage: todo, in_progress, done, cancelled, wontfix
		// in_review: triage, in_progress, done, cancelled, wontfix
		expect(allowedTransitionsForAll(["triage", "in_review"])).toEqual([
			"in_progress",
			"done",
			"cancelled",
			"wontfix",
		])
	})

	it("returns nothing when a mixed selection has an empty intersection", () => {
		// One dead-end issue kills the whole selection's options: every other
		// row still allows `cancelled`, so `cancelled`'s empty row is the only
		// thing that can empty an intersection.
		expect(allowedTransitionsForAll(["triage", "todo", "cancelled"])).toEqual([])
		expect(allowedTransitionsForAll(["cancelled", "wontfix"])).toEqual([])
	})

	it("narrows a mixed selection to the one move a dissimilar pair shares", () => {
		// `wontfix` only reaches triage/cancelled; `triage` reaches neither
		// triage nor itself, leaving `cancelled` as the single common move.
		expect(allowedTransitionsForAll(["triage", "wontfix"])).toEqual(["cancelled"])
	})

	it("returns nothing for an empty selection", () => {
		expect(allowedTransitionsForAll([])).toEqual([])
	})

	it("never offers a move the matrix rejects for any selected state", () => {
		for (const a of ALL_STATES) {
			for (const b of ALL_STATES) {
				for (const target of allowedTransitionsForAll([a, b])) {
					expect(WORKFLOW_TRANSITIONS[a], `${a}→${target}`).toContain(target)
					expect(WORKFLOW_TRANSITIONS[b], `${b}→${target}`).toContain(target)
				}
			}
		}
	})

	it("orders results canonically regardless of input order", () => {
		expect(allowedTransitionsForAll(["in_review", "triage"])).toEqual(
			allowedTransitionsForAll(["triage", "in_review"]),
		)
	})
})

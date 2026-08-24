import { describe, expect, it } from "vitest"
import {
	MACHINE_OWNED_WORKFLOW_STATES,
	TERMINAL_WORKFLOW_STATES,
	WORKFLOW_STATE_ORDER,
	WORKFLOW_TRANSITIONS,
	allowedTransitionsForAll,
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

	it("marks exactly the states with no outbound moves plus done as terminal", () => {
		expect([...TERMINAL_WORKFLOW_STATES].sort()).toEqual(["cancelled", "done"])
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

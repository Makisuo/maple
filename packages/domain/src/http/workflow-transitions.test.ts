import { describe, expect, it } from "vitest"
import {
	TERMINAL_WORKFLOW_STATES,
	WORKFLOW_TRANSITIONS,
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

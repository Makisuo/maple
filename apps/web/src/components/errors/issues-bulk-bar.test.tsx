// @vitest-environment jsdom

import type { ErrorIssueId, WorkflowState } from "@maple/domain/http"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { IssuesBulkBar } from "./issues-bulk-bar"
import type { IssueMutations } from "./use-issue-mutations"

afterEach(cleanup)

const mutations = (): IssueMutations => ({
	transitionTo: vi.fn(),
	transitionMany: vi.fn(),
	claimIssue: vi.fn(),
	claimMany: vi.fn(),
	releaseIssue: vi.fn(),
	setSeverity: vi.fn(),
	setSeverityMany: vi.fn(),
})

const issue = (id: string, state: WorkflowState) => ({ id: id as ErrorIssueId, state })

const renderBar = (overrides: Partial<React.ComponentProps<typeof IssuesBulkBar>> = {}) => {
	const props = {
		selected: [issue("issue-1", "triage")],
		mutations: mutations(),
		onClear: vi.fn(),
		...overrides,
	}
	render(<IssuesBulkBar {...props} />)
	return props
}

// Both menus put a DropdownMenuLabel straight into the popup. That is Base UI's
// GroupLabel, which throws `MenuGroupContext is missing` outside a Group — a
// full page crash that only opening the menu reproduces.
describe("IssuesBulkBar menus open without throwing", () => {
	it("opens the severity menu with its label and options", () => {
		renderBar()
		fireEvent.click(screen.getByRole("button", { name: "Severity" }))

		expect(screen.getByText("Set severity")).toBeDefined()
		expect(screen.getByRole("menuitem", { name: "critical" })).toBeDefined()
		expect(screen.getByRole("menuitem", { name: "Clear severity" })).toBeDefined()
	})

	it("opens the move-to menu with its label and states", () => {
		renderBar()
		fireEvent.click(screen.getByRole("button", { name: "Move to" }))

		expect(screen.getByText("Move to state")).toBeDefined()
		expect(screen.getByRole("menuitem", { name: "Todo" })).toBeDefined()
	})

	it("applies a severity to every selected issue", () => {
		const props = renderBar({ selected: [issue("a", "triage"), issue("b", "todo")] })
		fireEvent.click(screen.getByRole("button", { name: "Severity" }))
		fireEvent.click(screen.getByRole("menuitem", { name: "critical" }))

		expect(props.mutations.setSeverityMany).toHaveBeenCalledWith(["a", "b"], "critical")
		expect(props.onClear).toHaveBeenCalled()
	})

	it("renders nothing with an empty selection", () => {
		const { container } = render(
			<IssuesBulkBar selected={[]} mutations={mutations()} onClear={vi.fn()} />,
		)
		expect(container.firstChild).toBeNull()
	})
})

// The offered moves come from WORKFLOW_TRANSITIONS, so the bar can never
// present a bulk transition the API would reject for part of the selection.
describe("IssuesBulkBar move-to menu follows the transition matrix", () => {
	const openMoveTo = () => fireEvent.click(screen.getByRole("button", { name: "Move to" }))
	const moveItems = () => screen.getAllByRole("menuitem").map((item) => item.textContent?.trim() ?? "")

	it("offers exactly the legal targets for a single triage issue", () => {
		renderBar({ selected: [issue("a", "triage")] })
		openMoveTo()

		expect(moveItems()).toEqual(["Todo", "In progress", "Done", "Cancelled", "Won't fix"])
	})

	it("offers exactly the legal targets for a single done issue", () => {
		renderBar({ selected: [issue("a", "done")] })
		openMoveTo()

		// `Regressed` is absent even though `done -> regressed` is a legal edge: the
		// errors tick sets it from which build fired, so it is not a human choice.
		expect(moveItems()).toEqual(["Triage", "In progress", "Cancelled", "Won't fix"])
	})

	it("offers nothing for an issue in a state with no outgoing moves", () => {
		renderBar({ selected: [issue("a", "cancelled")] })
		openMoveTo()

		expect(moveItems()).toEqual(["No moves from Cancelled"])
		expect(
			screen.getByRole("menuitem", { name: "No moves from Cancelled" }).getAttribute("data-disabled"),
		).not.toBeNull()
	})

	it("offers the intersection for a mixed selection", () => {
		renderBar({ selected: [issue("a", "triage"), issue("b", "in_review")] })
		openMoveTo()

		expect(moveItems()).toEqual(["In progress", "Done", "Cancelled", "Won't fix"])
	})

	it("explains a mixed selection whose intersection is empty", () => {
		renderBar({ selected: [issue("a", "triage"), issue("b", "cancelled")] })
		openMoveTo()

		expect(moveItems()).toEqual(["No move applies to every selected issue"])
	})

	it("transitions every selected id when a legal target is chosen", () => {
		const props = renderBar({ selected: [issue("a", "triage"), issue("b", "todo")] })
		openMoveTo()
		fireEvent.click(screen.getByRole("menuitem", { name: "In progress" }))

		expect(props.mutations.transitionMany).toHaveBeenCalledWith(["a", "b"], "in_progress")
		expect(props.onClear).toHaveBeenCalled()
	})
})

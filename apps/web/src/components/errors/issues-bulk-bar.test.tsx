// @vitest-environment jsdom

import type { ErrorIssueId } from "@maple/domain/http"
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

const renderBar = (overrides: Partial<React.ComponentProps<typeof IssuesBulkBar>> = {}) => {
	const props = {
		selectedIds: ["issue-1" as ErrorIssueId],
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
		expect(screen.getByRole("menuitem", { name: "Triage" })).toBeDefined()
	})

	it("applies a severity to every selected issue", () => {
		const props = renderBar({ selectedIds: ["a", "b"] as ErrorIssueId[] })
		fireEvent.click(screen.getByRole("button", { name: "Severity" }))
		fireEvent.click(screen.getByRole("menuitem", { name: "critical" }))

		expect(props.mutations.setSeverityMany).toHaveBeenCalledWith(["a", "b"], "critical")
		expect(props.onClear).toHaveBeenCalled()
	})

	it("renders nothing with an empty selection", () => {
		const { container } = render(
			<IssuesBulkBar selectedIds={[]} mutations={mutations()} onClear={vi.fn()} />,
		)
		expect(container.firstChild).toBeNull()
	})
})

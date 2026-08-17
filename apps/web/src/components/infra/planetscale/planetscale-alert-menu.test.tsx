// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const navigate = vi.fn()
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }))

import { PlanetScaleAlertMenu } from "./planetscale-alert-menu"
import { planetScaleAlertSuggestions } from "./planetscale-alert-suggestions"

afterEach(() => {
	cleanup()
	navigate.mockReset()
})

// Opening the menu used to crash the page: DropdownMenuLabel is Base UI's
// GroupLabel and throws `MenuGroupContext is missing` outside a Group. Nothing
// short of a render catches that.
describe("PlanetScaleAlertMenu", () => {
	const open = () => {
		render(<PlanetScaleAlertMenu database="checkout" kind="postgresql" />)
		fireEvent.click(screen.getByRole("button", { name: /Alert on this/ }))
	}

	it("opens with its label and every suggestion", () => {
		open()

		expect(screen.getByText("Create an alert rule")).toBeDefined()
		for (const suggestion of planetScaleAlertSuggestions({
			database: "checkout",
			kind: "postgresql",
		})) {
			expect(screen.getByText(suggestion.title)).toBeDefined()
		}
	})

	it("navigates to the alert form with a prefilled chart param", () => {
		open()
		const [first] = planetScaleAlertSuggestions({ database: "checkout", kind: "postgresql" })
		fireEvent.click(screen.getByText(first!.title))

		expect(navigate).toHaveBeenCalledTimes(1)
		const arg = navigate.mock.calls[0]![0] as { to: string; search: { chart?: string } }
		expect(arg.to).toBe("/alerts/create")
		expect(arg.search.chart).toBeTruthy()
	})

	it("disables itself with the reason instead of opening", () => {
		render(<PlanetScaleAlertMenu database="checkout" kind="postgresql" disabledReason="No metrics yet" />)

		expect(screen.getByRole("button", { name: /Alert on this/ }).hasAttribute("disabled")).toBe(true)
	})
})

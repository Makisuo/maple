// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RefreshIntervalPicker } from "./refresh-interval-picker"

afterEach(cleanup)

const openMenu = () => fireEvent.click(screen.getByRole("button"))

describe("RefreshIntervalPicker", () => {
	// The trigger sits beside a time-range picker that also carries a clock-ish
	// icon, so an icon-only control read as a second time-range control. The word
	// is what makes it legible; if it goes, the ambiguity comes back.
	it("names itself in the trigger whether on or off", () => {
		const { rerender } = render(<RefreshIntervalPicker value={0} onChange={() => {}} />)
		expect(screen.getByRole("button").textContent).toContain("Auto")
		expect(screen.getByRole("button", { name: "Auto-refresh off" })).toBeDefined()

		rerender(<RefreshIntervalPicker value={30} onChange={() => {}} />)
		expect(screen.getByRole("button").textContent).toContain("30s")
		expect(screen.getByRole("button", { name: "Auto-refresh every 30s" })).toBeDefined()
	})

	// Base UI's GroupLabel throws production error #31 outside a Group, which is a
	// full error-boundary crash rather than a warning — and only opening the menu
	// exercises it. A type check would not catch this.
	it("opens without throwing and names the group", () => {
		render(<RefreshIntervalPicker value={0} onChange={() => {}} />)

		openMenu()
		expect(screen.getByText("Auto-refresh")).toBeDefined()
		expect(screen.getByRole("menuitemradio", { name: "Off" })).toBeDefined()
		expect(screen.getByRole("menuitemradio", { name: "15m" })).toBeDefined()
	})

	// The URL and the document both hold numbers; the radio group only speaks
	// strings, so this is the seam where a stray string would leak outward.
	it("reports the chosen cadence as a number", () => {
		const onChange = vi.fn()
		render(<RefreshIntervalPicker value={0} onChange={onChange} />)

		openMenu()
		fireEvent.click(screen.getByRole("menuitemradio", { name: "5s" }))
		expect(onChange).toHaveBeenCalledWith(5)
	})

	it("marks the board's saved cadence so a `?refresh=` override stays legible", () => {
		render(<RefreshIntervalPicker value={5} onChange={() => {}} savedDefault={60} />)

		openMenu()
		expect(screen.getByRole("menuitemradio", { name: /1m\s*default/ })).toBeDefined()
		expect(screen.getByRole("menuitemradio", { name: "5s" }).getAttribute("aria-checked")).toBe("true")
	})
})

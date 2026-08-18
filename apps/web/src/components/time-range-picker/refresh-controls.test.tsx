// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RefreshControls } from "./refresh-controls"

afterEach(cleanup)

const cadenceTrigger = () => screen.getByRole("button", { name: /Auto-refresh/ })
const openMenu = () => fireEvent.click(cadenceTrigger())

describe("RefreshControls", () => {
	// The two halves are one split button: reload now on the left, reload every N
	// on the right. Standalone, the cadence half read as a second time-range
	// control next to the real one — attached to "Reload" it can only mean one
	// thing, which is the entire reason this is one component.
	it("pairs a reload action with the cadence it repeats at", () => {
		const onReload = vi.fn()
		render(<RefreshControls onReload={onReload} value={30} onChange={() => {}} />)

		fireEvent.click(screen.getByRole("button", { name: "Reload" }))
		expect(onReload).toHaveBeenCalledTimes(1)
		expect(cadenceTrigger().textContent).toContain("30s")
	})

	it("says so when auto-refresh is off rather than going blank", () => {
		render(<RefreshControls onReload={() => {}} value={0} onChange={() => {}} />)

		expect(screen.getByRole("button", { name: "Auto-refresh off" }).textContent).toContain("Off")
	})

	// A reload already in flight must not be re-triggered by an impatient click.
	it("disables reload while one is in flight", () => {
		const onReload = vi.fn()
		render(<RefreshControls onReload={onReload} isReloading value={0} onChange={() => {}} />)

		fireEvent.click(screen.getByRole("button", { name: "Reload" }))
		expect(onReload).not.toHaveBeenCalled()
	})

	// Base UI's GroupLabel throws production error #31 outside a Group, which is a
	// full error-boundary crash rather than a warning — and only reachable by
	// actually opening the menu. A type check would not catch this.
	it("opens without throwing and names the group", () => {
		render(<RefreshControls onReload={() => {}} value={0} onChange={() => {}} />)

		openMenu()
		expect(screen.getByText("Auto-refresh")).toBeDefined()
		expect(screen.getByRole("menuitemradio", { name: "Off" })).toBeDefined()
		expect(screen.getByRole("menuitemradio", { name: "15m" })).toBeDefined()
	})

	// The URL and the document both hold numbers; the radio group only speaks
	// strings, so this is the seam where a stray string would leak outward.
	it("reports the chosen cadence as a number", () => {
		const onChange = vi.fn()
		render(<RefreshControls onReload={() => {}} value={0} onChange={onChange} />)

		openMenu()
		fireEvent.click(screen.getByRole("menuitemradio", { name: "5s" }))
		expect(onChange).toHaveBeenCalledWith(5)
	})

	it("marks the board's saved cadence so a `?refresh=` override stays legible", () => {
		render(<RefreshControls onReload={() => {}} value={5} onChange={() => {}} savedDefault={60} />)

		openMenu()
		expect(screen.getByRole("menuitemradio", { name: /1m\s*default/ })).toBeDefined()
		expect(screen.getByRole("menuitemradio", { name: "5s" }).getAttribute("aria-checked")).toBe("true")
	})
})

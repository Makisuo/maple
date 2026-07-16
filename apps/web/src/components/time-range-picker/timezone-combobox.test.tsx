// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const setSelectedTimezone = vi.fn()

// Control the preference hook so we can assert the setter and supply a small,
// deterministic zone list (real `Intl.supportedValuesOf` has ~420 entries).
vi.mock("@/hooks/use-timezone-preference", () => ({
	useTimezonePreference: () => ({
		supportedTimezones: [
			"UTC",
			"Europe/Berlin",
			"America/New_York",
			"Asia/Kolkata",
			"Pacific/Honolulu",
		],
		selectedTimezone: null,
		effectiveTimezone: "Europe/Berlin",
		setSelectedTimezone,
	}),
}))

import { TimezoneCombobox } from "./timezone-combobox"

async function openList() {
	fireEvent.click(screen.getByText("Timezone"))
	// The search input lives inside the popup once it renders.
	await screen.findByPlaceholderText(/Search city or offset/i)
}

function typeSearch(query: string) {
	fireEvent.change(screen.getByPlaceholderText(/Search city or offset/i), {
		target: { value: query },
	})
}

/**
 * The concrete-zone option for `iana` (excludes the pinned "System" row, whose
 * hint echoes the browser zone and would otherwise collide on Berlin machines).
 */
function zoneOption(iana: string): HTMLElement | undefined {
	return screen
		.queryAllByRole("option")
		.find((option) => option.textContent?.includes(iana) && !option.textContent?.includes("System"))
}

describe("TimezoneCombobox", () => {
	beforeEach(() => {
		setSelectedTimezone.mockClear()
		// Pin to summer so Berlin resolves to +02:00 (its "+2" offset synonym).
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(new Date("2024-07-01T12:00:00Z"))
	})

	afterEach(() => {
		vi.useRealTimers()
		cleanup()
	})

	it("finds Europe/Berlin by city name", async () => {
		render(<TimezoneCombobox />)
		await openList()

		typeSearch("berlin")

		await waitFor(() => {
			expect(zoneOption("Europe/Berlin")).toBeTruthy()
		})
		expect(zoneOption("America/New_York")).toBeUndefined()
	})

	it("finds Europe/Berlin by offset synonym (+2)", async () => {
		render(<TimezoneCombobox />)
		await openList()

		typeSearch("+2")

		await waitFor(() => {
			expect(zoneOption("Europe/Berlin")).toBeTruthy()
		})
		// Kolkata (+5:30) and New York (-4) must not match "+2".
		expect(zoneOption("Asia/Kolkata")).toBeUndefined()
		expect(zoneOption("America/New_York")).toBeUndefined()
	})

	it("pins System first and UTC second", async () => {
		render(<TimezoneCombobox />)
		await openList()

		const options = screen.getAllByRole("option")
		expect(within(options[0]).getByText("System")).toBeTruthy()
		expect(within(options[1]).getByText("UTC")).toBeTruthy()
	})

	it("maps the System row to null", async () => {
		render(<TimezoneCombobox />)
		await openList()

		fireEvent.click(screen.getByText("System"))

		expect(setSelectedTimezone).toHaveBeenCalledWith(null)
	})

	it("selects a concrete zone by its IANA id", async () => {
		render(<TimezoneCombobox />)
		await openList()

		typeSearch("berlin")
		await waitFor(() => expect(zoneOption("Europe/Berlin")).toBeTruthy())
		fireEvent.click(zoneOption("Europe/Berlin")!)

		expect(setSelectedTimezone).toHaveBeenCalledWith("Europe/Berlin")
	})
})

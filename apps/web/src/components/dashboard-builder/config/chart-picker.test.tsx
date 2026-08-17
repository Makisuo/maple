// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { WidgetPicker } from "./chart-picker"

beforeAll(() => {
	// Picker tiles mount real chart renderers, which measure themselves.
	class noop {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	vi.stubGlobal("ResizeObserver", noop)
})

afterEach(cleanup)

// One card per section shape: a chart style (built here from a fresh query
// draft) and a preset (taken from a widget type's `presets`).
const CARDS = ["Bar Chart", "Total Traces"]

/**
 * Cards are matched by button role, not by text.
 *
 * A tile renders its own preview, and a preset's preview draws the preset's
 * `display.title` — which is the same string as its name. Matching on text
 * therefore finds several nodes inside one card, and `getAllByText(...)[0]`
 * only kept working because they all sit inside the same `<button>`. Matching
 * the button directly means a failure here is a real regression rather than a
 * change in how many times the label happens to appear.
 */
const card = (label: string) => screen.getByRole("button", { name: new RegExp(label) })

describe("WidgetPicker", () => {
	for (const label of CARDS) {
		it(`offers "${label}" to the dashboard`, () => {
			const onSelect = vi.fn().mockReturnValue({ id: "widget-1" })
			render(<WidgetPicker open onOpenChange={vi.fn()} onSelect={onSelect} />)

			fireEvent.click(card(label))

			expect(onSelect).toHaveBeenCalledOnce()
		})
	}

	it("closes once the widget has been added", () => {
		const onOpenChange = vi.fn()
		render(<WidgetPicker open onOpenChange={onOpenChange} onSelect={() => ({ id: "widget-1" })} />)

		fireEvent.click(card("Bar Chart"))

		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it("stays open when the add is refused", () => {
		// The reported bug: the dialog dismissed itself whatever happened, so a
		// refused add was indistinguishable from a dead click. The caller reports
		// the reason (a toast); the dialog's job is to not pretend it worked.
		const onOpenChange = vi.fn()
		render(<WidgetPicker open onOpenChange={onOpenChange} onSelect={() => undefined} />)

		fireEvent.click(card("Bar Chart"))

		expect(onOpenChange).not.toHaveBeenCalled()
	})
})

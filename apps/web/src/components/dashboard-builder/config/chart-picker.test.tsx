// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { WidgetPicker } from "./chart-picker"

afterEach(cleanup)

// One card per section shape: a chart style (built here from a fresh query
// draft) and a preset (taken from a widget type's `presets`).
const CARDS = ["Bar Chart", "Total Traces"]

describe("WidgetPicker", () => {
	for (const label of CARDS) {
		it(`offers "${label}" to the dashboard`, () => {
			const onSelect = vi.fn().mockReturnValue({ id: "widget-1" })
			render(<WidgetPicker open onOpenChange={vi.fn()} onSelect={onSelect} />)

			fireEvent.click(screen.getAllByText(label)[0]!)

			expect(onSelect).toHaveBeenCalledOnce()
		})
	}

	it("closes once the widget has been added", () => {
		const onOpenChange = vi.fn()
		render(<WidgetPicker open onOpenChange={onOpenChange} onSelect={() => ({ id: "widget-1" })} />)

		fireEvent.click(screen.getAllByText("Bar Chart")[0]!)

		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it("stays open when the add is refused", () => {
		// The reported bug: the dialog dismissed itself whatever happened, so a
		// refused add was indistinguishable from a dead click. The caller reports
		// the reason (a toast); the dialog's job is to not pretend it worked.
		const onOpenChange = vi.fn()
		render(<WidgetPicker open onOpenChange={onOpenChange} onSelect={() => undefined} />)

		fireEvent.click(screen.getAllByText("Bar Chart")[0]!)

		expect(onOpenChange).not.toHaveBeenCalled()
	})
})

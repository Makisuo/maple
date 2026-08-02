// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { normalizeTags, TagEditorDialog } from "./tag-editor"

afterEach(cleanup)

describe("normalizeTags", () => {
	it("case-folds so a tag is always reachable from its filter chip", () => {
		// `matchesTags` compares exactly, so an unfolded "API" could never be
		// selected from a chip that reads "api".
		expect(normalizeTags(["API", "api", "Api"])).toEqual(["api"])
	})

	it("trims, drops empties and dedupes", () => {
		expect(normalizeTags(["  slo ", "", "   ", "slo", "cost"])).toEqual(["cost", "slo"])
	})

	it("sorts, so two dashboards with the same tags store them identically", () => {
		expect(normalizeTags(["slo", "api", "cost"])).toEqual(["api", "cost", "slo"])
	})

	it("caps length rather than rejecting, so a long paste still lands", () => {
		const [tag] = normalizeTags(["x".repeat(80)])
		expect(tag).toHaveLength(32)
	})

	it("returns an empty array for input that is all separators", () => {
		expect(normalizeTags([" ", ""])).toEqual([])
	})
})

const renderDialog = (props: Partial<React.ComponentProps<typeof TagEditorDialog>> = {}) => {
	const onSave = vi.fn()
	render(
		<TagEditorDialog
			open
			onOpenChange={vi.fn()}
			dashboardName="Checkout latency"
			tags={["slo"]}
			suggestions={["slo", "api", "infra"]}
			onSave={onSave}
			{...props}
		/>,
	)
	return { onSave }
}

describe("TagEditorDialog", () => {
	it("saves the existing tags plus a typed one, normalized", () => {
		const { onSave } = renderDialog()
		const input = screen.getByLabelText("Add a tag")
		fireEvent.change(input, { target: { value: "  Team-Platform " } })
		fireEvent.keyDown(input, { key: "Enter" })
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		expect(onSave).toHaveBeenCalledWith(["slo", "team-platform"])
	})

	it("commits a typed tag that was never confirmed, so Save loses nothing", () => {
		const { onSave } = renderDialog({ tags: [] })
		fireEvent.change(screen.getByLabelText("Add a tag"), { target: { value: "cost" } })
		// No Enter, no blur — straight to Save.
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		expect(onSave).toHaveBeenCalledWith(["cost"])
	})

	it("splits a comma-separated paste into separate tags", () => {
		const { onSave } = renderDialog({ tags: [] })
		const input = screen.getByLabelText("Add a tag")
		fireEvent.change(input, { target: { value: "api, slo" } })
		fireEvent.blur(input)
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		expect(onSave).toHaveBeenCalledWith(["api", "slo"])
	})

	it("removes a tag via its chip", () => {
		const { onSave } = renderDialog({ tags: ["slo", "api"] })
		fireEvent.click(screen.getByRole("button", { name: "Remove tag slo" }))
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		expect(onSave).toHaveBeenCalledWith(["api"])
	})

	it("offers only org tags this dashboard does not already carry", () => {
		renderDialog({ tags: ["slo"] })
		expect(screen.queryByRole("button", { name: /^\+?\s*api$/i })).toBeTruthy()
		// "slo" is already a chip, so it must not also appear as a suggestion.
		expect(screen.getAllByText("slo")).toHaveLength(1)
	})

	it("states the consequence when a dashboard has no tags", () => {
		renderDialog({ tags: [] })
		expect(screen.getByText(/won't appear under any Tags filter/i)).toBeTruthy()
	})
})

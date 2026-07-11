import { Story } from "@maple/unitflow/reducer"
import { describe, expect, it } from "vitest"
import {
	clearedSelection,
	initialIssueSelection,
	toggledSelection,
	updateIssueSelection,
} from "./issue-selection"

const ordered = ["a", "b", "c", "d"]
const selected = (state: { selectedIds: ReadonlySet<string> }) => [...state.selectedIds].sort()

describe("updateIssueSelection (Story)", () => {
	it("toggles a single row and records it as the anchor, with no commands", () => {
		const story = Story.make(updateIssueSelection, initialIssueSelection)
		story.dispatch(toggledSelection("b", false, ordered))
		expect(selected(story.state)).toEqual(["b"])
		expect(story.state.anchor).toBe("b")
		expect(story.commands).toEqual([])
	})

	it("toggling the same row again deselects it", () => {
		const story = Story.make(updateIssueSelection, initialIssueSelection)
		story.dispatch(toggledSelection("b", false, ordered))
		story.dispatch(toggledSelection("b", false, ordered))
		expect(selected(story.state)).toEqual([])
	})

	it("shift+anchor selects the inclusive range and leaves the anchor put", () => {
		const story = Story.make(updateIssueSelection, initialIssueSelection)
		story.dispatch(toggledSelection("a", false, ordered)) // anchor = a
		story.dispatch(toggledSelection("c", true, ordered)) // range a..c
		expect(selected(story.state)).toEqual(["a", "b", "c"])
		expect(story.state.anchor).toBe("a")
	})

	it("shift-range resolves regardless of direction", () => {
		const story = Story.make(updateIssueSelection, initialIssueSelection)
		story.dispatch(toggledSelection("d", false, ordered))
		story.dispatch(toggledSelection("b", true, ordered))
		expect(selected(story.state)).toEqual(["b", "c", "d"])
	})

	it("shift with no anchor falls back to a single toggle", () => {
		const story = Story.make(updateIssueSelection, initialIssueSelection)
		story.dispatch(toggledSelection("c", true, ordered))
		expect(selected(story.state)).toEqual(["c"])
		expect(story.state.anchor).toBe("c")
	})

	it("Cleared resets selection and anchor", () => {
		const story = Story.make(updateIssueSelection, initialIssueSelection)
		story.dispatch(toggledSelection("a", false, ordered))
		story.dispatch(clearedSelection)
		expect(selected(story.state)).toEqual([])
		expect(story.state.anchor).toBeNull()
	})
})

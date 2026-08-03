import { describe, expect, it } from "vitest"

import { isEditableTarget } from "../keyboard"

describe("isEditableTarget", () => {
	it.each(["input", "textarea", "select"])("treats <%s> as editable", (tag) => {
		expect(isEditableTarget(document.createElement(tag))).toBe(true)
	})

	it("treats contentEditable elements as editable", () => {
		const div = document.createElement("div")
		// jsdom never reflects `isContentEditable`, so stub the DOM property the
		// guard reads; browsers derive it from the contentEditable attribute.
		Object.defineProperty(div, "isContentEditable", { value: true })
		expect(isEditableTarget(div)).toBe(true)
	})

	it("rejects plain elements, null, and non-element targets", () => {
		expect(isEditableTarget(document.createElement("div"))).toBe(false)
		expect(isEditableTarget(document.createElement("button"))).toBe(false)
		expect(isEditableTarget(null)).toBe(false)
		expect(isEditableTarget(new EventTarget())).toBe(false)
	})
})

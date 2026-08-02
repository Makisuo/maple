// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { writeClipboardFallback, writeClipboardText } from "./clipboard"

let execCommand: ReturnType<typeof vi.fn>

beforeEach(() => {
	execCommand = vi.fn(() => true)
	Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand })
})

afterEach(() => {
	vi.restoreAllMocks()
	Reflect.deleteProperty(navigator, "clipboard")
})

describe("writeClipboardFallback", () => {
	it("copies through a textarea and leaves no node behind", () => {
		const before = document.body.childNodes.length
		let seen: HTMLTextAreaElement | undefined
		execCommand.mockImplementation(() => {
			// The element only exists for the duration of the call — capture it now
			// or the assertions below have nothing to check.
			seen = document.body.querySelector("textarea") ?? undefined
			return true
		})

		expect(writeClipboardFallback("maple")).toBe(true)
		expect(seen?.value).toBe("maple")
		expect(seen?.getAttribute("readonly")).toBe("")
		expect(document.body.childNodes.length).toBe(before)
		expect(document.body.querySelector("textarea")).toBeNull()
	})

	it("restores the user's selection instead of stealing the caret", () => {
		const paragraph = document.createElement("p")
		paragraph.textContent = "selected text"
		document.body.appendChild(paragraph)
		const range = document.createRange()
		range.selectNodeContents(paragraph)
		const selection = document.getSelection()!
		selection.removeAllRanges()
		selection.addRange(range)

		writeClipboardFallback("maple")

		expect(selection.rangeCount).toBe(1)
		expect(selection.getRangeAt(0).startContainer).toBe(paragraph)
		paragraph.remove()
	})

	it("reports failure and still removes the textarea when execCommand throws", () => {
		execCommand.mockImplementation(() => {
			throw new Error("blocked")
		})

		expect(writeClipboardFallback("maple")).toBe(false)
		expect(document.body.querySelector("textarea")).toBeNull()
	})
})

describe("writeClipboardText", () => {
	it("prefers navigator.clipboard when it resolves", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })

		expect(await writeClipboardText("maple")).toBe(true)
		expect(writeText).toHaveBeenCalledWith("maple")
		expect(execCommand).not.toHaveBeenCalled()
	})

	it("falls back when the clipboard API rejects", async () => {
		const writeText = vi.fn().mockRejectedValue(new Error("denied"))
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })

		expect(await writeClipboardText("maple")).toBe(true)
		expect(execCommand).toHaveBeenCalledWith("copy")
	})

	it("falls back when the clipboard API is missing (insecure origin)", async () => {
		expect(await writeClipboardText("maple")).toBe(true)
		expect(execCommand).toHaveBeenCalledWith("copy")
	})

	it("refuses an empty value without touching the clipboard", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })

		expect(await writeClipboardText("")).toBe(false)
		expect(writeText).not.toHaveBeenCalled()
		expect(execCommand).not.toHaveBeenCalled()
	})
})

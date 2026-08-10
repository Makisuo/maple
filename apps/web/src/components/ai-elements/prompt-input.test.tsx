// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PromptInputSubmit } from "./prompt-input"

afterEach(() => {
	cleanup()
})

/**
 * The status orb paints to a canvas, and jsdom's `getContext` is a stub that logs
 * "Not implemented" to stderr on every call. The component treats a null context as
 * "don't animate", so returning null is the honest answer and only silences noise.
 */
HTMLCanvasElement.prototype.getContext = () => null

const orb = () => document.querySelector("canvas")

describe("PromptInputSubmit", () => {
	it("shows a plain send affordance when idle", () => {
		render(<PromptInputSubmit status="ready" />)

		expect(screen.getByLabelText("Submit")).toBeTruthy()
		expect(orb()).toBeNull()
	})

	it("swaps to the orb while a turn is in flight", () => {
		render(<PromptInputSubmit status="streaming" />)

		expect(screen.getByLabelText("Sending")).toBeTruthy()
		expect(orb()).toBeTruthy()
	})

	it("keeps both the orb and the stop glyph mounted so the swap can't reflow the button", () => {
		render(<PromptInputSubmit status="streaming" onStop={() => {}} />)

		const button = screen.getByLabelText("Stop generating")
		// The crossfade is CSS over two stacked grid cells — if either layer were mounted
		// conditionally, hovering would resize the button mid-turn.
		expect(button.querySelector("canvas")).toBeTruthy()
		expect(button.querySelector("svg")).toBeTruthy()
		expect(button.className).toContain("group/submit")
	})

	it("cancels the turn rather than submitting the form when it can stop", () => {
		const onStop = vi.fn()
		render(<PromptInputSubmit status="streaming" onStop={onStop} />)

		const button = screen.getByLabelText("Stop generating")
		expect(button.getAttribute("type")).toBe("button")
		fireEvent.click(button)
		expect(onStop).toHaveBeenCalledOnce()
	})

	it("stays a submit control once the turn is done", () => {
		const onStop = vi.fn()
		render(<PromptInputSubmit status="ready" onStop={onStop} />)

		const button = screen.getByLabelText("Submit")
		expect(button.getAttribute("type")).toBe("submit")
		fireEvent.click(button)
		expect(onStop).not.toHaveBeenCalled()
	})
})

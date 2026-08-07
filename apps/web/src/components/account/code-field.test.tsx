// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CodeField } from "./code-field"

function renderField() {
	return render(
		<CodeField value="" onValueChange={vi.fn()} onValueComplete={vi.fn()} label="Verification code" />,
	)
}

describe("CodeField", () => {
	afterEach(cleanup)

	it("gives every slot an accessible name", () => {
		// Base UI ignores `aria-label` on the first input and warns about it, so slot one must be
		// named by a real <label>. Without this the first box a screen-reader user lands on — the
		// one they type into first — is announced as an unlabelled textbox.
		const { container } = renderField()
		const slots = [...container.querySelectorAll("input[data-slot=otp-field-input]")]
		expect(slots).toHaveLength(6)

		// Base UI also renders a hidden aggregate input that shares the field's name, so assert
		// against the visible slot rather than by-label (which matches both).
		expect(screen.getAllByLabelText("Verification code")).toContain(slots[0])
		for (let slot = 2; slot <= 6; slot++) {
			expect(screen.getByLabelText(`Digit ${slot} of 6`)).toBe(slots[slot - 1])
		}
	})

	it("points the caption at the first slot", () => {
		const { container } = renderField()
		const first = container.querySelectorAll("input[data-slot=otp-field-input]")[0]
		const caption = container.querySelector("label")
		expect(caption?.getAttribute("for")).toBe(first?.getAttribute("id"))
		expect(first?.getAttribute("id")).toBeTruthy()
	})

	it("logs no Base UI labelling warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		renderField()
		const messages = [...warn.mock.calls, ...error.mock.calls].flat().join(" ")
		expect(messages).not.toContain("ignores `aria-label` on the first input")
		warn.mockRestore()
		error.mockRestore()
	})
})

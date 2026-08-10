// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TurnFailureNotice } from "./turn-failure-notice"

afterEach(() => {
	cleanup()
})

describe("TurnFailureNotice", () => {
	it("shows the safe failure and lets the user continue", () => {
		const onContinue = vi.fn()
		render(
			<TurnFailureNotice
				error={new Error("Maple couldn't complete this response.")}
				onContinue={onContinue}
			/>,
		)

		expect(screen.getByRole("alert").textContent).toContain("Maple couldn't complete this response.")
		fireEvent.click(screen.getByRole("button", { name: "Continue" }))
		expect(onContinue).toHaveBeenCalledOnce()
	})
})

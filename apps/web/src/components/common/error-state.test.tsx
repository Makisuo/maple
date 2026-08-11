// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ErrorState } from "./error-state"

describe("ErrorState recovery actions", () => {
	beforeEach(() => vi.useFakeTimers())

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
	})

	it("announces the error and does not offer a placebo retry for invalid input", () => {
		render(
			<ErrorState
				error={{
					error: {
						type: "invalid_request_error",
						code: "invalid_time_range",
						message: "End time must be after start time.",
						param: "end_time",
					},
				}}
				onRetry={vi.fn()}
			/>,
		)

		expect(screen.getByRole("alert").textContent).toContain("End time must be after start time.")
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
	})

	it("offers retry and communicates bounded automatic recovery for connectivity loss", () => {
		const retry = vi.fn()
		render(<ErrorState error={new Error("Failed to fetch")} onRetry={retry} />)

		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
		expect(screen.getByRole("alert").textContent).toContain("Retrying automatically")

		act(() => vi.runAllTimers())
		expect(retry).toHaveBeenCalledTimes(6)
		expect(screen.getByRole("alert").textContent).not.toContain("Retrying automatically")
	})

	it("keeps timeouts manual instead of treating them as offline", () => {
		render(<ErrorState error={new DOMException("timed out", "TimeoutError")} onRetry={vi.fn()} />)

		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
		expect(screen.getByRole("alert").textContent).not.toContain("Retrying automatically")
	})
})

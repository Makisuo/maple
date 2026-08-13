// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react"
import { HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ErrorState } from "./error-state"

const transportError = (cause?: unknown) =>
	new HttpClientError.HttpClientError({
		reason: new HttpClientError.TransportError({
			request: HttpClientRequest.get("https://api.maple.dev/v2/services"),
			...(cause === undefined ? {} : { cause }),
		}),
	})

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
						_tag: "@maple/http/errors/InvalidTimeRangeError",
						type: "invalid_request_error",
						code: "invalid_time_range",
						title: "Invalid time range",
						message: "End time must be after start time.",
						retryable: false,
						recovery: "fix_request",
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
		render(<ErrorState error={transportError()} onRetry={retry} />)

		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
		expect(screen.getByRole("alert").textContent).toContain("Retrying automatically")

		act(() => vi.runAllTimers())
		expect(retry).toHaveBeenCalledTimes(6)
		expect(screen.getByRole("alert").textContent).not.toContain("Retrying automatically")
	})

	it("keeps timeouts manual instead of treating them as offline", () => {
		render(
			<ErrorState
				error={transportError(new DOMException("timed out", "TimeoutError"))}
				onRetry={vi.fn()}
			/>,
		)

		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
		expect(screen.getByRole("alert").textContent).not.toContain("Retrying automatically")
	})
})

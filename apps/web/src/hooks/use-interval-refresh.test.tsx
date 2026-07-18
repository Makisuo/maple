// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useIntervalRefresh } from "./use-interval-refresh"

function Probe({ refresh, enabled = true }: { refresh: () => void; enabled?: boolean }) {
	useIntervalRefresh(refresh, { intervalMs: 10_000, enabled })
	return null
}

describe("useIntervalRefresh", () => {
	beforeEach(() => vi.useFakeTimers())

	afterEach(() => {
		cleanup()
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it("polls only while visible and clears the interval on unmount", () => {
		let hidden = false
		vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden)
		const refresh = vi.fn()
		const view = render(<Probe refresh={refresh} />)

		act(() => vi.advanceTimersByTime(10_000))
		expect(refresh).toHaveBeenCalledTimes(1)

		hidden = true
		act(() => vi.advanceTimersByTime(20_000))
		expect(refresh).toHaveBeenCalledTimes(1)

		hidden = false
		act(() => vi.advanceTimersByTime(10_000))
		expect(refresh).toHaveBeenCalledTimes(2)

		view.unmount()
		act(() => vi.advanceTimersByTime(20_000))
		expect(refresh).toHaveBeenCalledTimes(2)
	})

	it("replaces the timer when the refresh callback changes", () => {
		const firstRefresh = vi.fn()
		const secondRefresh = vi.fn()
		const view = render(<Probe refresh={firstRefresh} />)

		view.rerender(<Probe refresh={secondRefresh} />)
		act(() => vi.advanceTimersByTime(10_000))

		expect(firstRefresh).not.toHaveBeenCalled()
		expect(secondRefresh).toHaveBeenCalledTimes(1)
	})
})

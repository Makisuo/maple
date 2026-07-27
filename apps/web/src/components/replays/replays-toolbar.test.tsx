// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ReplaysToolbar } from "./replays-toolbar"

// Exercises the shared `ToolbarSearch` from `@maple/ui` through its first web
// consumer. Both behaviours below were fixed in the app-local rebuild and lost
// again when the shared version was the one that survived — they stay pinned here
// because `packages/ui` has no DOM test harness.

afterEach(cleanup)

const props = {
	onSearch: () => {},
	totalSessions: 12,
	activeSessions: 3,
	errorSessions: 1,
}

function input() {
	return screen.getByPlaceholderText("Search by URL…") as HTMLInputElement
}

describe("ReplaysToolbar search", () => {
	it("debounces before pushing the trimmed value", () => {
		vi.useFakeTimers()
		const onSearch = vi.fn()
		render(<ReplaysToolbar {...props} query="" onSearch={onSearch} />)

		fireEvent.change(input(), { target: { value: "  check" } })
		expect(onSearch).not.toHaveBeenCalled()

		vi.advanceTimersByTime(300)
		expect(onSearch).toHaveBeenCalledExactlyOnceWith("check")
		vi.useRealTimers()
	})

	it("keeps keystrokes typed while its own search echoes back through the URL", () => {
		vi.useFakeTimers()
		const onSearch = vi.fn()
		const view = render(<ReplaysToolbar {...props} query="" onSearch={onSearch} />)

		fireEvent.change(input(), { target: { value: "check" } })
		vi.advanceTimersByTime(300)
		expect(onSearch).toHaveBeenCalledWith("check")

		// The user keeps typing during the navigation round-trip...
		fireEvent.change(input(), { target: { value: "checkout" } })
		// ...and only now does the router echo the earlier value back as `query`.
		view.rerender(<ReplaysToolbar {...props} query="check" onSearch={onSearch} />)

		expect(input().value).toBe("checkout")
		vi.useRealTimers()
	})

	it("still resyncs when the query changes from outside (Clear all, back/forward)", () => {
		const view = render(<ReplaysToolbar {...props} query="check" onSearch={() => {}} />)
		expect(input().value).toBe("check")

		view.rerender(<ReplaysToolbar {...props} query="" onSearch={() => {}} />)
		expect(input().value).toBe("")
	})

	it("cancels a pending search when unmounted mid-type", () => {
		vi.useFakeTimers()
		const onSearch = vi.fn()
		const view = render(<ReplaysToolbar {...props} query="" onSearch={onSearch} />)

		fireEvent.change(input(), { target: { value: "abandoned" } })
		view.unmount()
		vi.advanceTimersByTime(1000)

		expect(onSearch).not.toHaveBeenCalled()
		vi.useRealTimers()
	})
})

describe("ReplaysToolbar stats", () => {
	it("renders each count with its label", () => {
		render(<ReplaysToolbar {...props} query="" onSearch={() => {}} />)
		expect(screen.getByText("12")).toBeTruthy()
		expect(screen.getByText("sessions")).toBeTruthy()
		expect(screen.getByText("active")).toBeTruthy()
		expect(screen.getByText("with errors")).toBeTruthy()
	})
})

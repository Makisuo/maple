// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useLogTimeWindow } from "./use-log-time-window"

describe("useLogTimeWindow", () => {
	afterEach(() => vi.useRealTimers())

	it("advances one shared window when a log filter changes later", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-07-30T14:05:00Z"))
		const { result, rerender } = renderHook(
			({ range, severity }) => ({ severity, ...useLogTimeWindow(range) }),
			{ initialProps: { range: "1h", severity: undefined as string | undefined } },
		)

		expect(result.current.bounds.startTime).toBe("2026-07-30 13:05:00")

		vi.setSystemTime(new Date("2026-07-30T16:05:00Z"))
		act(() => result.current.advance())
		rerender({ range: "1h", severity: "ERROR" })

		expect(result.current.severity).toBe("ERROR")
		expect(result.current.bounds).toEqual({
			startTime: "2026-07-30 15:05:00",
			endTime: "2026-07-30 17:05:00",
		})
	})
})

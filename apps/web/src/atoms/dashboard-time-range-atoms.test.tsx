// @vitest-environment jsdom

import { Registry, RegistryContext } from "@/lib/effect-atom"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	PageRefreshProvider,
	usePageRefreshContext,
} from "@/components/time-range-picker/page-refresh-context"

import { DashboardTimeRangeProvider, useDashboardTimeRange } from "./dashboard-time-range-atoms"

function createWrapper() {
	const registry = Registry.make()

	return function Wrapper({ children }: { children: ReactNode }) {
		return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
	}
}

function ReloadButton() {
	const { reload } = usePageRefreshContext()
	return <button onClick={reload}>reload</button>
}

function ResolvedProbe() {
	const {
		state: { resolvedTimeRange },
	} = useDashboardTimeRange()
	return <div data-testid="end">{resolvedTimeRange?.endTime ?? "none"}</div>
}

function Harness({ timePreset }: { timePreset?: string }) {
	return (
		<DashboardTimeRangeProvider value={{ type: "relative", value: "1h" }}>
			<PageRefreshProvider timePreset={timePreset}>
				<ReloadButton />
				<ResolvedProbe />
			</PageRefreshProvider>
		</DashboardTimeRangeProvider>
	)
}

describe("useDashboardTimeRange resolved range on reload", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"))
	})

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("rebases the resolved window to now when reload is clicked", () => {
		render(<Harness timePreset="1h" />, { wrapper: createWrapper() })

		const before = screen.getByTestId("end").textContent
		expect(before).toBe("2026-03-10 12:00:00")

		// Advance the wall clock, then reload — the resolved window should follow.
		act(() => {
			vi.setSystemTime(new Date("2026-03-10T12:05:00.000Z"))
			fireEvent.click(screen.getByRole("button", { name: "reload" }))
		})

		expect(screen.getByTestId("end").textContent).toBe("2026-03-10 12:05:00")
	})
})

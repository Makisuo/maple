// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigateSpy = vi.fn()
const providerProps = {
	timePreset: undefined as string | undefined,
	onRelativeRangeRefresh: undefined as unknown,
}

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")
	return {
		...actual,
		useNavigate: () => navigateSpy,
	}
})

vi.mock("@/components/layout/dashboard-layout", () => ({
	DashboardLayout: ({ headerActions, children }: { headerActions?: ReactNode; children?: ReactNode }) => (
		<div>
			{headerActions}
			{children}
		</div>
	),
}))

vi.mock("@/components/logs/logs-table", () => ({
	LogsTable: () => <div>logs-table</div>,
}))

vi.mock("@/components/logs/logs-volume-chart", () => ({
	LogsVolumeChart: () => <div>logs-volume-chart</div>,
}))

vi.mock("@/components/logs/logs-filter-sidebar", () => ({
	LogsFilterSidebar: () => <div>logs-filter-sidebar</div>,
}))

vi.mock("@/components/time-range-picker/page-refresh-context", () => ({
	PageRefreshProvider: ({
		children,
		timePreset,
		onRelativeRangeRefresh,
	}: {
		children: ReactNode
		timePreset?: string
		onRelativeRangeRefresh?: unknown
	}) => {
		providerProps.timePreset = timePreset
		providerProps.onRelativeRangeRefresh = onRelativeRangeRefresh
		return <>{children}</>
	},
}))

vi.mock("@/components/time-range-picker/time-range-header-controls", () => ({
	TimeRangeHeaderControls: () => <div>time-range-header-controls</div>,
}))

import * as LogsRoute from "./logs"

describe("LogsPage live refresh scope", () => {
	beforeEach(() => {
		navigateSpy.mockReset()
		providerProps.timePreset = undefined
		providerProps.onRelativeRangeRefresh = undefined
		vi.spyOn(LogsRoute.Route, "useSearch").mockReturnValue({
			services: undefined,
			severities: undefined,
			search: undefined,
			startTime: undefined,
			endTime: undefined,
			timePreset: undefined,
		})
	})

	afterEach(() => {
		cleanup()
		vi.restoreAllMocks()
	})

	it("does not attach route-level relative refresh rebasing", () => {
		render(<LogsRoute.LogsPage />)

		expect(providerProps.timePreset).toBe("12h")
		expect(providerProps.onRelativeRangeRefresh).toBeUndefined()
	})
})

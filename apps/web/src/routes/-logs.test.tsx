// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

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

vi.mock("@/components/layout/dashboard-layout", () => {
	// Pass-through shell: every region just renders its children, so a test can
	// assert on header actions and page body without the sidebar/router chrome.
	const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
	return {
		DashboardLayout: {
			Root: passthrough,
			Breadcrumbs: () => null,
			Body: passthrough,
			Filters: passthrough,
			Content: passthrough,
			Sticky: passthrough,
			Header: passthrough,
			Scroll: passthrough,
			RightPanel: passthrough,
			Title: passthrough,
			Description: passthrough,
		},
	}
})

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
import { component as LogsPage } from "./logs?tsr-split=component"

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
		render(<LogsPage />)

		expect(providerProps.timePreset).toBe("12h")
		expect(providerProps.onRelativeRangeRefresh).toBeUndefined()
	})
})

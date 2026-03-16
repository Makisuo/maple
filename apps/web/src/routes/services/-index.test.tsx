// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigateSpy = vi.fn()

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  }
})

vi.mock("@/components/layout/dashboard-layout", () => ({
  DashboardLayout: ({
    headerActions,
    children,
  }: {
    headerActions?: ReactNode
    children?: ReactNode
  }) => (
    <div>
      {headerActions}
      {children}
    </div>
  ),
}))

vi.mock("@/components/services/services-table", () => ({
  ServicesTable: () => <div>services-table</div>,
}))

vi.mock("@/components/services/services-filter-sidebar", () => ({
  ServicesFilterSidebar: () => <div>services-filter-sidebar</div>,
}))

vi.mock("@/components/time-range-picker/page-refresh-context", () => ({
  PageRefreshProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock("@/components/time-range-picker/time-range-header-controls", () => ({
  TimeRangeHeaderControls: ({
    onTimeChange,
  }: {
    onTimeChange: (range: {
      startTime?: string
      endTime?: string
      presetValue?: string
    }) => void
  }) => (
    <div>
      <button
        onClick={() =>
          onTimeChange({
            startTime: "2026-03-10 11:00:00",
            endTime: "2026-03-10 12:00:00",
            presetValue: "1h",
          })}
      >
        preset
      </button>
      <button
        onClick={() =>
          onTimeChange({
            startTime: "2026-03-10 00:00:00",
            endTime: "2026-03-10 06:00:00",
          })}
      >
        custom
      </button>
    </div>
  ),
}))

vi.mock("@/hooks/use-effective-time-range", () => ({
  useEffectiveTimeRange: () => ({
    startTime: "2026-03-10 11:00:00",
    endTime: "2026-03-10 12:00:00",
  }),
}))

import * as ServicesRoute from "./index"

describe("ServicesPage timePreset search updates", () => {
  beforeEach(() => {
    navigateSpy.mockReset()
    vi.spyOn(ServicesRoute.Route, "useSearch").mockReturnValue({
      environments: undefined,
      commitShas: undefined,
      startTime: undefined,
      endTime: undefined,
      timePreset: undefined,
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("writes timePreset for preset-based selections", () => {
    render(<ServicesRoute.ServicesPage />)

    fireEvent.click(screen.getByRole("button", { name: "preset" }))

    const navigation = navigateSpy.mock.calls[0]?.[0]
    expect(navigation?.replace).toBeUndefined()
    expect(
      navigation.search({
        environments: ["production"],
      }),
    ).toEqual({
      environments: ["production"],
      startTime: undefined,
      endTime: undefined,
      timePreset: "1h",
    })
  })

  it("clears timePreset for custom selections", () => {
    vi.spyOn(ServicesRoute.Route, "useSearch").mockReturnValue({
      environments: undefined,
      commitShas: undefined,
      startTime: "2026-03-10 11:00:00",
      endTime: "2026-03-10 12:00:00",
      timePreset: "1h",
    })

    render(<ServicesRoute.ServicesPage />)

    fireEvent.click(screen.getByRole("button", { name: "custom" }))

    const navigation = navigateSpy.mock.calls[0]?.[0]
    expect(
      navigation.search({
        timePreset: "1h",
      }),
    ).toEqual({
      timePreset: undefined,
      startTime: "2026-03-10 00:00:00",
      endTime: "2026-03-10 06:00:00",
    })
  })
})

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigateSpy = vi.fn()
const atoms = {
  facets: Symbol("facets"),
  spanAttributeKeys: Symbol("spanAttributeKeys"),
  spanAttributeValues: Symbol("spanAttributeValues"),
  resourceAttributeKeys: Symbol("resourceAttributeKeys"),
  resourceAttributeValues: Symbol("resourceAttributeValues"),
}
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

vi.mock("@/components/traces/traces-table", () => ({
  TracesTable: () => <div>traces-table</div>,
}))

vi.mock("@/components/traces/traces-filter-sidebar", () => ({
  TracesFilterSidebar: () => <div>traces-filter-sidebar</div>,
}))

vi.mock("@/components/traces/advanced-filter-dialog", () => ({
  AdvancedFilterDialog: () => <div>advanced-filter-dialog</div>,
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

vi.mock("@/lib/services/atoms/tinybird-query-atoms", () => ({
  getTracesFacetsResultAtom: () => atoms.facets,
  getSpanAttributeKeysResultAtom: () => atoms.spanAttributeKeys,
  getSpanAttributeValuesResultAtom: () => atoms.spanAttributeValues,
  getResourceAttributeKeysResultAtom: () => atoms.resourceAttributeKeys,
  getResourceAttributeValuesResultAtom: () => atoms.resourceAttributeValues,
}))

vi.mock("@effect-atom/atom-react", async () => {
  const actual = await vi.importActual<typeof import("@effect-atom/atom-react")>("@effect-atom/atom-react")

  return {
    ...actual,
    useAtomValue: (atom: symbol) => {
      switch (atom) {
        case atoms.facets:
          return actual.Result.success({
            data: {
              services: [],
              spanNames: [],
              deploymentEnvs: [],
              httpMethods: [],
              httpStatusCodes: [],
            },
          })
        case atoms.spanAttributeKeys:
        case atoms.spanAttributeValues:
        case atoms.resourceAttributeKeys:
        case atoms.resourceAttributeValues:
          return actual.Result.success({ data: [] })
        default:
          throw new Error(`Unexpected atom: ${String(atom)}`)
      }
    },
  }
})

import * as TracesRoute from "./index"

describe("TracesPage timePreset search updates", () => {
  beforeEach(() => {
    navigateSpy.mockReset()
    providerProps.timePreset = undefined
    providerProps.onRelativeRangeRefresh = undefined
    vi.spyOn(TracesRoute.Route, "useSearch").mockReturnValue({
      services: undefined,
      spanNames: undefined,
      hasError: undefined,
      minDurationMs: undefined,
      maxDurationMs: undefined,
      httpMethods: undefined,
      httpStatusCodes: undefined,
      deploymentEnvs: undefined,
      startTime: undefined,
      endTime: undefined,
      timePreset: undefined,
      rootOnly: undefined,
      whereClause: undefined,
      attributeKey: undefined,
      attributeValue: undefined,
      resourceAttributeKey: undefined,
      resourceAttributeValue: undefined,
      serviceMatchMode: undefined,
      spanNameMatchMode: undefined,
      deploymentEnvMatchMode: undefined,
      attributeValueMatchMode: undefined,
      resourceAttributeValueMatchMode: undefined,
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("does not attach route-level relative refresh rebasing", () => {
    render(<TracesRoute.TracesPage />)

    expect(providerProps.timePreset).toBe("12h")
    expect(providerProps.onRelativeRangeRefresh).toBeUndefined()
  })

  it("writes timePreset for preset-based selections", () => {
    render(<TracesRoute.TracesPage />)

    fireEvent.click(screen.getByRole("button", { name: "preset" }))

    const navigation = navigateSpy.mock.calls[0]?.[0]
    expect(
      navigation.search({
        whereClause: "service.name = \"checkout\"",
      }),
    ).toEqual({
      whereClause: "service.name = \"checkout\"",
      startTime: undefined,
      endTime: undefined,
      timePreset: "1h",
    })
  })

  it("clears timePreset for custom selections", () => {
    vi.spyOn(TracesRoute.Route, "useSearch").mockReturnValue({
      services: undefined,
      spanNames: undefined,
      hasError: undefined,
      minDurationMs: undefined,
      maxDurationMs: undefined,
      httpMethods: undefined,
      httpStatusCodes: undefined,
      deploymentEnvs: undefined,
      startTime: "2026-03-10 11:00:00",
      endTime: "2026-03-10 12:00:00",
      timePreset: "1h",
      rootOnly: undefined,
      whereClause: undefined,
      attributeKey: undefined,
      attributeValue: undefined,
      resourceAttributeKey: undefined,
      resourceAttributeValue: undefined,
      serviceMatchMode: undefined,
      spanNameMatchMode: undefined,
      deploymentEnvMatchMode: undefined,
      attributeValueMatchMode: undefined,
      resourceAttributeValueMatchMode: undefined,
    })

    render(<TracesRoute.TracesPage />)

    fireEvent.click(screen.getByRole("button", { name: "custom" }))

    const navigation = navigateSpy.mock.calls[0]?.[0]
    expect(
      navigation.search({
        timePreset: "1h",
        services: ["checkout"],
      }),
    ).toEqual({
      timePreset: undefined,
      services: ["checkout"],
      startTime: "2026-03-10 00:00:00",
      endTime: "2026-03-10 06:00:00",
    })
  })
})

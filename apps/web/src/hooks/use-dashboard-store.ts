import { Result, useAtom, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { useCallback, useEffect, useRef } from "react"
import { Exit, Schema } from "effect"
import {
  DashboardCreateRequest,
  DashboardDocument,
  DashboardId,
  DashboardUpsertRequest,
  IsoDateTimeString,
  PortableDashboardDocument,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import type { PortableDashboard } from "@/components/dashboard-builder/portable-dashboard"
import type {
  Dashboard,
  DashboardWidget,
  TimeRange,
  VisualizationType,
  WidgetDataSource,
  WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"
import { dashboardsAtom, persistenceErrorAtom } from "@/atoms/dashboard-store-atoms"

const GRID_COLS = 12
const asDashboardId = Schema.decodeUnknownSync(DashboardId)
const asIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function findNextPosition(
  widgets: DashboardWidget[],
  newWidth: number,
): { x: number; y: number } {
  if (widgets.length === 0) {
    return { x: 0, y: 0 }
  }

  const maxY = Math.max(...widgets.map((w) => w.layout.y))
  const bottomRowWidgets = widgets.filter((w) => w.layout.y === maxY)
  const rightEdge = Math.max(
    ...bottomRowWidgets.map((w) => w.layout.x + w.layout.w),
  )

  if (rightEdge + newWidth <= GRID_COLS) {
    return { x: rightEdge, y: maxY }
  }

  const maxBottom = Math.max(
    ...widgets.map((w) => w.layout.y + w.layout.h),
  )
  return { x: 0, y: maxBottom }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  return "Dashboard persistence is temporarily unavailable"
}

function ensureDashboard(value: unknown): Dashboard | null {
  if (typeof value !== "object" || value === null) {
    return null
  }

  const dashboard = value as Partial<Dashboard>

  if (
    typeof dashboard.id !== "string" ||
    typeof dashboard.name !== "string" ||
    !Array.isArray(dashboard.widgets) ||
    typeof dashboard.createdAt !== "string" ||
    typeof dashboard.updatedAt !== "string" ||
    typeof dashboard.timeRange !== "object" ||
    dashboard.timeRange === null
  ) {
    return null
  }

  return dashboard as Dashboard
}

function toDashboardDocument(dashboard: Dashboard): DashboardDocument {
  return new DashboardDocument({
    ...dashboard,
    id: asDashboardId(dashboard.id),
    createdAt: asIsoDateTimeString(dashboard.createdAt),
    updatedAt: asIsoDateTimeString(dashboard.updatedAt),
    timeRange:
      dashboard.timeRange.type === "absolute"
        ? {
            type: "absolute",
            startTime: asIsoDateTimeString(dashboard.timeRange.startTime),
            endTime: asIsoDateTimeString(dashboard.timeRange.endTime),
          }
        : dashboard.timeRange,
  })
}

function toPortableDashboardDocument(
  dashboard: PortableDashboard,
): PortableDashboardDocument {
  return new PortableDashboardDocument({
    ...dashboard,
    tags: dashboard.tags ? [...dashboard.tags] : undefined,
    widgets: structuredClone(dashboard.widgets),
    timeRange:
      dashboard.timeRange.type === "absolute"
        ? {
            type: "absolute",
            startTime: asIsoDateTimeString(dashboard.timeRange.startTime),
            endTime: asIsoDateTimeString(dashboard.timeRange.endTime),
          }
        : dashboard.timeRange,
  })
}

function parseDashboards(raw: readonly unknown[]): Dashboard[] {
  return raw
    .map((d) => ensureDashboard(d))
    .filter((d): d is Dashboard => d !== null)
}

export function useDashboardStore() {
  const [dashboards, setDashboards] = useAtom(dashboardsAtom)
  const [persistenceError, setPersistenceError] = useAtom(persistenceErrorAtom)

  const listResult = useAtomValue(MapleApiAtomClient.query("dashboards", "list", { reactivityKeys: ["dashboards"] }))
  const createMutation = useAtomSet(MapleApiAtomClient.mutation("dashboards", "create"), { mode: "promiseExit" })
  const upsertMutation = useAtomSet(MapleApiAtomClient.mutation("dashboards", "upsert"), { mode: "promiseExit" })
  const deleteMutation = useAtomSet(MapleApiAtomClient.mutation("dashboards", "delete"), { mode: "promiseExit" })

  const readOnly = persistenceError !== null

  // Sync server data → local atom. Only apply when listResult actually changes
  // (from a refetch), not on re-mount with the same stale result. Without this guard,
  // navigating between routes re-applies the old listResult and overwrites optimistic updates.
  const lastSyncedListResult = useRef(listResult)
  useEffect(() => {
    if (listResult === lastSyncedListResult.current) return
    lastSyncedListResult.current = listResult
    if (Result.isSuccess(listResult)) {
      setDashboards(parseDashboards(listResult.value.dashboards))
      setPersistenceError(null)
    } else if (Result.isFailure(listResult)) {
      setPersistenceError(getErrorMessage(listResult))
    }
  }, [listResult, setDashboards, setPersistenceError])

  const isLoading = dashboards.length === 0 && !Result.isSuccess(listResult)

  const dashboardsRef = useRef(dashboards)
  dashboardsRef.current = dashboards
  const upsertRef = useRef(upsertMutation)
  upsertRef.current = upsertMutation
  const deleteRef = useRef(deleteMutation)
  deleteRef.current = deleteMutation
  const setDashboardsRef = useRef(setDashboards)
  setDashboardsRef.current = setDashboards
  const setPersistenceErrorRef = useRef(setPersistenceError)
  setPersistenceErrorRef.current = setPersistenceError

  const mutateDashboard = useCallback(
    async (
      dashboardId: string,
      updater: (dashboard: Dashboard) => Dashboard,
    ): Promise<void> => {
      // Capture snapshot at call time via ref — safe under concurrent mutations
      const snapshot = [...dashboardsRef.current]
      const index = snapshot.findIndex((d) => d.id === dashboardId)
      if (index < 0) return

      const updated = updater(snapshot[index])

      // Skip no-op mutations (e.g. layout change on mount with same values)
      if (updated === snapshot[index]) return

      const next = [...snapshot]
      next[index] = updated

      // Optimistic update
      setDashboardsRef.current(next)

      const result = await upsertRef.current({
        params: { dashboardId: asDashboardId(updated.id) },
        payload: new DashboardUpsertRequest({
          dashboard: toDashboardDocument(updated),
        }),
        reactivityKeys: ["dashboards", `dashboard:${updated.id}:versions`],
      })

      if (Exit.isFailure(result)) {
        setDashboardsRef.current(snapshot)
        setPersistenceErrorRef.current(getErrorMessage(result))
      }
    },
    [],
  )

  const importDashboard = useCallback(
    async (imported: PortableDashboard): Promise<Dashboard> => {
      if (readOnly) {
        throw new Error("Dashboards are read-only")
      }

      const result = await createMutation({
        payload: new DashboardCreateRequest({
          dashboard: toPortableDashboardDocument(imported),
        }),
        reactivityKeys: ["dashboards"],
      })

      if (Exit.isFailure(result)) {
        setPersistenceError(getErrorMessage(result))
        throw new Error(getErrorMessage(result))
      }

      const dashboard = ensureDashboard(result.value)

      if (dashboard === null) {
        throw new Error("Created dashboard payload is invalid")
      }

      setDashboards((previous) => [
        dashboard,
        ...previous.filter((item) => item.id !== dashboard.id),
      ])

      return dashboard
    },
    [createMutation, readOnly, setDashboards, setPersistenceError],
  )

  const createDashboard = useCallback(
    async (name: string): Promise<Dashboard> => {
      if (readOnly) {
        throw new Error("Dashboards are read-only")
      }

      const result = await createMutation({
        payload: new DashboardCreateRequest({
          dashboard: toPortableDashboardDocument({
            name,
            timeRange: { type: "relative", value: "12h" },
            widgets: [],
          }),
        }),
        reactivityKeys: ["dashboards"],
      })

      if (Exit.isFailure(result)) {
        setPersistenceError(getErrorMessage(result))
        throw new Error(getErrorMessage(result))
      }

      const dashboard = ensureDashboard(result.value)

      if (dashboard === null) {
        throw new Error("Created dashboard payload is invalid")
      }

      setDashboards((previous) => [
        dashboard,
        ...previous.filter((item) => item.id !== dashboard.id),
      ])

      return dashboard
    },
    [createMutation, readOnly, setDashboards, setPersistenceError],
  )

  const updateDashboard = useCallback(
    (
      id: string,
      updates: Partial<Pick<Dashboard, "name" | "description" | "tags">>,
    ) => {
      mutateDashboard(id, (dashboard) => ({
        ...dashboard,
        ...updates,
        updatedAt: new Date().toISOString(),
      }))
    },
    [mutateDashboard],
  )

  const deleteDashboard = useCallback(
    (id: string) => {
      if (readOnly) return

      const snapshot = [...dashboardsRef.current]
      const next = snapshot.filter((dashboard) => dashboard.id !== id)
      if (next.length === snapshot.length) return

      setDashboardsRef.current(next)

      void deleteRef.current({ params: { dashboardId: asDashboardId(id) }, reactivityKeys: ["dashboards"] }).then((result) => {
        if (Exit.isFailure(result)) {
          setDashboardsRef.current(snapshot)
          setPersistenceErrorRef.current(getErrorMessage(result))
        }
      })
    },
    [readOnly],
  )

  const updateDashboardTimeRange = useCallback(
    (id: string, timeRange: TimeRange) => {
      mutateDashboard(id, (dashboard) => ({
        ...dashboard,
        timeRange,
        updatedAt: new Date().toISOString(),
      }))
    },
    [mutateDashboard],
  )

  const addWidget = useCallback(
    (
      dashboardId: string,
      visualization: VisualizationType,
      dataSource: WidgetDataSource,
      display: WidgetDisplayConfig,
    ): DashboardWidget => {
      if (readOnly) {
        throw new Error("Dashboards are read-only")
      }

      const layoutDefaults =
        visualization === "stat"
          ? { w: 3, h: 4, minW: 2, minH: 2 }
          : visualization === "table" || visualization === "list"
            ? { w: 6, h: 4, minW: 3, minH: 3 }
            : { w: 4, h: 4, minW: 2, minH: 2 }

      const widgetId = generateId()
      let widgetRef: DashboardWidget | null = null

      mutateDashboard(dashboardId, (dashboard) => {
        const position = findNextPosition(dashboard.widgets, layoutDefaults.w)

        const widget: DashboardWidget = {
          id: widgetId,
          visualization,
          dataSource,
          display,
          layout: { ...position, ...layoutDefaults },
        }

        widgetRef = widget

        return {
          ...dashboard,
          widgets: [...dashboard.widgets, widget],
          updatedAt: new Date().toISOString(),
        }
      })

      return widgetRef!
    },
    [mutateDashboard, readOnly],
  )

  const cloneWidget = useCallback(
    (dashboardId: string, widgetId: string) => {
      if (readOnly) return
      mutateDashboard(dashboardId, (dashboard) => {
        const source = dashboard.widgets.find((w) => w.id === widgetId)
        if (!source) return dashboard

        const layoutDefaults = {
          w: source.layout.w,
          h: source.layout.h,
          minW: source.layout.minW ?? 2,
          minH: source.layout.minH ?? 2,
        }

        const position = findNextPosition(dashboard.widgets, layoutDefaults.w)
        const clone: DashboardWidget = {
          id: generateId(),
          visualization: source.visualization,
          dataSource: structuredClone(source.dataSource),
          display: structuredClone(source.display),
          layout: { ...position, ...layoutDefaults },
        }

        return {
          ...dashboard,
          widgets: [...dashboard.widgets, clone],
          updatedAt: new Date().toISOString(),
        }
      })
    },
    [mutateDashboard, readOnly],
  )

  const removeWidget = useCallback(
    (dashboardId: string, widgetId: string) => {
      mutateDashboard(dashboardId, (dashboard) => ({
        ...dashboard,
        widgets: dashboard.widgets.filter((widget) => widget.id !== widgetId),
        updatedAt: new Date().toISOString(),
      }))
    },
    [mutateDashboard],
  )

  const updateWidgetDisplay = useCallback(
    (
      dashboardId: string,
      widgetId: string,
      display: Partial<WidgetDisplayConfig>,
    ) => {
      mutateDashboard(dashboardId, (dashboard) => ({
        ...dashboard,
        widgets: dashboard.widgets.map((widget) =>
          widget.id === widgetId
            ? { ...widget, display: { ...widget.display, ...display } }
            : widget,
        ),
        updatedAt: new Date().toISOString(),
      }))
    },
    [mutateDashboard],
  )

  const updateWidgetLayouts = useCallback(
    (
      dashboardId: string,
      layouts: Array<{ i: string; x: number; y: number; w: number; h: number }>,
    ) => {
      mutateDashboard(dashboardId, (dashboard) => {
        let changed = false
        const widgets = dashboard.widgets.map((widget) => {
          const layout = layouts.find((item) => item.i === widget.id)
          if (!layout) return widget
          if (
            widget.layout.x === layout.x &&
            widget.layout.y === layout.y &&
            widget.layout.w === layout.w &&
            widget.layout.h === layout.h
          ) return widget

          changed = true
          return {
            ...widget,
            layout: {
              ...widget.layout,
              x: layout.x,
              y: layout.y,
              w: layout.w,
              h: layout.h,
            },
          }
        })

        // Return same reference if nothing changed — mutateDashboard skips no-ops
        if (!changed) return dashboard

        // Sort by (y, x) so the array order matches visual order. The grid
        // compactor uses array order as a tiebreaker when items share a row,
        // so a stale order causes drag-to-swap to snap back.
        const sorted = [...widgets].sort((a, b) => {
          if (a.layout.y !== b.layout.y) return a.layout.y - b.layout.y
          return a.layout.x - b.layout.x
        })

        return { ...dashboard, widgets: sorted, updatedAt: new Date().toISOString() }
      })
    },
    [mutateDashboard],
  )

  const updateWidget = useCallback(
    (
      dashboardId: string,
      widgetId: string,
      updates: Partial<
        Pick<
          DashboardWidget,
          "visualization" | "dataSource" | "display" | "layout"
        >
      >,
    ) => {
      return mutateDashboard(dashboardId, (dashboard) => ({
        ...dashboard,
        widgets: dashboard.widgets.map((widget) =>
          widget.id === widgetId ? { ...widget, ...updates } : widget,
        ),
        updatedAt: new Date().toISOString(),
      }))
    },
    [mutateDashboard],
  )

  const autoLayoutWidgets = useCallback(
    (dashboardId: string) => {
      mutateDashboard(dashboardId, (dashboard) => {
        if (dashboard.widgets.length === 0) return dashboard

        const sorted = [...dashboard.widgets].sort((a, b) => {
          if (a.layout.y !== b.layout.y) return a.layout.y - b.layout.y
          return a.layout.x - b.layout.x
        })

        let currentX = 0
        let currentY = 0
        let rowHeight = 0

        const relaid = sorted.map((widget) => {
          const w = widget.layout.w
          const h = widget.layout.h

          if (currentX + w > GRID_COLS) {
            currentX = 0
            currentY += rowHeight
            rowHeight = 0
          }

          const newLayout = { ...widget.layout, x: currentX, y: currentY }
          currentX += w
          rowHeight = Math.max(rowHeight, h)

          return { ...widget, layout: newLayout }
        })

        return {
          ...dashboard,
          widgets: relaid,
          updatedAt: new Date().toISOString(),
        }
      })
    },
    [mutateDashboard],
  )

  return {
    dashboards,
    isLoading,
    readOnly,
    persistenceError,
    createDashboard,
    importDashboard,
    updateDashboard,
    deleteDashboard,
    updateDashboardTimeRange,
    addWidget,
    cloneWidget,
    removeWidget,
    updateWidgetDisplay,
    updateWidgetLayouts,
    updateWidget,
    autoLayoutWidgets,
  }
}

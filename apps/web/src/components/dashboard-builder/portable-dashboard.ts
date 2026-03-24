import { PortableDashboardDocument } from "@maple/domain/http"
import { Schema } from "effect"

import type {
  Dashboard,
  DashboardWidget,
  WidgetLayout,
} from "@/components/dashboard-builder/types"

export type PortableDashboard = Omit<
  Dashboard,
  "id" | "createdAt" | "updatedAt"
>

const decodePortableDashboard = Schema.decodeUnknownSync(PortableDashboardDocument)

function clonePortableDashboard<T>(value: T): T {
  return structuredClone(value)
}

function sanitizeFilenameSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9-_ ]/g, "").trim()
  return sanitized.length > 0 ? sanitized : "dashboard"
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isWidgetLayout(value: unknown): value is WidgetLayout {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const layout = value as Partial<WidgetLayout>
  return (
    isFiniteNumber(layout.x) &&
    isFiniteNumber(layout.y) &&
    isFiniteNumber(layout.w) &&
    isFiniteNumber(layout.h)
  )
}

function findNextWidgetPosition(widgets: DashboardWidget[], width: number) {
  if (widgets.length === 0) {
    return { x: 0, y: 0 }
  }

  const maxY = Math.max(...widgets.map((widget) => widget.layout.y))
  const bottomRowWidgets = widgets.filter((widget) => widget.layout.y === maxY)
  const rightEdge = Math.max(
    ...bottomRowWidgets.map((widget) => widget.layout.x + widget.layout.w),
  )

  if (rightEdge + width <= 12) {
    return { x: rightEdge, y: maxY }
  }

  const maxBottom = Math.max(
    ...widgets.map((widget) => widget.layout.y + widget.layout.h),
  )

  return { x: 0, y: maxBottom }
}

function normalizeWidgetLayouts(widgets: DashboardWidget[]): DashboardWidget[] {
  return widgets.reduce<DashboardWidget[]>((normalized, widget) => {
    const defaultLayout = {
      w: widget.visualization === "stat" ? 3 : widget.visualization === "table" ? 6 : 4,
      h: 4,
      minW: widget.visualization === "stat" ? 2 : 3,
      minH: widget.visualization === "table" ? 3 : 2,
    }

    const layout = isWidgetLayout(widget.layout)
      ? widget.layout
      : {
          ...findNextWidgetPosition(normalized, defaultLayout.w),
          ...defaultLayout,
        }

    normalized.push({
      ...widget,
      layout,
    })

    return normalized
  }, [])
}

export function toPortableDashboard(dashboard: Dashboard): PortableDashboard {
  return {
    name: dashboard.name,
    description: dashboard.description,
    tags: dashboard.tags ? [...dashboard.tags] : undefined,
    timeRange: clonePortableDashboard(dashboard.timeRange),
    widgets: normalizeWidgetLayouts(clonePortableDashboard(dashboard.widgets)),
  }
}

export function parsePortableDashboardJson(json: string): PortableDashboard {
  const parsed = JSON.parse(json)
  const decoded = decodePortableDashboard(parsed)

  return {
    name: decoded.name,
    description: decoded.description,
    tags: decoded.tags ? [...decoded.tags] : undefined,
    timeRange:
      decoded.timeRange.type === "absolute"
        ? {
            type: "absolute",
            startTime: decoded.timeRange.startTime,
            endTime: decoded.timeRange.endTime,
          }
        : {
            type: "relative",
            value: decoded.timeRange.value,
          },
    widgets: normalizeWidgetLayouts(
      decoded.widgets.map((widget) => clonePortableDashboard(widget as DashboardWidget)),
    ),
  }
}

export function downloadPortableDashboard(dashboard: Dashboard) {
  const portableDashboard = toPortableDashboard(dashboard)
  const json = JSON.stringify(portableDashboard, null, 2)
  const blob = new Blob([json], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")

  anchor.href = url
  anchor.download = `${sanitizeFilenameSegment(dashboard.name)}.json`

  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

import { PortableDashboardDocument, defaultWidgetLayout } from "@maple/domain/http"
import { Schema } from "effect"

import { findNextPosition, widgetsInContainer } from "@/components/dashboard-builder/sections/section-layout"
import type { Dashboard, DashboardWidget, WidgetLayout } from "@/components/dashboard-builder/types"

export type PortableDashboard = Omit<Dashboard, "id" | "createdAt" | "updatedAt">

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

function normalizeWidgetLayouts(widgets: DashboardWidget[]): DashboardWidget[] {
	return widgets.reduce<DashboardWidget[]>((normalized, widget) => {
		// The same grid size the "Add widget" store hands a click-added widget, so
		// an imported dashboard doesn't lay out differently from a built one.
		const defaultLayout = defaultWidgetLayout(widget.visualization)

		const layout = isWidgetLayout(widget.layout)
			? widget.layout
			: {
					// Placed within the widget's own container: `layout.x/y` are
					// container-relative, so measuring against every widget on the
					// board would drop an imported grouped tile far below its group.
					...findNextPosition(
						widgetsInContainer(
							normalized,
							widget.sectionId !== undefined && widget.tabId !== undefined
								? { sectionId: widget.sectionId, tabId: widget.tabId }
								: null,
						),
						defaultLayout.w,
					),
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
		sections: dashboard.sections ? clonePortableDashboard(dashboard.sections) : undefined,
		variables: dashboard.variables ? clonePortableDashboard(dashboard.variables) : undefined,
		refreshIntervalSeconds: dashboard.refreshIntervalSeconds,
	}
}

// Deliberately NOT routed through `dataSourceRouteParams`: this is defensive
// hygiene over hand-written or externally-produced portable JSON, where a baked
// absolute window can appear under any endpoint, not just a curated route. It
// reads the stored bag directly because it is a bag-level scrub. Once v3 lands
// the query and raw-SQL arms carry no bag at all, so this narrows to routes on
// its own — via the migration, not via a guard here.
function stripWidgetTimeParams(widget: DashboardWidget): DashboardWidget {
	const params = widget.dataSource.params
	if (!params || !("startTime" in params || "endTime" in params)) return widget
	const { startTime: _startTime, endTime: _endTime, ...rest } = params
	return { ...widget, dataSource: { ...widget.dataSource, params: rest } }
}

export function parsePortableDashboardJson(json: string): PortableDashboard {
	const parsed = JSON.parse(json)
	const decoded = decodePortableDashboard(parsed)

	return {
		name: decoded.name,
		description: decoded.description,
		tags: decoded.tags ? [...decoded.tags] : undefined,
		variables: decoded.variables
			? clonePortableDashboard(decoded.variables as PortableDashboard["variables"])
			: undefined,
		// Imported as-is; `sanitizeDashboardSections` repairs any widget whose
		// membership doesn't match on the way into storage.
		sections: decoded.sections
			? clonePortableDashboard(decoded.sections as PortableDashboard["sections"])
			: undefined,
		refreshIntervalSeconds: decoded.refreshIntervalSeconds,
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
			decoded.widgets.map((widget) =>
				stripWidgetTimeParams(clonePortableDashboard(widget as DashboardWidget)),
			),
		),
	}
}

export function isPersesDashboardJson(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as { kind?: unknown }).kind === "Dashboard" &&
		typeof (value as { spec?: unknown }).spec === "object" &&
		(value as { spec?: unknown }).spec !== null
	)
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

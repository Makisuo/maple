import type { DashboardDocument, DashboardVersionChangeKind } from "@maple/domain/http"

type Widget = DashboardDocument["widgets"][number]

interface ChangeSummary {
	readonly kind: DashboardVersionChangeKind
	readonly summary: string
}

const widgetTitle = (widget: Widget): string =>
	widget.display.title?.trim() || widget.visualization || "widget"

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const layoutEqual = (a: Widget, b: Widget): boolean =>
	a.layout.x === b.layout.x &&
	a.layout.y === b.layout.y &&
	a.layout.w === b.layout.w &&
	a.layout.h === b.layout.h

const widgetContentEqual = (a: Widget, b: Widget): boolean =>
	a.visualization === b.visualization &&
	sameJson(a.dataSource, b.dataSource) &&
	sameJson(a.display, b.display)

export const summarizeDashboardChange = (
	prev: DashboardDocument | null,
	next: DashboardDocument,
): ChangeSummary => {
	if (prev === null) {
		return { kind: "created", summary: "Dashboard created" }
	}

	const kinds = new Set<DashboardVersionChangeKind>()
	let detail: string | null = null

	if (prev.name !== next.name) {
		kinds.add("renamed")
		detail = `Renamed to "${next.name}"`
	}

	if ((prev.description ?? "") !== (next.description ?? "")) {
		kinds.add("description_changed")
		detail = detail ?? "Description updated"
	}

	if (!sameJson(prev.tags ?? [], next.tags ?? [])) {
		kinds.add("tags_changed")
		detail = detail ?? "Tags updated"
	}

	if (!sameJson(prev.timeRange, next.timeRange)) {
		kinds.add("time_range_changed")
		const value = next.timeRange.type === "relative" ? next.timeRange.value : "absolute range"
		detail = detail ?? `Time range set to ${value}`
	}

	const prevById = new Map(prev.widgets.map((w) => [w.id, w] as const))
	const nextById = new Map(next.widgets.map((w) => [w.id, w] as const))

	const added = next.widgets.filter((w) => !prevById.has(w.id))
	const removed = prev.widgets.filter((w) => !nextById.has(w.id))

	if (added.length > 0) {
		kinds.add("widget_added")
		detail =
			detail ??
			(added.length === 1 ? `Added "${widgetTitle(added[0]!)}"` : `Added ${added.length} widgets`)
	}

	if (removed.length > 0) {
		kinds.add("widget_removed")
		detail =
			detail ??
			(removed.length === 1
				? `Removed "${widgetTitle(removed[0]!)}"`
				: `Removed ${removed.length} widgets`)
	}

	let contentChanged: Widget | null = null
	let contentChangedCount = 0
	let layoutChanged = false

	for (const nextWidget of next.widgets) {
		const prevWidget = prevById.get(nextWidget.id)
		if (!prevWidget) continue
		if (!widgetContentEqual(prevWidget, nextWidget)) {
			contentChanged = contentChanged ?? nextWidget
			contentChangedCount += 1
		}
		if (!layoutEqual(prevWidget, nextWidget)) {
			layoutChanged = true
		}
	}

	if (contentChanged) {
		kinds.add("widget_updated")
		detail =
			detail ??
			(contentChangedCount === 1
				? `Updated "${widgetTitle(contentChanged)}"`
				: `Updated ${contentChangedCount} widgets`)
	}

	if (layoutChanged) {
		kinds.add("layout_changed")
		detail = detail ?? "Layout changed"
	}

	if (kinds.size === 0) {
		return { kind: "multiple", summary: "No changes" }
	}

	if (kinds.size > 1) {
		return { kind: "multiple", summary: "Multiple changes" }
	}

	const [kind] = kinds
	return { kind: kind!, summary: detail ?? "Updated" }
}

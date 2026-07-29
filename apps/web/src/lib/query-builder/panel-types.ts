import { getChartById } from "@maple/ui/components/charts/registry"
import type { VisualizationType } from "@/components/dashboard-builder/types"

// ---------------------------------------------------------------------------
// Panel types — the single user-facing "what kind of panel is this?" axis.
//
// Persistence keeps two fields: `visualization` (the widget kind, which decides
// the renderer and the data-source endpoint) and `display.chartId` (a
// `chartRegistry` entry, which decides which chart component a `chart` widget
// mounts). Those are two overlapping axes, and exposing both in the editor
// produced a "Chart Style" dropdown that offered `query-builder-pie` while
// leaving `visualization: "chart"` — a pie renderer fed timeseries rows.
//
// A PanelType collapses them into one closed list. The editor picks a PanelType;
// this module converts to and from the persisted pair. Nothing about the stored
// widget shape changes, so no migration is needed.
// ---------------------------------------------------------------------------

export type PanelType =
	| "line"
	| "bar"
	| "area"
	| "stat"
	| "gauge"
	| "table"
	| "list"
	| "pie"
	| "histogram"
	| "heatmap"
	| "funnel"
	| "markdown"

export const PANEL_TYPES: ReadonlyArray<{ value: PanelType; label: string }> = [
	{ value: "line", label: "Line" },
	{ value: "bar", label: "Bar" },
	{ value: "area", label: "Area" },
	{ value: "pie", label: "Pie" },
	{ value: "stat", label: "Stat" },
	{ value: "gauge", label: "Gauge" },
	{ value: "table", label: "Table" },
	{ value: "list", label: "List" },
	{ value: "histogram", label: "Histogram" },
	{ value: "heatmap", label: "Heatmap" },
	{ value: "funnel", label: "Funnel" },
	{ value: "markdown", label: "Note" },
]

/** Panel types that render a `chart` widget, distinguished only by `chartId`. */
const CHART_PANEL_TYPES = ["line", "bar", "area"] as const
type ChartPanelType = (typeof CHART_PANEL_TYPES)[number]

/** Panel types that are their own `visualization` AND carry a canonical chartId. */
const BREAKDOWN_PANEL_TYPES = ["pie", "histogram", "heatmap", "funnel"] as const
type BreakdownPanelType = (typeof BREAKDOWN_PANEL_TYPES)[number]

const isChartPanelType = (value: string): value is ChartPanelType =>
	(CHART_PANEL_TYPES as ReadonlyArray<string>).includes(value)

const isBreakdownPanelType = (value: string): value is BreakdownPanelType =>
	(BREAKDOWN_PANEL_TYPES as ReadonlyArray<string>).includes(value)

const isPanelType = (value: string): value is PanelType =>
	PANEL_TYPES.some((panel) => panel.value === value)

/**
 * The chartId written when a panel type needs one. Every widget kind that mounts
 * a `chartRegistry` component gets its canonical `query-builder-*` entry so the
 * `?? "query-builder-pie"` fallbacks in pie/funnel/histogram/heatmap-widget.tsx
 * never have to paper over a stale id from a previous type.
 */
export function canonicalChartId(panel: PanelType): string | undefined {
	if (isChartPanelType(panel) || isBreakdownPanelType(panel)) return `query-builder-${panel}`
	return undefined
}

/**
 * Derive the panel type from a persisted widget.
 *
 * The `chartId` default mirrors `toInitialState` rather than `ChartWidget`'s own
 * fallback so the picker and the canvas agree on what a chart widget with no
 * `chartId` is.
 */
export function toPanelType(visualization: string, chartId?: string): PanelType {
	if (visualization === "chart") {
		const category = getChartById(chartId ?? "query-builder-line")?.category
		// A `chart` widget carrying a pie/funnel/heatmap/histogram chartId is a
		// widget corrupted by the old "Chart Style" dropdown. Reporting its real
		// panel type here is what lets `toInitialState` repair it on open.
		if (category && isPanelType(category)) return category
		return "line"
	}
	if (isPanelType(visualization)) return visualization
	return "line"
}

/**
 * Convert a panel type back to the persisted pair.
 *
 * `currentChartId` is preserved when its category already matches the target
 * panel, so selecting the panel type a widget already has never rewrites a
 * non-canonical style (`latency-line`, `gradient-area`, …) and never makes a
 * no-op click read as a dirty edit.
 */
export function fromPanelType(
	panel: PanelType,
	currentChartId?: string,
): { visualization: VisualizationType; chartId: string | undefined } {
	const visualization: VisualizationType = isChartPanelType(panel) ? "chart" : panel

	if (currentChartId && getChartById(currentChartId)?.category === panel) {
		return { visualization, chartId: currentChartId }
	}
	return { visualization, chartId: canonicalChartId(panel) }
}

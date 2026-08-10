import { getChartById } from "@maple/ui/components/charts/registry"
import {
	PANEL_TYPES as WIDGET_TYPE_LIST,
	WIDGET_TYPES,
	isPanelType,
	type PanelType,
} from "@maple/domain/http"
import type { VisualizationType } from "@/components/dashboard-builder/types"

// Panel types — the single user-facing "what kind of panel is this?" axis.
//
// Persistence keeps two fields: `visualization` (the widget kind, which decides
// the renderer and the data-source endpoint) and `display.chartId` (a
// `chartRegistry` entry, which decides which chart component a `chart` widget
// mounts). Those are two overlapping axes, and exposing both in the editor
// produced a "Chart Style" dropdown that offered `query-builder-pie` while
// leaving `visualization: "chart"` — a pie renderer fed timeseries rows.
//
// A PanelType collapses them into one closed list, described once in
// `@maple/domain`'s widget-type table. This module is the pair of converters
// between that list and the persisted fields; it is the only place that needs
// the live chart registry, because repairing a corrupted widget means asking
// what category its `chartId` actually belongs to.

export type { PanelType }

/** The Type picker's options, in display order. */
export const PANEL_TYPES: ReadonlyArray<{ value: PanelType; label: string }> = WIDGET_TYPE_LIST.map(
	(meta) => ({ value: meta.panelType, label: meta.label }),
)

/**
 * The chartId written when a panel type needs one. Every widget kind that mounts
 * a `chartRegistry` component gets its canonical `query-builder-*` entry so the
 * renderer's own `?? "query-builder-pie"` fallback never has to paper over a
 * stale id from a previous type.
 */
export function canonicalChartId(panel: PanelType): string | undefined {
	return WIDGET_TYPES[panel].chartId
}

/**
 * Derive the panel type from a persisted widget.
 *
 * The `chartId` default mirrors `toInitialState` rather than the renderer's own
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
	const visualization = WIDGET_TYPES[panel].visualization

	if (currentChartId && getChartById(currentChartId)?.category === panel) {
		return { visualization, chartId: currentChartId }
	}
	return { visualization, chartId: canonicalChartId(panel) }
}

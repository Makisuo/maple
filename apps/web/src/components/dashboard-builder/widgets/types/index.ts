import type { PanelType } from "@maple/domain/http"

import type {
	VisualizationComponent,
	WidgetTypeDefinition,
} from "@/components/dashboard-builder/widgets/widget-type-registry"
import { areaWidgetType, barWidgetType, lineWidgetType } from "./chart"
import {
	funnelWidgetType,
	hbarWidgetType,
	heatmapWidgetType,
	histogramWidgetType,
	pieWidgetType,
} from "./breakdown"
import { gaugeWidgetType } from "./gauge"
import { listWidgetType } from "./list"
import { markdownWidgetType } from "./markdown"
import { statWidgetType } from "./stat"
import { tableWidgetType } from "./table"

/**
 * Every widget type the app can render, configure and persist.
 *
 * `Record<PanelType, …>` is exhaustive on purpose: adding a member to `PanelType`
 * in `@maple/domain` is a compile error here until the type has a definition, and
 * a definition is a compile error until it has a renderer, a settings panel and
 * the three lowering functions. That replaces the ~35 hand-kept edit sites a new
 * widget type used to need.
 */
export const widgetTypes: Record<PanelType, WidgetTypeDefinition> = {
	line: lineWidgetType,
	bar: barWidgetType,
	hbar: hbarWidgetType,
	area: areaWidgetType,
	stat: statWidgetType,
	gauge: gaugeWidgetType,
	table: tableWidgetType,
	list: listWidgetType,
	pie: pieWidgetType,
	histogram: histogramWidgetType,
	heatmap: heatmapWidgetType,
	funnel: funnelWidgetType,
	markdown: markdownWidgetType,
}

/** In Type-picker order. */
export const widgetTypeList: ReadonlyArray<WidgetTypeDefinition> = [
	lineWidgetType,
	barWidgetType,
	hbarWidgetType,
	areaWidgetType,
	pieWidgetType,
	statWidgetType,
	gaugeWidgetType,
	tableWidgetType,
	listWidgetType,
	histogramWidgetType,
	heatmapWidgetType,
	funnelWidgetType,
	markdownWidgetType,
]

/**
 * The definition for a persisted `visualization`. `chart` is ambiguous — three
 * panel types share it — so callers holding a `chartId` should go through
 * `toPanelType` first. The renderer is the same for all three regardless.
 */
export function widgetTypeFor(visualization: string): WidgetTypeDefinition {
	if (visualization === "chart") return lineWidgetType
	const definition = widgetTypes[visualization as PanelType]
	if (definition) return definition
	// A persisted document can name a type this build doesn't have — an older
	// client reading a newer dashboard, or a hand-edited JSON import. Rendering a
	// line chart over the wrong data shape is the long-standing behavior; the
	// warning is so it stops being silent.
	console.warn(`[dashboard] unknown visualization "${visualization}" — rendering as a line chart`)
	return lineWidgetType
}

/** `visualization` string → the component that draws it. */
export const visualizationFor = (visualization: string): VisualizationComponent =>
	widgetTypeFor(visualization).Renderer

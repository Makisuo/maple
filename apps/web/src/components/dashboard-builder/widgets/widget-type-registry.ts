import type { ComponentType } from "react"
import type { WidgetTypeMeta } from "@maple/domain/http"

import type { IconComponent } from "@/components/icons"
import type {
	DashboardWidget,
	WidgetDataState,
	WidgetDisplayConfig,
	WidgetMode,
} from "@/components/dashboard-builder/types"
import type { WidgetPresetDefinition } from "@/components/dashboard-builder/widgets/widget-definitions"
import type {
	BuildDataSourceContext,
	QueryBuilderWidgetState,
} from "@/lib/query-builder/widget-builder-shared"
import type { WidgetDataSource } from "@/components/dashboard-builder/types"
import type { QueryBuilderQueryDraft } from "@maple/query-engine/query-builder"

// The widget-type framework.
//
// A `WidgetTypeDefinition` is everything the app needs to know about one kind of
// widget: how to draw it, how to configure it, how to lower its editor state to
// a persisted `dataSource` + `display`, and when that state is invalid. Adding a
// widget type is a new file under `./types/` plus one line in `widgetTypes`.
//
// Before this, the same twelve types were described by ~35 scattered edit sites:
// four if-chains in `widget-builder-utils.ts`, nine boolean flags in the settings
// rail, nine more in the picker, four forked copies of the default grid size, and
// a `Record<string, Component>` that fell back to a line chart on a typo.
//
// The type-agnostic half — labels, layout, owned display keys, MCP exposure,
// Perses kinds — lives in `@maple/domain` so the API and the MCP tools read the
// same table. This module adds the parts that only exist in a browser.

export type VisualizationComponent = ComponentType<{
	dataState: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
	/**
	 * The widget's configured row cap, when it has one. Lives on the data source
	 * rather than the display, so it is threaded in separately: a table that
	 * returned exactly this many rows is showing a truncated top-N, and says so.
	 */
	rowLimit?: number
}>

export interface BuildDisplayContext {
	widget: DashboardWidget
	state: QueryBuilderWidgetState
	/**
	 * The shared display: the previous display with every owned key cleared, plus
	 * title, description, chart presentation and the canonical `chartId`. Types
	 * layer their own keys on top; a type that owns the whole display (a list) can
	 * ignore it and build from scratch.
	 */
	base: WidgetDisplayConfig
	/**
	 * The plain timeseries data source for this widget's queries — the same
	 * `base` a `buildDataSource` receives, before any type-specific reduction.
	 * A stat's sparkline is exactly this: its own query without the scalar
	 * `reduceToValue`.
	 */
	timeseriesDataSource: WidgetDataSource
}

export interface ValidateContext {
	state: QueryBuilderWidgetState
	/** Queries with `enabled !== false`, already checked for a valid spec. */
	activeQueries: QueryBuilderQueryDraft[]
	/** `activeQueries` minus hidden ones — what actually reaches the warehouse. */
	visibleQueries: QueryBuilderQueryDraft[]
}

export interface WidgetTypeDefinition {
	meta: WidgetTypeMeta
	icon: IconComponent
	Renderer: VisualizationComponent
	/**
	 * Which editor the left half of the widget editor shows. `"builder"` is the
	 * query builder; `"list"` and `"markdown"` are their own panels and skip
	 * query validation entirely.
	 */
	queryEditor: "builder" | "list" | "markdown"
	/** The type-specific half of the settings rail. Reads state from context. */
	ConfigPanel: ComponentType
	/** Ready-made widgets offered in the "Add widget" picker. */
	presets: WidgetPresetDefinition[]
	/**
	 * Thumbnail for one of this type's presets, drawn from hard-coded sample data
	 * so the picker renders instantly and offline. Required when `presets` is
	 * non-empty — a preset with no preview is a blank card.
	 */
	PresetPreview?: ComponentType<{ preset: WidgetPresetDefinition }>
	/** Editor state read out of a persisted widget, beyond the shared fields. */
	initialState?: (widget: DashboardWidget) => Partial<QueryBuilderWidgetState>
	buildDataSource: (ctx: BuildDataSourceContext) => WidgetDataSource
	buildDisplay: (ctx: BuildDisplayContext) => WidgetDisplayConfig
	/** Returns a message that blocks Apply, or `null`. Shared rules run first. */
	validate?: (ctx: ValidateContext) => string | null
}

/**
 * Helper for the common case: keep the shared display and add the keys this type
 * owns. Undefined values are dropped so an unset key stays absent rather than
 * being persisted as `key: undefined`, which `optionalKey` encoding rejects.
 */
export const extendDisplay = (
	base: WidgetDisplayConfig,
	own: Partial<WidgetDisplayConfig>,
): WidgetDisplayConfig => {
	const display = { ...base, ...own }
	for (const [key, value] of Object.entries(own)) {
		if (value === undefined) delete display[key as keyof WidgetDisplayConfig]
	}
	return display
}

export type { WidgetTypeMeta }

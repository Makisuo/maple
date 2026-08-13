import { Effect, Schema } from "effect"
import {
	DashboardValidationError,
	DashboardWidgetSchema,
	PortableDashboardDocument,
	type RawSqlDisplayType,
	defaultWidgetLayout,
	findNextPosition,
	widgetTypeByPersesKind,
	widgetTypeByVisualization,
	type WidgetVisualization,
} from "@maple/domain/http"

type UnknownRecord = Record<string, unknown>
type DashboardWidget = typeof DashboardWidgetSchema.Type

export interface PersesImportConversion {
	readonly dashboard: PortableDashboardDocument
	readonly warnings: readonly string[]
}

const decodePortableDashboard = Schema.decodeUnknownSync(PortableDashboardDocument)

const SUPPORTED_PANEL_KINDS = new Set([
	"Markdown",
	"TimeSeriesChart",
	"BarChart",
	"StatChart",
	"GaugeChart",
	"Table",
	"LogsTable",
	"TimeSeriesTable",
	"PieChart",
	"Histogram",
	"HistogramChart",
	"HeatMap",
	"HeatMapChart",
	"Heatmap",
])

const isRecord = (value: unknown): value is UnknownRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const asRecord = (value: unknown): UnknownRecord | null => (isRecord(value) ? value : null)

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim().length > 0 ? value : undefined

const asFiniteNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined

const sanitizeIdSegment = (value: string): string => {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return normalized.length > 0 ? normalized : "panel"
}

const jsonPointerSegment = (segment: string): string =>
	decodeURIComponent(segment.replace(/~1/g, "/").replace(/~0/g, "~"))

function panelKeyFromRef(ref: string): string | null {
	const prefix = "#/spec/panels/"
	if (!ref.startsWith(prefix)) return null
	return jsonPointerSegment(ref.slice(prefix.length))
}

function panelKeyFromGridContent(content: unknown): string | null {
	const record = asRecord(content)
	if (!record) return null
	const ref = asString(record.$ref)
	return ref ? panelKeyFromRef(ref) : null
}

function getDisplay(record: UnknownRecord | null) {
	const display = asRecord(record?.display)
	return {
		title: asString(display?.name),
		description: asString(display?.description),
	}
}

function getPanelPlugin(panel: unknown) {
	const panelRecord = asRecord(panel)
	const spec = asRecord(panelRecord?.spec)
	const plugin = asRecord(spec?.plugin)
	return {
		spec,
		kind: asString(plugin?.kind),
		pluginSpec: asRecord(plugin?.spec),
	}
}

// Perses panel `kind` → Maple panel type lives in the shared widget-type table
// (`persesKinds`), so adding a widget kind can't leave the importer behind.
// Unknown kinds fall back to a line chart, as they always have.

const defaultVisualizationForPanelKind = (kind: string | undefined): WidgetVisualization =>
	widgetTypeByPersesKind(kind).visualization

const displayTypeForPanelKind = (kind: string | undefined): RawSqlDisplayType =>
	// Notes carry no SQL rendering; the caller only reaches this for query panels.
	widgetTypeByPersesKind(kind).rawSqlDisplayType ?? "line"

function displayForPanel(args: {
	kind: string | undefined
	title: string
	description?: string
	pluginSpec: UnknownRecord | null
}): Record<string, unknown> {
	const unit = asString(args.pluginSpec?.unit)
	const base: Record<string, unknown> = {
		title: args.title,
		...(args.description ? { description: args.description } : {}),
		...(unit ? { unit } : {}),
	}

	switch (args.kind) {
		// `seriesStats` follows the same rule as the dashboard templates: on for
		// line charts, where the series are levels and the answer is a number;
		// off for stacked bars, where per-series stats under a cumulative plot
		// only duplicate the tooltip. See CHART_DISPLAY_* in dashboard-templates.
		case "TimeSeriesChart":
			return {
				...base,
				chartId: "query-builder-line",
				chartPresentation: { legend: "visible", seriesStats: true },
				stacked: false,
				curveType: "monotone",
			}
		case "BarChart":
			return {
				...base,
				chartId: "query-builder-bar",
				chartPresentation: { legend: "visible", seriesStats: false },
				stacked: true,
				curveType: "linear",
			}
		case "PieChart":
			return { ...base, chartId: "query-builder-pie" }
		case "Histogram":
		case "HistogramChart":
			return { ...base, chartId: "query-builder-histogram" }
		case "HeatMap":
		case "HeatMapChart":
		case "Heatmap":
			return { ...base, chartId: "query-builder-heatmap" }
		case "GaugeChart":
			return {
				...base,
				gauge: {
					...(typeof args.pluginSpec?.min === "number" ? { min: args.pluginSpec.min } : {}),
					...(typeof args.pluginSpec?.max === "number" ? { max: args.pluginSpec.max } : {}),
				},
			}
		default:
			return base
	}
}

/**
 * Heights and minimums come from the shared widget-type table. The width does
 * not: a Perses panel with no `gridLayout` entry is a full-row panel in its
 * source dashboard, so everything but a stat imports at the half-width `w: 6`
 * rather than the `w: 4` the web store hands a click-added widget.
 */
function defaultLayoutForVisualization(visualization: string) {
	const { w, h, minW, minH } = defaultWidgetLayout(visualization)
	if (visualization === "stat") return { w, h, minW, minH }
	return { w: 6, h, minW: 3, minH }
}

function nextLayout(widgets: readonly DashboardWidget[], visualization: string) {
	const defaults = defaultLayoutForVisualization(visualization)
	return { ...findNextPosition(widgets, defaults.w), ...defaults }
}

function gridLayoutFromItem(
	item: unknown,
	fallbackVisualization: string,
	yOffset: number,
	warnings: string[],
	panelKey: string,
) {
	const record = asRecord(item)
	const defaults = defaultLayoutForVisualization(fallbackVisualization)
	const rawX = asFiniteNumber(record?.x) ?? 0
	const rawY = asFiniteNumber(record?.y) ?? 0
	const rawW = asFiniteNumber(record?.width) ?? defaults.w
	const rawH = asFiniteNumber(record?.height) ?? defaults.h

	const x = Math.min(11, Math.max(0, Math.floor(rawX)))
	const y = yOffset + Math.max(0, Math.floor(rawY))
	const w = Math.min(12 - x, Math.max(1, Math.floor(rawW)))
	const h = Math.max(2, Math.floor(rawH))

	if (x !== rawX || y !== yOffset + rawY || w !== rawW || h !== rawH) {
		warnings.push(`Clamped layout for Perses panel "${panelKey}" to Maple's 12-column grid.`)
	}

	return { x, y, w, h, minW: defaults.minW, minH: defaults.minH }
}

function uniqueWidgetId(panelKey: string, existing: Set<string>): string {
	const base = `perses-${sanitizeIdSegment(panelKey)}`
	let candidate = base
	let index = 2
	while (existing.has(candidate)) {
		candidate = `${base}-${index++}`
	}
	existing.add(candidate)
	return candidate
}

function queryPluginFromQuery(query: unknown) {
	const queryRecord = asRecord(query)
	const spec = asRecord(queryRecord?.spec)
	const plugin = asRecord(spec?.plugin)
	const pluginSpec = asRecord(plugin?.spec)
	return {
		kind: asString(plugin?.kind),
		query: asString(pluginSpec?.query),
	}
}

function querySummaries(queries: readonly unknown[]): string[] {
	return queries.map((query, index) => {
		const plugin = queryPluginFromQuery(query)
		if (plugin.query) {
			return `Query ${index + 1}: ${plugin.kind ?? "UnknownQuery"} - ${plugin.query}`
		}
		return `Query ${index + 1}: ${plugin.kind ?? "UnknownQuery"}`
	})
}

function hasOrgScope(sql: string): boolean {
	return sql.includes("$__orgFilter") || /\bOrgId\b/.test(sql)
}

function insertBeforeTrailingClauses(sql: string, fragment: string): string {
	const match = /\b(GROUP\s+BY|ORDER\s+BY|LIMIT|FORMAT)\b/i.exec(sql)
	if (!match) return `${sql.trimEnd()} ${fragment}`
	return `${sql.slice(0, match.index).trimEnd()} ${fragment} ${sql.slice(match.index).trimStart()}`
}

function normalizeClickHouseSql(sql: string, warnings: string[], panelTitle: string): string | null {
	if (!hasOrgScope(sql)) {
		warnings.push(
			`Panel "${panelTitle}" was imported as a placeholder because its ClickHouse query does not include $__orgFilter or an OrgId predicate.`,
		)
		return null
	}

	const normalized = sql.includes("$__orgFilter")
		? sql
		: insertBeforeTrailingClauses(sql, /\bWHERE\b/i.test(sql) ? "AND $__orgFilter" : "WHERE $__orgFilter")

	if (!sql.includes("$__orgFilter")) {
		warnings.push(
			`Panel "${panelTitle}" had an explicit OrgId reference; Maple added $__orgFilter so the widget stays tenant-scoped.`,
		)
	}

	if (!/\$__timeFilter|\$__startTime|\$__endTime/.test(normalized)) {
		warnings.push(
			`Panel "${panelTitle}" does not use Maple time macros, so the dashboard time picker may not affect it.`,
		)
	}

	return normalized
}

function rawSqlDataSource(args: {
	visualization: string
	sql: string
	displayType: RawSqlDisplayType
}): DashboardWidget["dataSource"] {
	const base: DashboardWidget["dataSource"] = {
		endpoint: "raw_sql_chart",
		params: {
			sql: args.sql,
			displayType: args.displayType,
		},
	}

	// `displayType === "stat"` is kept alongside the panel's own scalar flag: a
	// Perses panel can import as a non-scalar type while its query still yields
	// the single-row shape a stat renders.
	if (args.displayType === "stat" || widgetTypeByVisualization(args.visualization)?.isScalar === true) {
		return {
			...base,
			transform: { reduceToValue: { field: "value", aggregate: "first" } },
		}
	}

	return base
}

function markdownDataSource(): DashboardWidget["dataSource"] {
	return { endpoint: "markdown_static" }
}

function markdownWidgetContent(args: {
	reason: string
	panelKind?: string
	querySummaries?: readonly string[]
}) {
	const lines = [
		"### Perses import placeholder",
		args.reason,
		...(args.panelKind ? [`Panel plugin: \`${args.panelKind}\``] : []),
	]

	if (args.querySummaries && args.querySummaries.length > 0) {
		lines.push("", "Queries:")
		for (const summary of args.querySummaries) {
			lines.push(`- ${summary}`)
		}
	}

	return lines.join("\n")
}

function placeholderWidget(args: {
	id: string
	title: string
	description?: string
	layout: DashboardWidget["layout"]
	reason: string
	panelKind?: string
	querySummaries?: readonly string[]
}): DashboardWidget {
	return {
		id: args.id,
		visualization: "markdown",
		dataSource: markdownDataSource(),
		display: {
			title: args.title,
			...(args.description ? { description: args.description } : {}),
			markdown: {
				content: markdownWidgetContent({
					reason: args.reason,
					panelKind: args.panelKind,
					querySummaries: args.querySummaries,
				}),
			},
		},
		layout: args.layout,
	}
}

function convertPanel(args: {
	panelKey: string
	panel: unknown
	layout: DashboardWidget["layout"]
	warnings: string[]
	widgetIds: Set<string>
}): DashboardWidget {
	const { spec, kind, pluginSpec } = getPanelPlugin(args.panel)
	const display = getDisplay(spec)
	const title = display.title ?? args.panelKey
	const id = uniqueWidgetId(args.panelKey, args.widgetIds)
	const visualization = defaultVisualizationForPanelKind(kind)

	if (!kind) {
		args.warnings.push(
			`Panel "${title}" is missing a Perses plugin kind and was imported as a placeholder.`,
		)
		return placeholderWidget({
			id,
			title,
			description: display.description,
			layout: args.layout,
			reason: "This panel is missing a Perses plugin kind.",
		})
	}

	if (!SUPPORTED_PANEL_KINDS.has(kind)) {
		args.warnings.push(`Panel "${title}" uses unsupported Perses plugin "${kind}".`)
		return placeholderWidget({
			id,
			title,
			description: display.description,
			layout: args.layout,
			reason: "This Perses panel plugin is not supported by the Maple importer yet.",
			panelKind: kind,
			querySummaries: querySummaries(asArray(spec?.queries)),
		})
	}

	if (kind === "Markdown") {
		const text = asString(pluginSpec?.text) ?? ""
		if (!text) {
			args.warnings.push(`Markdown panel "${title}" has no text content.`)
		}
		return {
			id,
			visualization: "markdown",
			dataSource: markdownDataSource(),
			display: {
				title,
				...(display.description ? { description: display.description } : {}),
				markdown: { content: text },
			},
			layout: args.layout,
		}
	}

	const queries = asArray(spec?.queries)
	if (queries.length === 0) {
		args.warnings.push(`Panel "${title}" has no queries and was imported as a placeholder.`)
		return placeholderWidget({
			id,
			title,
			description: display.description,
			layout: args.layout,
			reason: "This Perses panel has no query to execute.",
			panelKind: kind,
		})
	}

	if (queries.length > 1) {
		args.warnings.push(`Panel "${title}" has multiple queries; Maple imported only the first query.`)
	}

	const queryPlugin = queryPluginFromQuery(queries[0])
	if (queryPlugin.kind !== "ClickHouseTimeSeriesQuery" && queryPlugin.kind !== "ClickHouseLogQuery") {
		args.warnings.push(
			`Panel "${title}" uses unsupported query plugin "${queryPlugin.kind ?? "UnknownQuery"}".`,
		)
		return placeholderWidget({
			id,
			title,
			description: display.description,
			layout: args.layout,
			reason: "This query plugin is not supported by the Maple importer yet.",
			panelKind: kind,
			querySummaries: querySummaries(queries),
		})
	}

	if (!queryPlugin.query) {
		args.warnings.push(
			`Panel "${title}" has an empty ClickHouse query and was imported as a placeholder.`,
		)
		return placeholderWidget({
			id,
			title,
			description: display.description,
			layout: args.layout,
			reason: "This ClickHouse query is empty.",
			panelKind: kind,
			querySummaries: querySummaries(queries),
		})
	}

	const sql = normalizeClickHouseSql(queryPlugin.query, args.warnings, title)
	if (!sql) {
		return placeholderWidget({
			id,
			title,
			description: display.description,
			layout: args.layout,
			reason: "This ClickHouse query needs Maple org scoping before it can run.",
			panelKind: kind,
			querySummaries: querySummaries(queries),
		})
	}

	return {
		id,
		visualization,
		dataSource: rawSqlDataSource({
			visualization,
			sql,
			displayType: queryPlugin.kind === "ClickHouseLogQuery" ? "table" : displayTypeForPanelKind(kind),
		}),
		display: displayForPanel({
			kind,
			title,
			description: display.description,
			pluginSpec,
		}),
		layout: args.layout,
	}
}

function convertSync(input: unknown): PersesImportConversion {
	const root = asRecord(input)
	if (!root || root.kind !== "Dashboard") {
		throw new DashboardValidationError({
			message: "Invalid Perses dashboard",
			details: ['Expected a Perses resource with kind "Dashboard".'],
		})
	}

	const spec = asRecord(root.spec)
	if (!spec) {
		throw new DashboardValidationError({
			message: "Invalid Perses dashboard",
			details: ["Dashboard spec must be an object."],
		})
	}

	const warnings: string[] = []
	const metadata = asRecord(root.metadata)
	const dashboardDisplay = getDisplay(spec)
	const name = dashboardDisplay.title ?? asString(metadata?.name) ?? "Imported Perses Dashboard"
	const description = dashboardDisplay.description
	const duration = asString(spec.duration)

	if (!duration) {
		warnings.push('Perses duration is missing or invalid; Maple defaulted the dashboard range to "12h".')
	}

	if (asArray(spec.variables).length > 0) {
		warnings.push("Perses dashboard variables are not imported; affected queries may need manual edits.")
	}

	if (Object.keys(asRecord(spec.datasources) ?? {}).length > 0) {
		warnings.push(
			"Perses datasource definitions are not stored; imported ClickHouse widgets run through Maple raw SQL.",
		)
	}

	const panels = asRecord(spec.panels)
	if (!panels || Object.keys(panels).length === 0) {
		throw new DashboardValidationError({
			message: "Invalid Perses dashboard",
			details: ["Dashboard spec.panels must contain at least one panel."],
		})
	}

	const widgets: DashboardWidget[] = []
	const widgetIds = new Set<string>()
	const placedPanels = new Set<string>()
	let yOffset = 0
	const layouts = asArray(spec.layouts)

	for (const [layoutIndex, layout] of layouts.entries()) {
		const layoutRecord = asRecord(layout)
		if (layoutRecord?.kind !== "Grid") {
			warnings.push(
				`Unsupported Perses layout at index ${layoutIndex}; only Grid layouts are imported.`,
			)
			continue
		}

		const items = asArray(asRecord(layoutRecord.spec)?.items)
		let gridBottom = yOffset
		for (const [itemIndex, item] of items.entries()) {
			const itemRecord = asRecord(item)
			const panelKey = panelKeyFromGridContent(itemRecord?.content)
			if (!panelKey) {
				warnings.push(
					`Grid item ${layoutIndex}.${itemIndex} does not reference a panel and was skipped.`,
				)
				continue
			}

			const panel = panels[panelKey]
			if (!panel) {
				warnings.push(`Grid item ${layoutIndex}.${itemIndex} references missing panel "${panelKey}".`)
				continue
			}

			const panelKind = getPanelPlugin(panel).kind
			const visualization = defaultVisualizationForPanelKind(panelKind)
			const layoutForWidget = gridLayoutFromItem(item, visualization, yOffset, warnings, panelKey)
			const widget = convertPanel({ panelKey, panel, layout: layoutForWidget, warnings, widgetIds })
			widgets.push(widget)
			placedPanels.add(panelKey)
			gridBottom = Math.max(gridBottom, layoutForWidget.y + layoutForWidget.h)
		}
		yOffset = Math.max(yOffset, gridBottom)
	}

	if (layouts.length === 0) {
		warnings.push("Perses dashboard has no layouts; Maple generated layouts for imported panels.")
	}

	for (const [panelKey, panel] of Object.entries(panels)) {
		if (placedPanels.has(panelKey)) continue
		const panelKind = getPanelPlugin(panel).kind
		const visualization = defaultVisualizationForPanelKind(panelKind)
		const layout = nextLayout(widgets, visualization)
		warnings.push(
			`Panel "${panelKey}" was not referenced by a layout; Maple generated a position for it.`,
		)
		widgets.push(convertPanel({ panelKey, panel, layout, warnings, widgetIds }))
	}

	return {
		dashboard: decodePortableDashboard({
			name,
			...(description ? { description } : {}),
			tags: ["perses-import"],
			timeRange: { type: "relative", value: duration ?? "12h" },
			widgets,
		}),
		warnings,
	}
}

export const convertPersesDashboardToPortable = Effect.fn("PersesDashboardImport.convert")(function* (
	input: unknown,
) {
	return yield* Effect.try({
		try: () => convertSync(input),
		catch: (error) =>
			error instanceof DashboardValidationError
				? error
				: new DashboardValidationError({
						message: "Invalid Perses dashboard",
						details: [error instanceof Error ? error.message : String(error)],
					}),
	})
})

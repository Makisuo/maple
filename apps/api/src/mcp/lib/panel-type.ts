import {
	isMcpPanelType,
	isMcpVisualization,
	MCP_PANEL_TYPES,
	rawSqlDisplayTypeFor,
	WIDGET_TYPES,
	widgetTypeByVisualization,
	type PanelType,
	type RawSqlDisplayType,
	type WidgetTypeMeta,
} from "@maple/domain/http"

/**
 * One decision, one field.
 *
 * "What kind of chart is this" used to be spread across three MCP parameters:
 * `visualization` (which collapses line/bar/area into `"chart"`),
 * `display_json.chartId` (which tells those three apart, and was documented
 * nowhere), and `display_type` (a third spelling, raw-SQL only). An agent had to
 * reassemble the answer from all three, and the failure was silent — a
 * `visualization: "chart"` with no `chartId` is a line chart whatever you meant,
 * and `visualization: "list"` with `sql` renders as a line chart because `list`
 * has no raw-SQL display type and the lookup falls back.
 *
 * `panel_type` is the whole decision. Everything else is derived from
 * `WIDGET_TYPES`, which is already the table relating them.
 */

export interface ResolvedPanelType {
	readonly meta: WidgetTypeMeta
	readonly panelType: PanelType
	/** The persisted `visualization` field. */
	readonly visualization: WidgetTypeMeta["visualization"]
	/** The `chartId` to write when the caller supplied none. */
	readonly chartId: string | undefined
	readonly rawSqlDisplayType: RawSqlDisplayType | undefined
}

export interface PanelTypeInput {
	readonly panel_type?: string | undefined
	readonly visualization?: string | undefined
	/** An explicit `display_json.chartId`, which wins over the panel default. */
	readonly chartId?: string | undefined
}

export type PanelTypeResolution =
	| { readonly ok: true; readonly resolved: ResolvedPanelType }
	| { readonly ok: false; readonly error: string; readonly example?: string }

const panelTypeList = MCP_PANEL_TYPES.map((panel) => `"${panel}"`).join(", ")

/** Rendered into tool descriptions so the accepted list can't drift from the table. */
export const PANEL_TYPE_LIST_MD = MCP_PANEL_TYPES.map((panel) => `\`${panel}\``).join(", ")

export const resolvePanelType = (input: PanelTypeInput): PanelTypeResolution => {
	const panelTypeRaw = input.panel_type?.trim()
	const visualizationRaw = input.visualization?.trim()

	if (!panelTypeRaw && !visualizationRaw) {
		return {
			ok: false,
			error: `Missing \`panel_type\`. Must be exactly one of: ${panelTypeList}. This is the widget KIND, not a title — set the title via \`display_json.title\`.`,
			example: '{ "panel_type": "line" }',
		}
	}

	if (panelTypeRaw && !isMcpPanelType(panelTypeRaw)) {
		// The most common wrong value is a `visualization` spelling, so say which
		// panel type that maps to rather than only listing the legal set.
		const asVisualization = isMcpVisualization(panelTypeRaw)
			? widgetTypeByVisualization(panelTypeRaw)
			: undefined
		const hint = asVisualization
			? ` \`${panelTypeRaw}\` is a \`visualization\` value; the matching panel type is \`${asVisualization.panelType}\`.`
			: ""
		return {
			ok: false,
			error: `\`panel_type\` must be exactly one of: ${panelTypeList}. Got: ${JSON.stringify(panelTypeRaw)}.${hint}`,
			example: '{ "panel_type": "bar" }',
		}
	}

	if (!panelTypeRaw && visualizationRaw && !isMcpVisualization(visualizationRaw)) {
		return {
			ok: false,
			error: `\`visualization\` must be one of: ${[...new Set(MCP_PANEL_TYPES.map((p) => WIDGET_TYPES[p].visualization))].map((v) => `"${v}"`).join(", ")}. Got: ${JSON.stringify(visualizationRaw)}. Prefer \`panel_type\`, which takes one of: ${panelTypeList}.`,
			example: '{ "panel_type": "line" }',
		}
	}

	// `panel_type` wins when both are given, but only after checking they agree —
	// silently ignoring a contradictory `visualization` would produce a widget the
	// caller did not ask for.
	if (panelTypeRaw && visualizationRaw) {
		const expected = WIDGET_TYPES[panelTypeRaw as PanelType].visualization
		if (visualizationRaw !== expected) {
			return {
				ok: false,
				error: `\`panel_type: "${panelTypeRaw}"\` and \`visualization: "${visualizationRaw}"\` disagree — panel type \`${panelTypeRaw}\` persists as \`visualization: "${expected}"\`. Pass \`panel_type\` alone.`,
				example: `{ "panel_type": "${panelTypeRaw}" }`,
			}
		}
	}

	// Without `panel_type`, a bare `visualization` still has to pick one of
	// line/bar/area for `"chart"` — `chartId` is the only signal, and its absence
	// legitimately means line.
	const meta: WidgetTypeMeta = panelTypeRaw
		? WIDGET_TYPES[panelTypeRaw as PanelType]
		: resolveFromVisualization(visualizationRaw!, input.chartId)

	return {
		ok: true,
		resolved: {
			meta,
			panelType: meta.panelType,
			visualization: meta.visualization,
			chartId: meta.chartId,
			// `list` has no raw-SQL display type on purpose. Returning `undefined`
			// rather than letting `rawSqlDisplayTypeFor` fall back to `"line"` is
			// what lets the caller reject `list` + `sql` instead of silently
			// rendering a line chart.
			rawSqlDisplayType:
				meta.visualization === "chart"
					? rawSqlDisplayTypeFor("chart", meta.chartId)
					: meta.rawSqlDisplayType,
		},
	}
}

const resolveFromVisualization = (visualization: string, chartId?: string): WidgetTypeMeta => {
	if (visualization !== "chart") {
		return widgetTypeByVisualization(visualization) ?? WIDGET_TYPES.line
	}
	const family = rawSqlDisplayTypeFor("chart", chartId)
	if (family === "bar") return WIDGET_TYPES.bar
	if (family === "area") return WIDGET_TYPES.area
	return WIDGET_TYPES.line
}

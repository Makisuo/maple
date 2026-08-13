// The panel-type table moved to `@maple/widgets`, which owns everything about
// what a dashboard widget *is* and sits below this package so `MapleApi` can
// reference it. Re-exported here so `@maple/domain/http` keeps its surface;
// prefer importing `@maple/widgets` directly in new code.
//
// `RawSqlDisplayType` is deliberately absent: it also lives in `@maple/widgets`
// but is re-exported by `./query-engine`, and exporting it from both modules
// would collide in the `http/index.ts` barrel.
export {
	chartFamilyForChartId,
	DEFAULT_LIST_LIMIT,
	defaultWidgetLayout,
	HEATMAP_COLOR_SCALES,
	HEATMAP_SCALE_TYPES,
	type HeatmapColorScale,
	type HeatmapScaleType,
	isMcpVisualization,
	isPanelType,
	isWidgetVisualization,
	MCP_VISUALIZATIONS,
	type OwnedDisplayKey,
	PANEL_TYPES,
	type PanelType,
	rawSqlDisplayTypeFor,
	WIDGET_TYPES,
	WIDGET_VISUALIZATIONS,
	type WidgetTypeMeta,
	type WidgetVisualization,
	widgetTypeByPersesKind,
	widgetTypeByVisualization,
} from "@maple/widgets"

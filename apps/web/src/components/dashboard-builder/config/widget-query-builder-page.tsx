import * as React from "react"

import { Button } from "@maple/ui/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { ChartWidget } from "@/components/dashboard-builder/widgets/chart-widget"
import { StatWidget } from "@/components/dashboard-builder/widgets/stat-widget"
import { TableWidget } from "@/components/dashboard-builder/widgets/table-widget"
import { ListWidget } from "@/components/dashboard-builder/widgets/list-widget"
import { HeatmapWidget } from "@/components/dashboard-builder/widgets/heatmap-widget"
import { QueryPanel } from "@/components/dashboard-builder/config/query-panel"
import { FormulaPanel } from "@/components/dashboard-builder/config/formula-panel"
import { WidgetSettingsBar } from "@/components/dashboard-builder/config/widget-settings-bar"
import { ListConfigPanel } from "@/components/dashboard-builder/config/list-config-panel"
import {
	RawSqlEditorPanel,
	type RawSqlDraft,
} from "@/components/dashboard-builder/config/raw-sql-editor-panel"
import type {
	DashboardWidget,
	VisualizationType,
	WidgetDataSource,
	WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { useWidgetData } from "@/hooks/use-widget-data"
import { useWidgetBuilder } from "@/hooks/use-widget-builder"
import { useWidgetBuilderData } from "@/hooks/use-widget-builder-data"
import {
	resetAggregationForMetricType,
	resetQueryForDataSource,
	type QueryBuilderDataSource,
	type QueryBuilderMetricType,
} from "@/lib/query-builder/model"
import {
	toSeriesFieldOptions,
	buildWidgetDataSource,
	buildWidgetDisplay,
	inferDefaultUnitForQueries,
} from "@/lib/query-builder/widget-builder-utils"
import { RAW_SQL_TEMPLATES, visualizationToDisplayType } from "@/lib/raw-sql/templates"

export { type QueryBuilderWidgetState } from "@/lib/query-builder/widget-builder-utils"

export interface WidgetQueryBuilderPageHandle {
	apply: () => void
	isDirty: () => boolean
}

interface WidgetQueryBuilderPageProps {
	widget: DashboardWidget
	onApply: (updates: {
		visualization: VisualizationType
		dataSource: WidgetDataSource
		display: WidgetDisplayConfig
	}) => void
}

const WidgetPreview = React.memo(function WidgetPreview({ widget }: { widget: DashboardWidget }) {
	const { dataState } = useWidgetData(widget)

	if (widget.visualization === "stat") {
		return <StatWidget dataState={dataState} display={widget.display} mode="view" onRemove={() => {}} />
	}
	if (widget.visualization === "table") {
		return <TableWidget dataState={dataState} display={widget.display} mode="view" onRemove={() => {}} />
	}
	if (widget.visualization === "list") {
		return <ListWidget dataState={dataState} display={widget.display} mode="view" onRemove={() => {}} />
	}
	if (widget.visualization === "heatmap") {
		return <HeatmapWidget dataState={dataState} display={widget.display} mode="view" onRemove={() => {}} />
	}
	return <ChartWidget dataState={dataState} display={widget.display} mode="view" onRemove={() => {}} />
})

type SourceMode = "builder" | "rawSql"

function readRawSqlDraftFromWidget(widget: DashboardWidget): RawSqlDraft {
	const params = (widget.dataSource.params ?? {}) as {
		sql?: unknown
		granularitySeconds?: unknown
	}
	if (widget.dataSource.endpoint === "raw_sql_chart" && typeof params.sql === "string") {
		return {
			sql: params.sql,
			granularitySeconds:
				typeof params.granularitySeconds === "number" ? params.granularitySeconds : null,
		}
	}
	const displayType = visualizationToDisplayType(widget.visualization, widget.display.chartId)
	return { sql: RAW_SQL_TEMPLATES[displayType], granularitySeconds: null }
}

function buildRawSqlDataSource(widget: DashboardWidget, draft: RawSqlDraft): WidgetDataSource {
	const displayType = visualizationToDisplayType(widget.visualization, widget.display.chartId)
	// Stat widgets need a reduceToValue transform so the StatWidget reads the
	// scalar `data[0].value`. If the user already set a transform on the widget,
	// keep theirs; otherwise inject the default.
	const existingTransform = widget.dataSource.transform
	const transform =
		widget.visualization === "stat" && !existingTransform?.reduceToValue
			? {
					...existingTransform,
					reduceToValue: { field: "value", aggregate: "first" as const },
				}
			: existingTransform

	return {
		endpoint: "raw_sql_chart",
		params: {
			sql: draft.sql,
			displayType,
			...(draft.granularitySeconds != null
				? { granularitySeconds: draft.granularitySeconds }
				: {}),
		},
		...(transform ? { transform } : {}),
	}
}

export function WidgetQueryBuilderPage({
	widget,
	onApply,
	ref,
}: WidgetQueryBuilderPageProps & { ref?: React.Ref<WidgetQueryBuilderPageHandle> }) {
	const {
		state,
		stagedState,
		initialSnapshot,
		actions: {
			setState,
			updateQuery,
			addQuery,
			cloneQuery,
			removeQuery,
			addFormula,
			removeFormula,
			updateFormula,
			runPreview,
		},
		meta: { validationError, seriesFieldOptions },
	} = useWidgetBuilder()

	const {
		autocompleteValues: autocompleteValuesBySource,
		activateAutocomplete,
		metricSelectionOptions,
		setMetricSearch,
	} = useWidgetBuilderData()

	const {
		state: { timeRange, resolvedTimeRange: resolvedTime },
		actions: { setTimeRange },
	} = useDashboardTimeRange()

	const initialMode: SourceMode =
		widget.dataSource.endpoint === "raw_sql_chart" ? "rawSql" : "builder"
	const [mode, setMode] = React.useState<SourceMode>(initialMode)
	const initialModeRef = React.useRef<SourceMode>(initialMode)

	const initialRawSqlDraft = React.useMemo(() => readRawSqlDraftFromWidget(widget), [widget])
	const [rawSqlDraft, setRawSqlDraft] = React.useState<RawSqlDraft>(initialRawSqlDraft)
	const initialRawSqlSnapshotRef = React.useRef<RawSqlDraft>(initialRawSqlDraft)

	// In Raw SQL mode the preview is driven by a separate "previewDraft" that
	// only updates when the user clicks Run Preview — typing in the textarea
	// shouldn't refire the SQL on every keystroke.
	const [rawSqlPreviewDraft, setRawSqlPreviewDraft] = React.useState<RawSqlDraft>(initialRawSqlDraft)

	const previewWidget = React.useMemo(() => {
		if (mode === "rawSql") {
			return {
				...widget,
				dataSource: buildRawSqlDataSource(widget, rawSqlPreviewDraft),
			}
		}
		const previewSeriesOptions = toSeriesFieldOptions(stagedState)
		// Legend / series-stats are pure presentation — apply them live from the
		// editing state so the preview updates without a Run Preview click.
		const previewState = {
			...stagedState,
			legendPosition: state.legendPosition,
			seriesStatsEnabled: state.seriesStatsEnabled,
		}
		return {
			...widget,
			visualization: stagedState.visualization,
			dataSource: buildWidgetDataSource(widget, stagedState, previewSeriesOptions),
			display: buildWidgetDisplay(widget, previewState),
		}
	}, [mode, rawSqlPreviewDraft, stagedState, state.legendPosition, state.seriesStatsEnabled, widget])

	const applyChanges = () => {
		if (mode === "rawSql") {
			if (!rawSqlDraft.sql.includes("$__orgFilter")) return
			onApply({
				visualization: widget.visualization,
				dataSource: buildRawSqlDataSource(widget, rawSqlDraft),
				display: widget.display,
			})
			return
		}
		if (validationError) return
		onApply({
			visualization: state.visualization,
			dataSource: buildWidgetDataSource(widget, state, seriesFieldOptions),
			display: buildWidgetDisplay(widget, state),
		})
	}

	React.useImperativeHandle(ref, () => ({
		apply: applyChanges,
		isDirty: () => {
			if (mode !== initialModeRef.current) return true
			if (mode === "rawSql") {
				return (
					JSON.stringify(rawSqlDraft) !== JSON.stringify(initialRawSqlSnapshotRef.current)
				)
			}
			return JSON.stringify(state) !== JSON.stringify(initialSnapshot)
		},
	}))

	const handleAggregationChange = React.useCallback(
		(queryId: string, aggregation: string) => {
			setState((current) => {
				const queries = current.queries.map((query) =>
					query.id === queryId ? { ...query, aggregation } : query,
				)
				const nextUnit = inferDefaultUnitForQueries(queries)

				return {
					...current,
					queries,
					unit: nextUnit ?? current.unit,
				}
			})
		},
		[setState],
	)

	const handleMetricSelectionChange = React.useCallback(
		(
			queryId: string,
			selection: {
				metricName: string
				metricType: QueryBuilderMetricType
				isMonotonic: boolean
			},
		) => {
			setState((current) => {
				const queries = current.queries.map((query) =>
					query.id === queryId
						? {
								...query,
								metricName: selection.metricName,
								metricType: selection.metricType,
								isMonotonic: selection.isMonotonic,
								aggregation: resetAggregationForMetricType(
									query.aggregation,
									selection.metricType,
									selection.isMonotonic,
								),
							}
						: query,
				)
				const nextUnit = inferDefaultUnitForQueries(queries)

				return {
					...current,
					queries,
					unit: nextUnit ?? current.unit,
				}
			})
		},
		[setState],
	)

	const handleDataSourceChange = React.useCallback(
		(queryId: string, dataSource: QueryBuilderDataSource) => {
			setState((current) => {
				const queries = current.queries.map((query) =>
					query.id === queryId ? resetQueryForDataSource(query, dataSource) : query,
				)
				const nextUnit = inferDefaultUnitForQueries(queries)

				return {
					...current,
					queries,
					unit: nextUnit ?? current.unit,
				}
			})
		},
		[setState],
	)

	const isList = widget.visualization === "list"
	// Lists have their own dedicated config and aren't a sensible target for raw
	// SQL (no time-series semantics, no scalar) — hide the Source toggle there.
	const showSourceToggle = !isList

	return (
		<div className="animate-in fade-in slide-in-from-bottom-2 duration-200 flex flex-1 min-h-0 -m-4">
			{/* Main content (scrollable) */}
			<div className="flex-1 min-w-0 overflow-y-auto">
				{/* Preview hero section */}
				<div className="border-b bg-muted/30 p-6">
					<div className="flex justify-end mb-3">
						<TimeRangePicker
							startTime={resolvedTime?.startTime}
							endTime={resolvedTime?.endTime}
							presetValue={timeRange.type === "relative" ? timeRange.value : undefined}
							onChange={(range) => {
								if (range.startTime && range.endTime) {
									if (range.presetValue) {
										setTimeRange({ type: "relative", value: range.presetValue })
									} else {
										setTimeRange({
											type: "absolute",
											startTime: range.startTime,
											endTime: range.endTime,
										})
									}
								}
							}}
						/>
					</div>
					{/* Key on mode forces a full unmount/remount of the preview tree on
					    Source toggle. Without this, SVG-rendered charts (notably the pie
					    donut) hold internal state between data swaps and ghost-render
					    the previous slices on top of the new ones. */}
					<div className="h-[400px]">
						<WidgetPreview key={mode} widget={previewWidget} />
					</div>
				</div>

				{/* Query configuration */}
				<div className="p-6 space-y-6" onFocusCapture={activateAutocomplete}>
					{showSourceToggle && (
						<div className="flex items-center gap-3">
							<span className="text-[10px] uppercase tracking-wider text-muted-foreground">
								Source
							</span>
							<Tabs
								value={mode}
								onValueChange={(value) => setMode(value as SourceMode)}
							>
								<TabsList>
									<TabsTrigger value="builder">Query Builder</TabsTrigger>
									<TabsTrigger value="rawSql">Raw SQL</TabsTrigger>
								</TabsList>
							</Tabs>
						</div>
					)}

					{mode === "rawSql" ? (
						<RawSqlEditorPanel
							widget={widget}
							draft={rawSqlDraft}
							onDraftChange={setRawSqlDraft}
							onRunPreview={() => setRawSqlPreviewDraft(rawSqlDraft)}
						/>
					) : (
						<>
							{validationError && (
								<p className="text-xs text-destructive font-medium">{validationError}</p>
							)}

							{state.visualization === "list" ? (
								<>
									<ListConfigPanel />
									<div className="flex items-center gap-3">
										<Button size="sm" onClick={runPreview}>
											Run Preview
										</Button>
									</div>
								</>
							) : (
								<>
									{/* Query panels */}
									<div className="space-y-3">
										{state.queries.map((query, index) => (
											<QueryPanel
												key={query.id}
												query={query}
												index={index}
												canRemove={state.queries.length > 1}
												metricSelectionOptions={metricSelectionOptions}
												onMetricSearch={setMetricSearch}
												autocompleteValues={autocompleteValuesBySource}
												onUpdate={(updater) => updateQuery(query.id, updater)}
												onAggregationChange={(aggregation) =>
													handleAggregationChange(query.id, aggregation)
												}
												onMetricSelectionChange={(selection) =>
													handleMetricSelectionChange(query.id, selection)
												}
												onClone={() => cloneQuery(query.id)}
												onRemove={() => removeQuery(query.id)}
												onDataSourceChange={(ds) =>
													handleDataSourceChange(query.id, ds)
												}
											/>
										))}
									</div>

									{/* Formula panels */}
									{state.formulas.length > 0 && (
										<div className="space-y-3">
											{state.formulas.map((formula) => (
												<FormulaPanel
													key={formula.id}
													formula={formula}
													onUpdate={(updater) => updateFormula(formula.id, updater)}
													onRemove={() => removeFormula(formula.id)}
												/>
											))}
										</div>
									)}

									{/* Toolbar */}
									<div className="flex items-center gap-3">
										<Button variant="outline" size="sm" onClick={addQuery}>
											+ Query
										</Button>
										<Button variant="outline" size="sm" onClick={addFormula}>
											+ Formula
										</Button>
										<Button
											size="sm"
											onClick={runPreview}
											disabled={!!validationError}
										>
											Run Preview
										</Button>
										<span className="text-[11px] text-muted-foreground ml-auto">
											{state.queries.map((q) => q.name).join(", ")}
											{state.formulas.length > 0 &&
												`, ${state.formulas.map((f) => f.name).join(", ")}`}
										</span>
									</div>
								</>
							)}
						</>
					)}
				</div>
			</div>

			{/* Right sidebar */}
			<aside className="w-[272px] shrink-0 border-l overflow-y-auto p-5 bg-muted/20">
				<WidgetSettingsBar />
			</aside>
		</div>
	)
}

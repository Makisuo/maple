import * as React from "react"
import { widgetTypeByVisualization } from "@maple/domain/http"
import { dataSourceRawSql } from "@maple/widgets/dashboard"

import { Button } from "@maple/ui/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { visualizationFor } from "@/components/dashboard-builder/widgets/types"
import { QueryPanel } from "@/components/dashboard-builder/config/query-panel"
import { MarkdownEditorPanel } from "@/components/dashboard-builder/config/markdown-editor-panel"
import { FormulaPanel } from "@/components/dashboard-builder/config/formula-panel"
import { WidgetSettingsBar } from "@/components/dashboard-builder/config/widget-settings-bar"
import { ListConfigPanel } from "@/components/dashboard-builder/config/list-config-panel"
import {
	RawSqlEditorPanel,
	type RawSqlDraft,
} from "@/components/dashboard-builder/config/raw-sql-editor-panel"
import type {
	DashboardWidget,
	TimeRange,
	VisualizationType,
	WidgetDataSource,
	WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"
import { WidgetTimeRangeProvider } from "@/components/dashboard-builder/widgets/widget-time-range-context"
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
} from "@maple/query-engine/query-builder"
import {
	toSeriesFieldOptions,
	buildWidgetDataSource,
	buildWidgetDisplay,
	inferDefaultUnitForQueries,
} from "@/lib/query-builder/widget-builder-utils"
import { RAW_SQL_TEMPLATES, visualizationToDisplayType } from "@/lib/raw-sql/templates"

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
		/** `undefined` clears any override: the widget follows the dashboard again. */
		timeRange: TimeRange | undefined
	}) => void
}

// Resolve the renderer through the same registry the canvas uses. Hand-rolling
// the branches here meant pie, funnel, histogram, gauge and markdown previewed
// as charts in the editor while rendering correctly once saved.
const WidgetPreview = React.memo(function WidgetPreview({ widget }: { widget: DashboardWidget }) {
	const { dataState } = useWidgetData(widget)
	const Visualization = visualizationFor(widget.visualization)

	// Same provider the canvas wraps a tile in, so the preview's secondary
	// fetches and its "own time range" header badge behave as they will once
	// saved.
	return (
		<WidgetTimeRangeProvider timeRange={widget.timeRange}>
			<Visualization dataState={dataState} display={widget.display} mode="view" />
		</WidgetTimeRangeProvider>
	)
})

type SourceMode = "builder" | "rawSql"

function readRawSqlDraftFromWidget(widget: DashboardWidget): RawSqlDraft {
	const rawSql = dataSourceRawSql(widget.dataSource)
	if (rawSql !== null && rawSql.sql.length > 0) {
		return { sql: rawSql.sql, granularitySeconds: rawSql.granularitySeconds ?? null }
	}
	const displayType = visualizationToDisplayType(widget.visualization, widget.display.chartId)
	return { sql: RAW_SQL_TEMPLATES[displayType], granularitySeconds: null }
}

/**
 * Build the `raw_sql_chart` data source for the type currently selected in the
 * editor — NOT the saved widget's type. Reading `widget.*` here meant the Type
 * picker had no effect in Raw SQL mode: a pie you selected still requested
 * `displayType: "line"`.
 */
function buildRawSqlDataSource(
	widget: DashboardWidget,
	draft: RawSqlDraft,
	visualization: VisualizationType,
	chartId: string,
): WidgetDataSource {
	const displayType = visualizationToDisplayType(visualization, chartId)
	// Stat and gauge both render a scalar, so they need a reduceToValue transform
	// for the widget to read `data[0].value`. If the user already set a transform
	// on the widget, keep theirs; otherwise inject the default.
	const existingTransform = widget.dataSource.transform
	const needsScalar = widgetTypeByVisualization(visualization)?.isScalar === true
	const transform =
		needsScalar && !existingTransform?.reduceToValue
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
			...(draft.granularitySeconds != null ? { granularitySeconds: draft.granularitySeconds } : {}),
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

	const initialMode: SourceMode = dataSourceRawSql(widget.dataSource) !== null ? "rawSql" : "builder"
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
		// The override applies live from the editing state — it costs nothing to
		// re-resolve and a pinned window you can't see until you save is a trap.
		const timeRange = state.timeRange ?? undefined
		if (mode === "rawSql") {
			return {
				...widget,
				timeRange,
				visualization: state.visualization,
				dataSource: buildRawSqlDataSource(
					widget,
					rawSqlPreviewDraft,
					state.visualization,
					state.chartId,
				),
				display: buildWidgetDisplay(widget, state),
			}
		}
		const previewSeriesOptions = toSeriesFieldOptions(stagedState)
		// Presentation-only edits apply live from the editing state so the preview
		// updates without a Run Preview click. The panel type belongs here too: a
		// type picker whose preview waits for Run Preview reads as broken, and note
		// content never costs a query at all.
		const previewState = {
			...stagedState,
			visualization: state.visualization,
			chartId: state.chartId,
			markdownContent: state.markdownContent,
			legendPosition: state.legendPosition,
			seriesStatsEnabled: state.seriesStatsEnabled,
		}
		return {
			...widget,
			timeRange,
			visualization: state.visualization,
			dataSource: buildWidgetDataSource(widget, previewState, previewSeriesOptions),
			display: buildWidgetDisplay(widget, previewState),
		}
	}, [mode, rawSqlPreviewDraft, stagedState, state, widget])

	// Raw SQL must reference $__orgFilter — every query is tenant-scoped through
	// that macro. Surfaced as a normal validation message; it used to make Apply a
	// silent no-op with no explanation.
	const rawSqlError =
		mode === "rawSql" && !rawSqlDraft.sql.includes("$__orgFilter")
			? "SQL must include $__orgFilter so the query is scoped to your organization"
			: null

	const applyChanges = () => {
		if (mode === "rawSql") {
			if (rawSqlError) return
			onApply({
				visualization: state.visualization,
				dataSource: buildRawSqlDataSource(widget, rawSqlDraft, state.visualization, state.chartId),
				display: buildWidgetDisplay(widget, state),
				timeRange: state.timeRange ?? undefined,
			})
			return
		}
		if (validationError) return
		onApply({
			visualization: state.visualization,
			dataSource: buildWidgetDataSource(widget, state, seriesFieldOptions),
			display: buildWidgetDisplay(widget, state),
			timeRange: state.timeRange ?? undefined,
		})
	}

	React.useImperativeHandle(ref, () => ({
		apply: applyChanges,
		isDirty: () => {
			if (mode !== initialModeRef.current) return true
			// Both branches diff `state`: in Raw SQL mode the Type picker and the
			// panel options now persist, so comparing only the SQL draft would let
			// the unsaved-changes blocker wave those edits through silently.
			if (JSON.stringify(state) !== JSON.stringify(initialSnapshot)) return true
			if (mode === "rawSql") {
				return JSON.stringify(rawSqlDraft) !== JSON.stringify(initialRawSqlSnapshotRef.current)
			}
			return false
		},
	}))

	// Reseed the SQL when the panel type changes, but only while the draft is still
	// a pristine template — never clobber SQL the user has written. line/bar/area
	// share one template, so switching among them is a no-op.
	const lastDisplayTypeRef = React.useRef(visualizationToDisplayType(state.visualization, state.chartId))
	const currentDisplayType = visualizationToDisplayType(state.visualization, state.chartId)
	if (currentDisplayType !== lastDisplayTypeRef.current) {
		const previous = lastDisplayTypeRef.current
		lastDisplayTypeRef.current = currentDisplayType
		if (rawSqlDraft.sql.trim() === RAW_SQL_TEMPLATES[previous].trim()) {
			const reseeded = { ...rawSqlDraft, sql: RAW_SQL_TEMPLATES[currentDisplayType] }
			setRawSqlDraft(reseeded)
			setRawSqlPreviewDraft(reseeded)
		}
	}

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

	// Gate on the EDITING state, not the saved widget — otherwise switching type
	// in-editor leaves the toggle in the state the previous type wanted.
	//
	// Lists have their own dedicated config and notes don't query at all; neither
	// has a RawSqlDisplayType, so raw SQL isn't a sensible target for either.
	const isList = state.visualization === "list"
	const isMarkdown = state.visualization === "markdown"
	const showSourceToggle = !isList && !isMarkdown

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
					{/* Matches a default chart tile on the canvas (h:6 → 6*60 + 5*12). */}
					<div className="h-[420px]">
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
							<Tabs value={mode} onValueChange={(value) => setMode(value as SourceMode)}>
								<TabsList>
									<TabsTrigger value="builder">Query Builder</TabsTrigger>
									<TabsTrigger value="rawSql">Raw SQL</TabsTrigger>
								</TabsList>
							</Tabs>
						</div>
					)}

					{mode === "rawSql" && showSourceToggle ? (
						<>
							{rawSqlError && (
								<p className="text-xs text-destructive font-medium">{rawSqlError}</p>
							)}
							<RawSqlEditorPanel
								widget={widget}
								draft={rawSqlDraft}
								onDraftChange={setRawSqlDraft}
								onRunPreview={() => setRawSqlPreviewDraft(rawSqlDraft)}
							/>
						</>
					) : (
						<>
							{validationError && (
								<p className="text-xs text-destructive font-medium">{validationError}</p>
							)}

							{isMarkdown ? (
								<MarkdownEditorPanel
									content={state.markdownContent}
									onChange={(markdownContent) =>
										setState((current) => ({ ...current, markdownContent }))
									}
								/>
							) : isList ? (
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
										<Button size="sm" onClick={runPreview} disabled={!!validationError}>
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
				<WidgetSettingsBar sourceMode={mode} />
			</aside>
		</div>
	)
}

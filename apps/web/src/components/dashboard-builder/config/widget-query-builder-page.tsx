import * as React from "react"

import { Button } from "@maple/ui/components/ui/button"
import { ChartWidget } from "@/components/dashboard-builder/widgets/chart-widget"
import { StatWidget } from "@/components/dashboard-builder/widgets/stat-widget"
import { TableWidget } from "@/components/dashboard-builder/widgets/table-widget"
import { ListWidget } from "@/components/dashboard-builder/widgets/list-widget"
import { HeatmapWidget } from "@/components/dashboard-builder/widgets/heatmap-widget"
import { QueryPanel } from "@/components/dashboard-builder/config/query-panel"
import { FormulaPanel } from "@/components/dashboard-builder/config/formula-panel"
import { WidgetSettingsBar } from "@/components/dashboard-builder/config/widget-settings-bar"
import { ListConfigPanel } from "@/components/dashboard-builder/config/list-config-panel"
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

	const previewWidget = React.useMemo(() => {
		const previewSeriesOptions = toSeriesFieldOptions(stagedState)
		return {
			...widget,
			visualization: stagedState.visualization,
			dataSource: buildWidgetDataSource(widget, stagedState, previewSeriesOptions),
			display: buildWidgetDisplay(widget, stagedState),
		}
	}, [stagedState, widget])

	const applyChanges = () => {
		if (validationError) return
		onApply({
			visualization: state.visualization,
			dataSource: buildWidgetDataSource(widget, state, seriesFieldOptions),
			display: buildWidgetDisplay(widget, state),
		})
	}

	React.useImperativeHandle(ref, () => ({
		apply: applyChanges,
		isDirty: () => JSON.stringify(state) !== JSON.stringify(initialSnapshot),
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
					<div className="h-[400px]">
						<WidgetPreview widget={previewWidget} />
					</div>
				</div>

				{/* Query configuration */}
				<div className="p-6 space-y-6" onFocusCapture={activateAutocomplete}>
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
										onDataSourceChange={(ds) => handleDataSourceChange(query.id, ds)}
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
				</div>
			</div>

			{/* Right sidebar */}
			<aside className="w-[272px] shrink-0 border-l overflow-y-auto p-5 bg-muted/20">
				<WidgetSettingsBar />
			</aside>
		</div>
	)
}

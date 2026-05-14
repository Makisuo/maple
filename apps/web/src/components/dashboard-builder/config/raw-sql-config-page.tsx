import * as React from "react"

import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { ChartWidget } from "@/components/dashboard-builder/widgets/chart-widget"
import { TableWidget } from "@/components/dashboard-builder/widgets/table-widget"
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { useWidgetData } from "@/hooks/use-widget-data"
import type {
	DashboardWidget,
	VisualizationType,
	WidgetDataSource,
	WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"

import type { WidgetQueryBuilderPageHandle } from "@/components/dashboard-builder/config/widget-query-builder-page"

const MACRO_HINTS: Array<{ token: string; description: string }> = [
	{ token: "$__orgFilter", description: "Required — expands to OrgId = '<your org>'" },
	{ token: "$__timeFilter(Column)", description: "Column >= <start> AND Column <= <end>" },
	{ token: "$__startTime", description: "Range start as toDateTime('…')" },
	{ token: "$__endTime", description: "Range end as toDateTime('…')" },
	{ token: "$__interval_s", description: "Auto-computed bucket size in seconds" },
]

type DisplayType = "line" | "table"

interface RawSqlPreviewProps {
	widget: DashboardWidget
}

const RawSqlPreview = React.memo(function RawSqlPreview({ widget }: RawSqlPreviewProps) {
	const { dataState } = useWidgetData(widget)
	if (widget.visualization === "table") {
		return <TableWidget dataState={dataState} display={widget.display} mode="view" onRemove={() => {}} />
	}
	return <ChartWidget dataState={dataState} display={widget.display} mode="view" onRemove={() => {}} />
})

interface RawSqlConfigPageProps {
	widget: DashboardWidget
	onApply: (updates: {
		visualization: VisualizationType
		dataSource: WidgetDataSource
		display: WidgetDisplayConfig
	}) => void
	ref?: React.Ref<WidgetQueryBuilderPageHandle>
}

interface RawSqlState {
	title: string
	sql: string
	displayType: DisplayType
	granularitySeconds: number | null
}

function widgetToState(widget: DashboardWidget): RawSqlState {
	const params = (widget.dataSource.params ?? {}) as {
		sql?: string
		displayType?: DisplayType
		granularitySeconds?: number
	}
	return {
		title: widget.display.title ?? "Raw SQL",
		sql: params.sql ?? "",
		displayType: params.displayType === "table" ? "table" : "line",
		granularitySeconds:
			typeof params.granularitySeconds === "number" ? params.granularitySeconds : null,
	}
}

function stateToUpdates(
	widget: DashboardWidget,
	state: RawSqlState,
): {
	visualization: VisualizationType
	dataSource: WidgetDataSource
	display: WidgetDisplayConfig
} {
	const visualization: VisualizationType = state.displayType === "table" ? "table" : "chart"
	return {
		visualization,
		dataSource: {
			endpoint: "raw_sql_chart",
			params: {
				sql: state.sql,
				displayType: state.displayType,
				...(state.granularitySeconds != null ? { granularitySeconds: state.granularitySeconds } : {}),
			},
		},
		display: {
			...widget.display,
			title: state.title,
			chartId: state.displayType === "line" ? (widget.display.chartId ?? "query-builder-line") : widget.display.chartId,
		},
	}
}

export function RawSqlConfigPage({ widget, onApply, ref }: RawSqlConfigPageProps) {
	const initial = React.useMemo(() => widgetToState(widget), [widget])
	const [state, setState] = React.useState<RawSqlState>(initial)
	const [previewState, setPreviewState] = React.useState<RawSqlState>(initial)
	const initialSnapshotRef = React.useRef(initial)

	const {
		state: { timeRange, resolvedTimeRange: resolvedTime },
		actions: { setTimeRange },
	} = useDashboardTimeRange()

	const missingOrgFilter = !state.sql.includes("$__orgFilter")

	const previewWidget = React.useMemo<DashboardWidget>(() => {
		const updates = stateToUpdates(widget, previewState)
		return {
			...widget,
			visualization: updates.visualization,
			dataSource: updates.dataSource,
			display: updates.display,
		}
	}, [previewState, widget])

	const apply = React.useCallback(() => {
		if (missingOrgFilter) return
		onApply(stateToUpdates(widget, state))
	}, [missingOrgFilter, onApply, state, widget])

	React.useImperativeHandle(ref, () => ({
		apply,
		isDirty: () => JSON.stringify(state) !== JSON.stringify(initialSnapshotRef.current),
	}))

	return (
		<div className="animate-in fade-in slide-in-from-bottom-2 duration-200 flex flex-1 min-h-0 -m-4">
			<div className="flex-1 min-w-0 overflow-y-auto">
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
						<RawSqlPreview widget={previewWidget} />
					</div>
				</div>

				<div className="p-6 space-y-4 max-w-3xl">
					<div className="flex flex-col gap-1.5">
						<label className="text-[10px] font-medium text-muted-foreground">Title</label>
						<Input
							value={state.title}
							onChange={(e) => setState({ ...state, title: e.target.value })}
							className="h-8 text-xs"
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<label className="text-[10px] font-medium text-muted-foreground">ClickHouse SQL</label>
						<textarea
							value={state.sql}
							onChange={(e) => setState({ ...state, sql: e.target.value })}
							spellCheck={false}
							className="text-xs font-mono bg-background border border-border rounded px-2 py-1.5 min-h-[260px] resize-y outline-none focus:ring-1 focus:ring-foreground/20"
						/>
						{missingOrgFilter && (
							<div className="text-[11px] text-destructive">
								Reference $__orgFilter in your WHERE clause — required for org isolation.
							</div>
						)}
						<div className="flex flex-col gap-1 text-[11px] text-muted-foreground bg-muted/40 rounded px-2 py-1.5">
							<div className="font-semibold uppercase tracking-wider text-[9px] text-dim">
								Available macros
							</div>
							{MACRO_HINTS.map((hint) => (
								<div key={hint.token} className="flex gap-2">
									<code className="font-mono text-foreground">{hint.token}</code>
									<span className="truncate">{hint.description}</span>
								</div>
							))}
						</div>
					</div>

					<div className="grid grid-cols-2 gap-3">
						<div className="flex flex-col gap-1.5">
							<label className="text-[10px] font-medium text-muted-foreground">
								Display type
							</label>
							<select
								value={state.displayType}
								onChange={(e) =>
									setState({ ...state, displayType: e.target.value as DisplayType })
								}
								className="h-8 text-xs bg-background border border-border rounded px-2"
							>
								<option value="line">Line / area</option>
								<option value="table">Table</option>
							</select>
						</div>

						<div className="flex flex-col gap-1.5">
							<label className="text-[10px] font-medium text-muted-foreground">
								Bucket seconds (optional)
							</label>
							<Input
								type="number"
								min={1}
								placeholder="auto"
								value={state.granularitySeconds ?? ""}
								onChange={(e) =>
									setState({
										...state,
										granularitySeconds:
											e.target.value === ""
												? null
												: Math.max(1, Number(e.target.value)),
									})
								}
								className="h-8 text-xs"
							/>
						</div>
					</div>

					<div className="flex items-center gap-3">
						<Button size="sm" onClick={() => setPreviewState(state)}>
							Run Preview
						</Button>
						<span className="text-[11px] text-muted-foreground">
							Preview applies your SQL above without saving. Hit Apply (top-right) to save.
						</span>
					</div>
				</div>
			</div>
		</div>
	)
}

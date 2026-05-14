import { Input } from "@maple/ui/components/ui/input"
import { getChartById, getChartsByCategory } from "@maple/ui/components/charts/registry"
import { ChartPreview } from "@/components/dashboard-builder/widgets/chart-preview"
import type {
	DashboardWidget,
	WidgetDataSource,
	WidgetDisplayConfig,
	DataSourceEndpoint,
} from "@/components/dashboard-builder/types"

const ENDPOINT_OPTIONS: Array<{ value: DataSourceEndpoint; label: string }> = [
	{ value: "service_usage", label: "Service Usage" },
	{ value: "service_overview", label: "Service Overview" },
	{ value: "service_overview_time_series", label: "Service Time Series" },
	{ value: "errors_summary", label: "Errors Summary" },
	{ value: "errors_by_type", label: "Errors by Type" },
	{ value: "error_rate_by_service", label: "Error Rate by Service" },
	{ value: "list_traces", label: "Traces" },
	{ value: "list_logs", label: "Logs" },
	{ value: "list_metrics", label: "Metrics" },
	{ value: "metrics_summary", label: "Metrics Summary" },
	{ value: "custom_timeseries", label: "Custom Time Series" },
	{ value: "custom_breakdown", label: "Custom Breakdown" },
	{ value: "custom_query_builder_timeseries", label: "Query Builder (Multi Query)" },
	{ value: "raw_sql_chart", label: "Raw SQL" },
]

interface WidgetEditPanelProps {
	widget: DashboardWidget
	onUpdateDisplay: (updates: Partial<WidgetDisplayConfig>) => void
	onUpdateDataSource?: (dataSource: WidgetDataSource) => void
}

export function WidgetEditPanel({ widget, onUpdateDisplay, onUpdateDataSource }: WidgetEditPanelProps) {
	const isRawSql = widget.dataSource.endpoint === "raw_sql_chart"
	const isChart = widget.visualization === "chart"
	const isMarkdown = widget.visualization === "markdown"
	const isPie = widget.visualization === "pie"
	const isHistogram = widget.visualization === "histogram"
	const isHeatmap = widget.visualization === "heatmap"
	const chartId = widget.display.chartId
	const currentChart = isChart && chartId ? getChartById(chartId) : null
	const variants = currentChart
		? getChartsByCategory(currentChart.category).filter((c) => c.tags.includes("query-builder"))
		: []

	const placeholder = currentChart?.name ?? widget.display.title ?? "Widget"

	return (
		<>
			<div className="flex flex-col gap-1.5">
				<label className="text-[10px] font-medium text-muted-foreground">Title</label>
				<Input
					placeholder={placeholder}
					value={widget.display.title || ""}
					onChange={(e) => onUpdateDisplay({ title: e.target.value })}
					className="h-7 text-xs"
				/>
			</div>

			{!isMarkdown && (
				<div className="flex flex-col gap-1.5">
					<label className="text-[10px] font-medium text-muted-foreground">Data Source</label>
					<div className="text-[10px] text-muted-foreground bg-muted px-2 py-1.5 rounded">
						{ENDPOINT_OPTIONS.find((o) => o.value === widget.dataSource.endpoint)?.label ??
							widget.dataSource.endpoint}
					</div>
				</div>
			)}

			{isRawSql && onUpdateDataSource && (
				<RawSqlEditor widget={widget} onUpdateDataSource={onUpdateDataSource} />
			)}

			{isMarkdown && (
				<div className="flex flex-col gap-1.5">
					<label className="text-[10px] font-medium text-muted-foreground">
						Content (Markdown)
					</label>
					<textarea
						value={widget.display.markdown?.content ?? ""}
						onChange={(e) =>
							onUpdateDisplay({
								markdown: { content: e.target.value },
							})
						}
						placeholder="# Heading\n\nText with **bold**, *italic*, [links](https://example.com), and `code`."
						className="text-xs font-mono bg-background border border-border rounded px-2 py-1.5 min-h-[160px] resize-y outline-none focus:ring-1 focus:ring-foreground/20"
					/>
				</div>
			)}

			{isPie && (
				<div className="flex flex-col gap-1.5">
					<label className="text-[10px] font-medium text-muted-foreground">Pie style</label>
					<label className="flex items-center gap-2 text-[10px]">
						<input
							type="checkbox"
							checked={widget.display.pie?.donut ?? false}
							onChange={(e) =>
								onUpdateDisplay({
									pie: { ...widget.display.pie, donut: e.target.checked },
								})
							}
						/>
						Donut mode
					</label>
					<label className="flex items-center gap-2 text-[10px]">
						<input
							type="checkbox"
							checked={widget.display.pie?.showLabels ?? false}
							onChange={(e) =>
								onUpdateDisplay({
									pie: { ...widget.display.pie, showLabels: e.target.checked },
								})
							}
						/>
						Show slice labels
					</label>
					<label className="flex items-center gap-2 text-[10px]">
						<input
							type="checkbox"
							checked={widget.display.pie?.showPercent ?? true}
							onChange={(e) =>
								onUpdateDisplay({
									pie: { ...widget.display.pie, showPercent: e.target.checked },
								})
							}
						/>
						Show percentages
					</label>
				</div>
			)}

			{isHistogram && (
				<div className="flex flex-col gap-1.5">
					<label className="text-[10px] font-medium text-muted-foreground">Buckets</label>
					<Input
						type="number"
						min={2}
						max={200}
						value={widget.display.histogram?.bucketCount ?? 30}
						onChange={(e) =>
							onUpdateDisplay({
								histogram: {
									...widget.display.histogram,
									bucketCount: Number(e.target.value) || 30,
								},
							})
						}
						className="h-7 text-xs"
					/>
					<label className="flex items-center gap-2 text-[10px]">
						<input
							type="checkbox"
							checked={widget.display.histogram?.logScaleY ?? false}
							onChange={(e) =>
								onUpdateDisplay({
									histogram: {
										...widget.display.histogram,
										logScaleY: e.target.checked,
									},
								})
							}
						/>
						Log-scale Y axis
					</label>
				</div>
			)}

			{isHeatmap && (
				<div className="flex flex-col gap-1.5">
					<label className="text-[10px] font-medium text-muted-foreground">Color scale</label>
					<select
						value={widget.display.heatmap?.colorScale ?? "blues"}
						onChange={(e) =>
							onUpdateDisplay({
								heatmap: {
									...widget.display.heatmap,
									colorScale: e.target.value as
										| "viridis"
										| "magma"
										| "cividis"
										| "blues"
										| "reds",
								},
							})
						}
						className="h-7 text-xs bg-background border border-border rounded px-2"
					>
						<option value="blues">Blues</option>
						<option value="reds">Reds</option>
						<option value="viridis">Viridis</option>
						<option value="magma">Magma</option>
						<option value="cividis">Cividis</option>
					</select>
					<label className="flex items-center gap-2 text-[10px]">
						<input
							type="checkbox"
							checked={(widget.display.heatmap?.scaleType ?? "linear") === "log"}
							onChange={(e) =>
								onUpdateDisplay({
									heatmap: {
										...widget.display.heatmap,
										scaleType: e.target.checked ? "log" : "linear",
									},
								})
							}
						/>
						Log-scale color binning
					</label>
				</div>
			)}

			{isChart && (
				<div className="flex flex-col gap-1.5">
					<label className="text-[10px] font-medium text-muted-foreground">Y axis</label>
					<label className="flex items-center gap-2 text-[10px]">
						<input
							type="checkbox"
							checked={widget.display.yAxis?.logScale ?? false}
							onChange={(e) =>
								onUpdateDisplay({
									yAxis: { ...widget.display.yAxis, logScale: e.target.checked },
								})
							}
						/>
						Log scale
					</label>
					<div className="grid grid-cols-2 gap-1.5">
						<Input
							type="number"
							placeholder="Soft min"
							value={widget.display.yAxis?.softMin ?? ""}
							onChange={(e) =>
								onUpdateDisplay({
									yAxis: {
										...widget.display.yAxis,
										softMin: e.target.value === "" ? undefined : Number(e.target.value),
									},
								})
							}
							className="h-7 text-xs"
						/>
						<Input
							type="number"
							placeholder="Soft max"
							value={widget.display.yAxis?.softMax ?? ""}
							onChange={(e) =>
								onUpdateDisplay({
									yAxis: {
										...widget.display.yAxis,
										softMax: e.target.value === "" ? undefined : Number(e.target.value),
									},
								})
							}
							className="h-7 text-xs"
						/>
					</div>
					<label className="flex items-center gap-2 text-[10px]">
						<input
							type="checkbox"
							checked={widget.display.chartPresentation?.showPoints ?? false}
							onChange={(e) =>
								onUpdateDisplay({
									chartPresentation: {
										...widget.display.chartPresentation,
										showPoints: e.target.checked,
									},
								})
							}
						/>
						Show points (line charts)
					</label>
				</div>
			)}

			{isChart && variants.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<label className="text-[10px] font-medium text-muted-foreground">Variant</label>
					<div className="grid grid-cols-3 gap-1.5">
						{variants.map((variant) => {
							const isActive = variant.id === chartId

							return (
								<button
									key={variant.id}
									type="button"
									onClick={() => onUpdateDisplay({ chartId: variant.id })}
									className={`ring-1 p-1.5 transition-all ${
										isActive
											? "ring-foreground ring-2"
											: "ring-border hover:ring-foreground/30"
									}`}
								>
									<ChartPreview component={variant.component} />
									<div className="text-[9px] text-muted-foreground truncate mt-1">
										{variant.name}
									</div>
								</button>
							)
						})}
					</div>
				</div>
			)}
		</>
	)
}

const MACRO_HINTS: Array<{ token: string; description: string }> = [
	{ token: "$__orgFilter", description: "Required — expands to OrgId = '<your org>'" },
	{
		token: "$__timeFilter(Column)",
		description: "Expands to Column >= <start> AND Column <= <end>",
	},
	{ token: "$__startTime", description: "Dashboard time range start (toDateTime)" },
	{ token: "$__endTime", description: "Dashboard time range end (toDateTime)" },
	{ token: "$__interval_s", description: "Auto-bucket size in seconds" },
]

function RawSqlEditor({
	widget,
	onUpdateDataSource,
}: {
	widget: DashboardWidget
	onUpdateDataSource: (dataSource: WidgetDataSource) => void
}) {
	const params = (widget.dataSource.params ?? {}) as {
		sql?: string
		granularitySeconds?: number
	}
	const sql = params.sql ?? ""
	const granularitySeconds = params.granularitySeconds

	const missingOrgFilter = !sql.includes("$__orgFilter")

	const update = (next: Partial<typeof params>) => {
		onUpdateDataSource({
			...widget.dataSource,
			params: {
				...(widget.dataSource.params ?? {}),
				...next,
			},
		})
	}

	return (
		<div className="flex flex-col gap-1.5">
			<label className="text-[10px] font-medium text-muted-foreground">ClickHouse SQL</label>
			<textarea
				value={sql}
				onChange={(e) => update({ sql: e.target.value })}
				spellCheck={false}
				className="text-[11px] font-mono bg-background border border-border rounded px-2 py-1.5 min-h-[180px] resize-y outline-none focus:ring-1 focus:ring-foreground/20"
			/>
			{missingOrgFilter && (
				<div className="text-[10px] text-destructive">
					Reference $__orgFilter in your WHERE clause — required for org isolation.
				</div>
			)}
			<div className="flex flex-col gap-1 text-[10px] text-muted-foreground bg-muted/40 rounded px-2 py-1.5">
				<div className="font-semibold uppercase tracking-wider text-[9px] text-dim">Macros</div>
				{MACRO_HINTS.map((hint) => (
					<div key={hint.token} className="flex gap-2">
						<code className="font-mono text-foreground">{hint.token}</code>
						<span className="truncate">{hint.description}</span>
					</div>
				))}
			</div>

			<div className="flex flex-col gap-1.5">
				<label className="text-[10px] font-medium text-muted-foreground">
					Bucket seconds (optional)
				</label>
				<Input
					type="number"
					min={1}
					placeholder="auto"
					value={granularitySeconds ?? ""}
					onChange={(e) =>
						update({
							granularitySeconds:
								e.target.value === "" ? undefined : Math.max(1, Number(e.target.value)),
						})
					}
					className="h-7 text-xs"
				/>
			</div>
		</div>
	)
}
